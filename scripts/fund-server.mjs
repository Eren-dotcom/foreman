#!/usr/bin/env node
// Tops up the server's demo wallets from the chipnet faucet so judges can click.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { keyFromSeedHex, addressOf } from '../lib.mjs';
const seeds = JSON.parse(fs.readFileSync(new URL('../.secrets/server.json', import.meta.url), 'utf8'));
const post = async (p, body) => {
  const r = await fetch(`https://chipnet.bch.ninja/api/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
for (const [name, sats] of [['client', process.argv[2] ?? '2000000'], ['provider', '200000']]) {
  const k = keyFromSeedHex(seeds[name], 0);
  const address = addressOf(k.pkh, 'chipnet');
  const ch = await post('challenge', { address, sats });
  if (ch.status !== 200) { console.log(name, 'challenge failed', JSON.stringify(ch.json)); continue; }
  const target = BigInt(`0x${ch.json.target}`);
  let nonce = 0n;
  for (;;) {
    const d = crypto.createHash('sha256').update(`${ch.json.payload}:${nonce}`).digest('hex');
    if (BigInt(`0x${d}`) <= target) break;
    nonce += 1n;
  }
  const claim = await post('claim', { payload: ch.json.payload, signature: ch.json.signature, nonce: nonce.toString() });
  console.log(`${name} ${address} →`, claim.status === 200 ? claim.json.txid : JSON.stringify(claim.json));
}
