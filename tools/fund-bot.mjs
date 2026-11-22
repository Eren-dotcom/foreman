#!/usr/bin/env node
/**
 * tools/fund-bot.mjs — tops up the test wallet bot's chipnet addresses from the
 * public chipnet faucet (proof-of-work challenge, no captcha). Test-only.
 *
 *   node tools/fund-bot.mjs 0 1 2      # address indices to fund
 */
import crypto from 'node:crypto';
import {
  hexToBin, deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative,
  secp256k1, hash160, encodeCashAddress,
} from '@bitauth/libauth';

const SEED = process.env.BOT_SEED ? hexToBin(process.env.BOT_SEED) : hexToBin('11'.repeat(32));
const root = deriveHdPrivateNodeFromSeed(SEED, true);
const branch = deriveHdPath(root, "m/44'/145'/0'/0");
const sats = process.argv[3] ?? '300000';
const post = async (p, body) => {
  const r = await fetch(`https://chipnet.bch.ninja/api/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};
const indices = (process.argv[2] ?? '0').split(',').map(Number);
for (const index of indices) {
  const child = deriveHdPathRelative(branch, String(index));
  const pub = secp256k1.derivePublicKeyCompressed(child.privateKey);
  const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: hash160(pub) }).address;
  const ch = await post('challenge', { address, sats });
  if (ch.status !== 200) { console.log(index, address, 'challenge failed', JSON.stringify(ch.json)); continue; }
  const target = BigInt(`0x${ch.json.target}`);
  let nonce = 0n;
  for (;;) {
    const d = crypto.createHash('sha256').update(`${ch.json.payload}:${nonce}`).digest('hex');
    if (BigInt(`0x${d}`) <= target) break;
    nonce += 1n;
  }
  const claim = await post('claim', { payload: ch.json.payload, signature: ch.json.signature, nonce: nonce.toString() });
  console.log(index, address, '→', claim.status === 200 ? claim.json.txid : JSON.stringify(claim.json));
}
