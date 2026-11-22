#!/usr/bin/env node
/**
 * scripts/chipnet-run.mjs — run a whole Foreman job on Chipnet, for real.
 *
 *   node scripts/chipnet-run.mjs --new          # fresh keys + faucet funding
 *   node scripts/chipnet-run.mjs --steal        # show the covenant refusing a cheat
 *   node scripts/chipnet-run.mjs --refund       # after the pod expires
 *
 * Keys are written to .secrets/chipnet.json (gitignored). Chipnet coins only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  keyFromSeedHex, randomSeedHex, addressOf, podAddress, readPod,
  fundPod, deliverChunks, simulateSteal, refundPod, closePod, chunkReceipt,
  jobHash, NETWORKS,
} from '../lib.mjs';

const SECRETS = new URL('../.secrets/chipnet.json', import.meta.url);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function load() {
  try { return JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { return null; }
}
function save(state) {
  fs.mkdirSync(new URL('../.secrets/', import.meta.url), { recursive: true });
  fs.writeFileSync(SECRETS, JSON.stringify(state, null, 2));
}

// ---- faucet (chipnet.bch.ninja: proof-of-work challenge, then claim) -------
async function faucet(address, sats = '200000') {
  const post = async (p, body) => {
    const r = await fetch(`https://chipnet.bch.ninja/api/${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const ch = await post('challenge', { address, sats });
  if (ch.status !== 200) throw new Error(`faucet challenge failed: ${JSON.stringify(ch.json)}`);
  const target = BigInt(`0x${ch.json.target}`);
  let nonce = 0n;
  const t0 = Date.now();
  for (;;) {
    const d = crypto.createHash('sha256').update(`${ch.json.payload}:${nonce}`).digest('hex');
    if (BigInt(`0x${d}`) <= target) break;
    nonce += 1n;
    if (Date.now() - t0 > 120000) throw new Error('faucet proof-of-work timed out');
  }
  const claim = await post('claim', { payload: ch.json.payload, signature: ch.json.signature, nonce: nonce.toString() });
  if (claim.status !== 200) throw new Error(`faucet claim failed: ${JSON.stringify(claim.json)}`);
  return claim.json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFunding(pod, network, wantSats, label) {
  for (let i = 0; i < 30; i++) {
    const st = await readPod(pod, network);
    if (BigInt(st.balance) >= BigInt(wantSats)) return st;
    process.stdout.write(`\r  waiting for ${label} to confirm (${st.balance} / ${wantSats} sat)…   `);
    await sleep(4000);
  }
  throw new Error(`${label} did not confirm in time`);
}

async function main() {
  const network = 'chipnet';
  let state = load();

  if (has('--new') || !state) {
    const seeds = { client: randomSeedHex(), provider: randomSeedHex() };
    state = { network, seeds, job: null };
    save(state);
    console.log('new identities generated (.secrets/chipnet.json)');
  }

  const client = keyFromSeedHex(state.seeds.client, 0);
  const provider = keyFromSeedHex(state.seeds.provider, 0);
  console.log('client  ', addressOf(client.pkh, network));
  console.log('provider', addressOf(provider.pkh, network));
  console.log('explorer', NETWORKS[network].explorer.replace('/tx/', ''));

  if (has('--new') || has('--fund')) {
    for (const [name, k] of [['client', client], ['provider', provider]]) {
      const addr = addressOf(k.pkh, network);
      const st = await readPod({ clientPkh: k.pkh, providerPkh: k.pkh, chunk: 1n, window: 1n, validUntil: 1n }, network).catch(() => null);
      try {
        const r = await faucet(addr, name === 'client' ? '400000' : '100000');
        console.log(`faucet ${name}: ${r.txid}`);
      } catch (e) {
        console.log(`faucet ${name} skipped: ${e.message}`);
      }
    }
    await sleep(3000);
  }

  // ---- open a job -------------------------------------------------------
  if (!state.job) {
    const height = await readPod({ clientPkh: client.pkh, providerPkh: provider.pkh, chunk: 1n, window: 1n, validUntil: 1n }, network)
      .then((s) => s.blockHeight);
    const pod = {
      clientPkh: client.pkh,
      providerPkh: provider.pkh,
      chunk: 20000n,
      window: 60000n,            // 3 chunks max in one transaction
      validUntil: BigInt(height + 24), // ~4 hours on chaintime
      description: 'Inference job: 5 chunks of work',
    };
    state.job = {
      ...pod,
      clientPkh: undefined, providerPkh: undefined,
      validUntil: pod.validUntil.toString(),
      chunk: pod.chunk.toString(),
      window: pod.window.toString(),
      jobId: crypto.randomUUID(),
      client: addressOf(client.pkh, network),
      provider: addressOf(provider.pkh, network),
      receipts: [],
      createdAt: new Date().toISOString(),
    };
    save(state);
  }

  const job = state.job;
  const pod = {
    clientPkh: client.pkh, providerPkh: provider.pkh,
    chunk: BigInt(job.chunk), window: BigInt(job.window), validUntil: BigInt(job.validUntil),
  };
  const podAddr = podAddress(pod, network);
  console.log('\njob    ', job.jobId);
  console.log('jobHash', jobHash({ ...job, ...pod }));
  console.log('pod    ', podAddr);

  // ---- fund -------------------------------------------------------------
  if (!job.fundedTxid) {
    const st = await readPod(pod, network);
    if (BigInt(st.balance) === 0n) {
      const res = await fundPod({ pod, network, funder: client, satoshis: 100000n });
      job.fundedTxid = res.txid;
      save(state);
      console.log('FUND   ', res.txid, `→ ${NETWORKS[network].explorer}${res.txid}`);
      await waitForFunding(pod, network, 100000n, 'the funding tx');
      console.log('\n  pod funded with 100,000 sat');
    }
  } else {
    console.log('FUND   ', job.fundedTxid, '(already funded)');
  }

  // ---- deliver ----------------------------------------------------------
  if (!has('--steal') && !has('--refund') && !has('--close')) {
    for (let i = (job.receipts?.length ?? 0); i < 3; i++) {
      const payload = `result-${i}: the model returned 1 completion at ${new Date().toISOString()}`;
      const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
      try {
        const res = await deliverChunks({ pod, network, provider: provider, chunks: 1n });
        const receipt = chunkReceipt({
          job: { ...job, ...pod }, index: i, payloadHash, txid: res.txid, paidSats: res.paid,
        });
        job.receipts = [...(job.receipts ?? []), receipt];
        save(state);
        console.log(`CHUNK ${i}`, res.txid, `paid ${res.paid} sat`, `→ ${NETWORKS[network].explorer}${res.txid}`);
        await sleep(1500);
      } catch (e) {
        console.log(`CHUNK ${i} failed: ${e.message.split('\n')[0]}`);
        break;
      }
    }
  }

  // ---- cheat attempt ----------------------------------------------------
  // To show the *covenant* refusing (not just the builder's fee guard) the pod
  // needs enough money for an over-window pull, so this uses a dedicated pod
  // funded to 100,000 sat with nothing delivered yet.
  if (has('--steal')) {
    let challenge = job.challengePod;
    // +10 on validUntil gives the challenge pod a distinct address, so it is
    // funded fresh and never mixes with the job pod's history.
    const cpod = {
      clientPkh: client.pkh, providerPkh: provider.pkh,
      chunk: BigInt(job.chunk), window: BigInt(job.window), validUntil: BigInt(job.validUntil) + 10n,
    };
    if (!challenge) {
      const address = podAddress(cpod, network);
      const st = await readPod(cpod, network);
      if (BigInt(st.balance) === 0n) {
        const res = await fundPod({ pod: { ...cpod }, network, funder: client, satoshis: 100000n });
        console.log('CHALLENGE POD funded', res.txid);
        await waitForFunding(cpod, network, 100000n, 'the challenge pod');
        challenge = { address, fundedTxid: res.txid };
      } else {
        challenge = { address, fundedTxid: null };
      }
      job.challengePod = challenge;
      save(state);
    }
    console.log('\nchallenge pod:', podAddress(cpod, network));
    console.log('A malicious provider tries to pull 4 chunks in one transaction; the window allows 3:');
    const r = await simulateSteal({ pod: cpod, network, provider: provider, wantChunks: 4n });
    console.log('  refused:', r.refused);
    console.log('  vm message:', r.message);
    if (r.explain?.rule) {
      console.log(`  rule: ${r.explain.rule} (line ${r.explain.line})`);
      console.log('  →', r.explain.text);
    }
    job.stealAttempt = { ...r, at: new Date().toISOString() };
    save(state);
  }

  // ---- refund / close ---------------------------------------------------
  if (has('--refund')) {
    try {
      const r = await refundPod({ pod, network, client });
      job.refundTxid = r.txid;
      save(state);
      console.log('REFUND ', r.txid, `→ ${NETWORKS[network].explorer}${r.txid}`);
    } catch (e) {
      console.log('refund:', e.message);
    }
  }
  if (has('--close')) {
    const r = await closePod({ pod, network, client, provider: provider, chunks: 1n });
    job.closeTxid = r.txid;
    save(state);
    console.log('CLOSE  ', r.txid, `→ ${NETWORKS[network].explorer}${r.txid}`);
  }

  const st = await readPod(pod, network);
  console.log('\npod state:', JSON.stringify(st, null, 2));
  console.log('receipts:', (job.receipts ?? []).length);
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
