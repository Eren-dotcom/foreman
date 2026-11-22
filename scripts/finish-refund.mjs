#!/usr/bin/env node
/**
 * scripts/finish-refund.mjs — finish the expired-pod step of the recorded demo.
 *
 * Bitcoin finality is strict: a transaction with nLockTime = N is only final once
 * the chain tip is *above* N. This waits for the tip to pass Job B's expiry block,
 * reclaims the remainder with the client key, and patches web/data.json.
 */
import fs from 'node:fs';
import { keyFromSeedHex, readPod, refundPod, podAddress } from '../lib.mjs';

const NETWORK = 'chipnet';
const state = JSON.parse(fs.readFileSync(new URL('../.secrets/demo.json', import.meta.url), 'utf8'));
const dataPath = new URL('../web/data.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const client = keyFromSeedHex(state.seeds.client, 0);
const provider = keyFromSeedHex(state.seeds.provider, 0);
const b = state.jobs?.jobB;
if (!b) throw new Error('no jobB in .secrets/demo.json — run scripts/demo.mjs first');

const pod = {
  clientPkh: client.pkh,
  providerPkh: provider.pkh,
  chunk: BigInt(b.pod.chunk),
  window: BigInt(b.pod.window),
  validUntil: BigInt(b.pod.validUntil),
};
const address = podAddress(pod, NETWORK);
console.log('pod B', address, 'expiry block', pod.validUntil.toString());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let attempt = 1; attempt <= 60; attempt += 1) {
  const st = await readPod(pod, NETWORK);
  if (BigInt(st.balance) === 0n) {
    console.log('pod B is already empty — nothing left to reclaim');
    process.exit(0);
  }
  try {
    const r = await refundPod({ pod, network: NETWORK, client });
    console.log('REFUNDED', r.txid);
    const step = data.steps.find((s) => s.kind === 'note' && /Refund/i.test(s.title));
    const patched = {
      n: data.steps.length + 1,
      at: new Date().toISOString(),
      kind: 'refund',
      title: 'Expired pod: the client reclaims everything left — no provider, no arbiter, no support ticket',
      txid: r.txid,
    };
    if (step) Object.assign(step, patched); else data.steps.push(patched);
    data.totals.txs = data.steps.filter((s) => s.txid).length;
    data.jobs.B = { ...(data.jobs.B ?? {}), live: { ...st, balance: '0', address } };
    fs.writeFileSync(dataPath, JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    console.log('patched web/data.json');
    process.exit(0);
  } catch (e) {
    const msg = e.message.split('\n')[0];
    console.log(`attempt ${attempt}: ${msg} (tip ${st.blockHeight}, expiry ${pod.validUntil})`);
    if (!/not yet final|not expired yet/i.test(msg)) process.exit(1);
    await sleep(15000);
  }
}
console.log('gave up waiting; the refund is still pending');
