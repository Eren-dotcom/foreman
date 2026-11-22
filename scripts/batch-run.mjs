#!/usr/bin/env node
/**
 * scripts/batch-run.mjs — the batching proof.
 *
 * Foreman's covenant refuses to splice two pods into one transaction
 * (`require(tx.inputs.length == 1)`), because merging pods is how you lose the
 * per-pod accounting. So instead of many inputs, we do many *chunks* per input:
 * one signature, one fee, N chunk payments.
 *
 * Real-world shape: an agent has one business relationship (one pod) and pays
 * many chunks of work out of it every minute. On BCH that is one 1.4k-sat fee
 * for N payments; per-payment cost falls as N rises. That is the economic
 * argument for agent settlement on BCH rather than anywhere else.
 *
 *   node scripts/batch-run.mjs            # runs 1,2,4,8,16-chunk batches
 *   node scripts/batch-run.mjs --plain    # same, but single-chunk pulls
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  keyFromSeedHex, randomSeedHex, addressOf, podAddress, podContract, readPod,
  fundPod, buildDeliverTx, broadcastHex, jobHash, NETWORKS, FEES, explainVmError,
} from '../lib.mjs';

const NETWORK = 'chipnet';
const SECRETS = new URL('../.secrets/batch.json', import.meta.url);
const OUT = new URL('../web/batch.json', import.meta.url);
const makePlain = process.argv.includes('--plain');
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
  for (;;) {
    const d = crypto.createHash('sha256').update(`${ch.json.payload}:${nonce}`).digest('hex');
    if (BigInt(`0x${d}`) <= target) break;
    nonce += 1n;
    if (nonce > 50_000_000n) throw new Error('faucet PoW gave up');
  }
  const claim = await post('claim', { payload: ch.json.payload, signature: ch.json.signature, nonce: nonce.toString() });
  if (claim.status !== 200) throw new Error(JSON.stringify(claim.json));
  return claim.json;
}

async function waitBalance(address, want) {
  const { provider } = podContract({ clientPkh: new Uint8Array(20), providerPkh: new Uint8Array(20), chunk: 1n, window: 1n, validUntil: 1n }, NETWORK);
  for (let i = 0; i < 40; i++) {
    const utxos = await provider.getUtxos(address);
    const bal = utxos.reduce((a, u) => a + u.satoshis, 0n);
    if (bal >= BigInt(want)) return bal;
    process.stdout.write(`\r  waiting: ${bal}/${want}…   `);
    await sleep(4000);
  }
  throw new Error('funding did not confirm');
}

async function main() {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { /* fresh */ }

  if (!state) {
    const seeds = { client: randomSeedHex(), provider: randomSeedHex() };
    state = { seeds, jobs: {}, rows: [] };
    fs.mkdirSync(new URL('../.secrets/', import.meta.url), { recursive: true });
    fs.writeFileSync(SECRETS, JSON.stringify(state, null, 2));
    const client = keyFromSeedHex(seeds.client, 0);
    const provider = keyFromSeedHex(seeds.provider, 0);
    for (const [name, k, sats] of [['client', client, '2000000'], ['provider', provider, '100000']]) {
      try {
        const r = await faucet(addressOf(k.pkh, NETWORK), sats);
        console.log(`faucet ${name}: ${r.txid}`);
      } catch (e) { console.log(`faucet ${name} failed: ${e.message}`); }
    }
    await sleep(5000);
    await waitBalance(addressOf(client.pkh, NETWORK), 200000);
  }

  const client = keyFromSeedHex(state.seeds.client, 0);
  const provider = keyFromSeedHex(state.seeds.provider, 0);
  const blockHeight = (await readPod({ clientPkh: client.pkh, providerPkh: provider.pkh, chunk: 1n, window: 1n, validUntil: 1n }, NETWORK)).blockHeight;

  const chunk = 5000n;              // small chunks: this is about counting, not amounts
  const window = 200000n;           // room for a 16-chunk batch
  const pod = { clientPkh: client.pkh, providerPkh: provider.pkh, chunk, window, validUntil: BigInt(blockHeight + 500) };
  const address = podAddress(pod, NETWORK);
  console.log('pod', address, '— chunk', chunk.toString(), 'sat, window', window.toString(), 'sat');

  const st = await readPod(pod, NETWORK);
  if (BigInt(st.balance) === 0n) {
    const r = await fundPod({ pod, network: NETWORK, funder: client, satoshis: 300000n });
    console.log('funded:', r.txid);
    await waitBalance(address, 300000);
  }

  // ---- the comparison ---------------------------------------------------
  const sizes = makePlain ? [1, 1, 1, 1] : [1, 2, 4, 8, 16];
  const rows = [];
  for (const n of sizes) {
    try {
      const built = await buildDeliverTx({ pod, network: NETWORK, provider, chunks: BigInt(n) });
      const fee = built.utxo.satoshis - built.paid - built.remainder;
      const bytes = built.txHex.length / 2;
      const txid = await broadcastHex(NETWORK, built.txHex);
      const row = {
        chunks: n,
        bytes,
        feeSats: fee.toString(),
        satsPerPayment: (Number(fee) / n).toFixed(1),
        txid,
        at: new Date().toISOString(),
      };
      rows.push(row);
      console.log(`${String(n).padStart(2)} chunk(s) in one tx → ${bytes} bytes, fee ${fee} sat = ${row.satsPerPayment} sat/payment — ${txid}`);
      await sleep(1500);
    } catch (e) {
      const ex = explainVmError(e);
      console.log(`batch of ${n} refused:`, ex.text);
      rows.push({ chunks: n, refused: true, message: ex.text, line: ex.line });
      break;
    }
  }

  // ---- what the same work costs if paid one by one ----------------------
  const single = rows.find((r) => r.chunks === 1 && !r.refused);
  const batch16 = rows.find((r) => r.chunks === 16 && !r.refused);
  const comparison = single && batch16 ? {
    oneByOne: { txs: 16, bytes: Number(single.bytes) * 16, feeSats: (Number(single.feeSats) * 16).toString() },
    batched: { txs: 1, bytes: Number(batch16.bytes), feeSats: batch16.feeSats },
    savingPct: (100 - (Number(batch16.feeSats) / (Number(single.feeSats) * 16)) * 100).toFixed(1),
  } : null;

  const out = {
    generatedAt: new Date().toISOString(),
    network: NETWORK,
    explorer: NETWORKS[NETWORK].explorer,
    pod: { address, chunk: chunk.toString(), window: window.toString(), validUntil: pod.validUntil.toString() },
    client: addressOf(client.pkh, NETWORK),
    provider: addressOf(provider.pkh, NETWORK),
    mode: makePlain ? 'one-by-one' : 'batched',
    rows,
    comparison,
    live: await readPod(pod, NETWORK),
  };
  const json = JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  fs.mkdirSync(new URL('../web/', import.meta.url), { recursive: true });
  fs.writeFileSync(OUT, json);
  if (comparison) {
    console.log(`\nsame work, one-by-one: ${comparison.oneByOne.feeSats} sat over 16 txs`);
    console.log(`same work, batched:    ${comparison.batched.feeSats} sat in 1 tx → ${comparison.savingPct}% cheaper`);
  }
  console.log('wrote web/batch.json');
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
