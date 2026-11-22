#!/usr/bin/env node
/**
 * scripts/demo.mjs — one self-driving, real-money run of Foreman on Chipnet.
 *
 * It produces web/data.json: every step, every txid, every refusal, so the
 * front end can replay a genuine run with clickable explorer links.
 *
 *   node scripts/demo.mjs            # full run (fresh keys, faucet, 2 pods)
 *   node scripts/demo.mjs --replay   # just re-read chain state, no new txs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  keyFromSeedHex, randomSeedHex, addressOf, podAddress, podContract, readPod,
  fundPod, deliverChunks, simulateSteal, refundPod, closePod, chunkReceipt,
  jobHash, explainVmError, NETWORKS, FEES,
} from '../lib.mjs';
import { TransactionBuilder } from 'cashscript';

const NETWORK = 'chipnet';
const OUT = new URL('../web/data.json', import.meta.url);
const SECRETS = new URL('../.secrets/demo.json', import.meta.url);
const replay = process.argv.includes('--replay');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (p, body) => {
  const r = await fetch(`https://chipnet.bch.ninja/api/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

async function faucet(address, sats) {
  const ch = await post('challenge', { address, sats });
  if (ch.status !== 200) throw new Error(JSON.stringify(ch.json));
  const target = BigInt(`0x${ch.json.target}`);
  let nonce = 0n;
  const t0 = Date.now();
  for (;;) {
    const d = crypto.createHash('sha256').update(`${ch.json.payload}:${nonce}`).digest('hex');
    if (BigInt(`0x${d}`) <= target) break;
    nonce += 1n;
    if (Date.now() - t0 > 120000) throw new Error('faucet PoW timeout');
  }
  const claim = await post('claim', { payload: ch.json.payload, signature: ch.json.signature, nonce: nonce.toString() });
  if (claim.status !== 200) throw new Error(JSON.stringify(claim.json));
  return claim.json;
}

async function waitFor(address, want, label) {
  for (let i = 0; i < 40; i++) {
    const { provider, contract } = podContract(
      { clientPkh: new Uint8Array(20), providerPkh: new Uint8Array(20), chunk: 1n, window: 1n, validUntil: 1n },
      NETWORK,
    );
    const utxos = await provider.getUtxos(address);
    const bal = utxos.reduce((a, u) => a + u.satoshis, 0n);
    if (bal >= BigInt(want)) return bal;
    process.stdout.write(`\r  waiting for ${label}: ${bal}/${want} sat…    `);
    await sleep(4000);
  }
  throw new Error(`${label} did not confirm in 160s`);
}

/** Build a refund without broadcasting, to show the covenant refusing early reclaims. */
async function attemptEarlyRefund({ pod, client }) {
  const { provider, contract } = podContract(pod, NETWORK);
  const utxos = await provider.getUtxos(contract.address);
  if (!utxos.length) return { refused: false, message: 'pod empty' };
  const utxo = utxos[0];
  const tb = new TransactionBuilder({ provider });
  tb.addInput(utxo, contract.unlock.refund(client.pub, client.sig));
  tb.addOutput({ to: addressOf(client.pkh, NETWORK), amount: utxo.satoshis - FEES.refund });
  tb.setLocktime(Number(pod.validUntil));
  try {
    tb.debug();
    return { refused: false, message: 'VM accepted an early refund — a contract bug' };
  } catch (e) {
    return { refused: true, message: (e.message ?? '').split('\n')[0], explain: explainVmError(e) };
  }
}

async function main() {
  const steps = [];
  const add = (step) => {
    steps.push({ n: steps.length + 1, at: new Date().toISOString(), ...step });
    console.log(`${String(steps.length).padStart(2, '0')}. ${step.title} ${step.txid ? `— ${step.txid}` : ''}`);
  };

  let state = null;
  try { state = JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { /* fresh */ }

  if (!state || !replay) {
    const seeds = { client: randomSeedHex(), provider: randomSeedHex() };
    const client = keyFromSeedHex(seeds.client, 0);
    const provider = keyFromSeedHex(seeds.provider, 0);
    state = {
      seeds,
      client: addressOf(client.pkh, NETWORK),
      provider: addressOf(provider.pkh, NETWORK),
      jobs: {},
    };
    fs.mkdirSync(new URL('../.secrets/', import.meta.url), { recursive: true });
    fs.writeFileSync(SECRETS, JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

    for (const [name, key, sats] of [['client', client, '500000'], ['provider', provider, '150000']]) {
      try {
        const r = await faucet(addressOf(key.pkh, NETWORK), sats);
        add({ kind: 'faucet', title: `Faucet → ${name} (${sats} sat of chipnet BCH)`, txid: r.txid, who: name });
      } catch (e) {
        add({ kind: 'note', title: `Faucet skipped for ${name} (${e.message.slice(0, 60)})` });
      }
    }
    await sleep(4000);
    await waitFor(addressOf(client.pkh, NETWORK), 100000, 'client funding');
  }

  const client = keyFromSeedHex(state.seeds.client, 0);
  const provider = keyFromSeedHex(state.seeds.provider, 0);
  const height = (await readPod({ clientPkh: client.pkh, providerPkh: provider.pkh, chunk: 1n, window: 1n, validUntil: 1n }, NETWORK)).blockHeight;

  // ===== JOB A: a normal job, paid in chunks, closed by agreement =========
  const podA = {
    clientPkh: client.pkh, providerPkh: provider.pkh,
    chunk: 20000n, window: 60000n, validUntil: BigInt(height + 24),
  };
  const jobA = {
    jobId: 'job_' + crypto.randomBytes(4).toString('hex'),
    client: state.client,
    provider: state.provider,
    description: '5 chunks of inference work for an agent wallet',
  };
  add({ kind: 'job', title: `Job A opened: ${jobA.jobId} — 20,000 sat per chunk, 60,000 sat window, expires at block ${podA.validUntil}`, job: jobA.jobId, address: podAddress(podA, NETWORK), jobHash: jobHash({ ...jobA, ...podA }) });

  if (!replay) {
    const st = await readPod(podA, NETWORK);
    if (BigInt(st.balance) === 0n) {
      const r = await fundPod({ pod: podA, network: NETWORK, funder: client, satoshis: 100000n });
      add({ kind: 'fund', title: 'Client pre-authorises 100,000 sat into the pod', txid: r.txid });
      await waitFor(podAddress(podA, NETWORK), 100000, 'pod funding');
    }

    const receipts = [];
    for (let i = 0; i < 3; i++) {
      const payload = `chunk ${i}: completion ${crypto.randomBytes(3).toString('hex')} — 512 tokens`;
      const r = await deliverChunks({ pod: podA, network: NETWORK, provider, chunks: 1n });
      const receipt = chunkReceipt({
        job: { ...jobA, ...podA }, index: i,
        payloadHash: crypto.createHash('sha256').update(payload).digest('hex'),
        txid: r.txid, paidSats: r.paid,
      });
      receipts.push(receipt);
      add({
        kind: 'deliver', title: `Provider pulled chunk ${i + 1} (20,000 sat) — remainder returned to the pod`,
        txid: r.txid, paid: r.paid.toString(), receipt, index: i,
      });
      await sleep(2500);
    }

    const steal = await simulateSteal({ pod: podA, network: NETWORK, provider, wantChunks: 4n });
    add({
      kind: 'refuse', title: 'Malicious provider tries to pull 4 chunks at once — the covenant refuses',
      refused: steal.refused, message: steal.message, explain: steal.explain,
    });

    const early = await attemptEarlyRefund({ pod: podA, client });
    add({
      kind: 'refuse', title: 'Client tries to reclaim its money mid-job — the covenant refuses',
      refused: early.refused, message: early.message, explain: early.explain,
    });

    const close = await closePod({ pod: podA, network: NETWORK, client, provider, chunks: 1n });
    add({
      kind: 'close', title: 'Both sign a close: provider paid for 1 more chunk, client made whole for the rest',
      txid: close.txid,
    });
    state.jobs.jobA = {
      pod: {
        chunk: String(podA.chunk), window: String(podA.window), validUntil: String(podA.validUntil),
      },
      job: jobA, receipts,
    };
    fs.writeFileSync(SECRETS, JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  }

  // ===== JOB B: authority expires, the money does not ====================
  const podB = {
    clientPkh: client.pkh, providerPkh: provider.pkh,
    chunk: 20000n, window: 60000n, validUntil: BigInt(height - 5), // already expiring: tip is past it
  };
  const jobB = { jobId: 'job_' + crypto.randomBytes(4).toString('hex'), client: state.client, provider: state.provider, description: 'a job whose authority window has closed' };
  add({ kind: 'job', title: `Job B opened with a window that closes at block ${podB.validUntil} — authority is time-bounded`, job: jobB.jobId, address: podAddress(podB, NETWORK) });

  if (!replay) {
    const st = await readPod(podB, NETWORK);
    if (BigInt(st.balance) === 0n) {
      const r = await fundPod({ pod: podB, network: NETWORK, funder: client, satoshis: 60000n });
      add({ kind: 'fund', title: 'Client funds 60,000 sat into a pod that is already past its expiry', txid: r.txid });
      await waitFor(podAddress(podB, NETWORK), 60000, 'expired pod funding');
    }
    let refunded = false;
    for (let attempt = 0; attempt < 18 && !refunded; attempt += 1) {
      try {
        const rf = await refundPod({ pod: podB, network: NETWORK, client });
        add({ kind: 'refund', title: 'Expired pod: the client reclaims everything left — no provider, no arbiter, no support ticket', txid: rf.txid });
        refunded = true;
      } catch (e) {
        const msg = (e.message ?? '').split('\n')[0];
        if (!/not yet final|not expired yet/i.test(msg)) { add({ kind: 'note', title: `Refund failed: ${msg.slice(0, 140)}` }); break; }
        process.stdout.write(`\r  waiting for the tip to pass block ${podB.validUntil} (attempt ${attempt + 1})…   `);
        await sleep(10000);
      }
    }
    if (!refunded) add({ kind: 'note', title: `Refund still pending at the chain tip; re-run with --replay to pick it up.` });
    state.jobs.jobB = {
      pod: { chunk: String(podB.chunk), window: String(podB.window), validUntil: String(podB.validUntil) },
      job: jobB,
    };
    fs.writeFileSync(SECRETS, JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  }

  // ===== live state + evidence table =====================================
  const live = {};
  for (const [name, pod, job] of [
    ['A', (state.jobs.jobA?.pod ? { clientPkh: client.pkh, providerPkh: provider.pkh, chunk: BigInt(state.jobs.jobA.pod.chunk), window: BigInt(state.jobs.jobA.pod.window), validUntil: BigInt(state.jobs.jobA.pod.validUntil) } : podA)],
    ['B', (state.jobs.jobB?.pod ? { clientPkh: client.pkh, providerPkh: provider.pkh, chunk: BigInt(state.jobs.jobB.pod.chunk), window: BigInt(state.jobs.jobB.pod.window), validUntil: BigInt(state.jobs.jobB.pod.validUntil) } : podB)],
  ]) {
    const st = await readPod(pod, NETWORK);
    live[name] = { ...st, address: podAddress(pod, NETWORK) };
  }

  const data = {
    generatedAt: new Date().toISOString(),
    network: NETWORK,
    explorer: NETWORKS[NETWORK].explorer,
    identities: { client: state.client, provider: state.provider },
    jobs: {
      A: { ...(state.jobs.jobA ?? {}), live: live.A },
      B: { ...(state.jobs.jobB ?? {}), live: live.B },
    },
    steps,
    totals: {
      chunks: steps.filter((s) => s.kind === 'deliver').length,
      paidSats: steps.filter((s) => s.kind === 'deliver').reduce((a, s) => a + BigInt(s.paid), 0n).toString(),
      refusals: steps.filter((s) => s.kind === 'refuse').length,
      txs: steps.filter((s) => s.txid).length,
    },
  };
  fs.mkdirSync(new URL('../web/', import.meta.url), { recursive: true });
  const json = JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  fs.writeFileSync(OUT, json);
  console.log(`\nwrote web/data.json — ${data.totals.txs} real txs, ${data.totals.refusals} refusals, ${data.totals.paidSats} sat paid`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
