/**
 * solidcash/tests/ChunkPod.scash.test.mjs — the SolidCash port, tested on a mock network.
 *
 * Mirrors the CashScript suite: deliver (1 and 2 chunks), refund (before expiry
 * refused, at expiry accepted), and six named cheat paths. Each transaction is
 * evaluated by the SolidCash VM in `TransactionBuilder.send()`.
 *
 *   node --version   # needs Node 22+
 *   node tests/ChunkPod.scash.test.mjs
 */
import { Contract, SignatureTemplate, TransactionBuilder, Network, randomUtxo } from '@solidcash/solidcash';
import { hash160, secp256k1, deriveHdPrivateNodeFromSeed, deriveHdPath, encodeCashAddress, hexToBin, binToHex } from '@bitauth/libauth';
import crypto from 'node:crypto';
import fs from 'node:fs';

const artifact = JSON.parse(fs.readFileSync(new URL('../artifacts/ChunkPod.json', import.meta.url), 'utf8'));

// ---- an honest in-memory network that returns real txids -------------------
class MockNetwork {
  constructor() { this.utxos = new Map(); this.txs = new Map(); this.height = 900000; }
  async getUtxos(address) { return this.utxos.get(address) ?? []; }
  async getUtxosForLockingBytecode(lb) {
    for (const list of this.utxos.values()) if (list[0]?.lockingBytecode === lb) return list;
    return [];
  }
  async getBlockHeight() { return this.height; }
  async getRawTransaction(txid) { return this.txs.get(txid); }
  async sendRawTransaction(hex) {
    const txid = binToHex(crypto.createHash('sha256').update(crypto.createHash('sha256').update(hexToBin(hex)).digest()).digest().reverse());
    this.txs.set(txid, hex);
    return txid;
  }
  addUtxo(address, utxo) {
    const list = [...(this.utxos.get(address) ?? []), utxo];
    this.utxos.set(address, list);
    return utxo;
  }
}

const seed = deriveHdPrivateNodeFromSeed(new Uint8Array(32).fill(9), true);
function key(i) {
  const node = deriveHdPath(seed, `m/44'/145'/0'/0/${i}`);
  const priv = node.privateKey;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  return { pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
}
const client = key(1);
const provider = key(2);
const attacker = key(3);

const CHUNK = 20000n;
const WINDOW = 60000n;
const VALID_UNTIL = 900000n;
const FEE = 700n;
const REFUND_FEE = 600n;

const addr = (pkh) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address;

function newPod(overrides = {}) {
  const net = new MockNetwork();
  const contract = new Contract(artifact, [
    overrides.clientPkh ?? client.pkh,
    overrides.providerPkh ?? provider.pkh,
    overrides.chunkSize ?? CHUNK,
    overrides.windowSize ?? WINDOW,
    overrides.validUntil ?? VALID_UNTIL,
  ], { provider: net, network: Network.CHIPNET });
  return { net, contract };
}

function fund(net, contract, satoshis, lockingBytecode) {
  return net.addUtxo(contract.address, randomUtxo({ satoshis, lockingBytecode }));
}

async function spend(net, contract, { fn, args, inputs, outs, time }) {
  const tb = new TransactionBuilder({ provider: net });
  inputs.forEach((u) => tb.addInput(u, contract.unlock[fn](...args)));
  outs.forEach((o) => tb.addOutput({ to: o.to, amount: o.amount }));
  tb.setLocktime(Number(time ?? 0));
  return tb.send();
}

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, (e.message ?? String(e)).split('\n')[0].slice(0, 150)]); }
}
async function mustReject(fn) {
  let ok = false;
  try { await fn(); } catch { ok = true; }
  if (!ok) throw new Error('transaction was ACCEPTED but should have been rejected');
}

await t('1  deliver 1 chunk → provider paid, remainder returns to the pod', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: contract.address, amount: 100000n - 20000n - FEE }],
  });
});

await t('2  deliver 2 chunks in one transaction (inside the window)', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 40000n }, { to: contract.address, amount: 100000n - 40000n - FEE }],
  });
});

await t('3  CHEAT over-window pull (80000 > window 60000) rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 80000n }, { to: contract.address, amount: 100000n - 80000n - FEE }],
  }));
});

await t('4  CHEAT partial chunk (30000) rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 30000n }, { to: contract.address, amount: 100000n - 30000n - FEE }],
  }));
});

await t('5  CHEAT unknown key signs as provider rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [attacker.pub, attacker.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: contract.address, amount: 100000n - 20000n - FEE }],
  }));
});

await t('6  CHEAT provider redirects its payment to a stranger rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(attacker.pkh), amount: 20000n }, { to: contract.address, amount: 100000n - 20000n - FEE }],
  }));
});

await t('7  CHEAT short-changed remainder rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: contract.address, amount: 70000n }],
  }));
});

await t('8  CHEAT overdraw (pull more than the pod holds) rejected', async () => {
  const { net, contract } = newPod({ windowSize: 200000n });
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 100000n }, { to: contract.address, amount: 0n }],
  }));
});

await t('9  CHEAT refund before expiry rejected', async () => {
  const { net, contract } = newPod();
  net.height = Number(VALID_UNTIL) - 1;
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'refund', args: [client.pub, client.sig], inputs: [u], time: VALID_UNTIL - 1n,
    outs: [{ to: addr(client.pkh), amount: 100000n - REFUND_FEE }],
  }));
});

await t('10 refund at expiry: the client recovers the remainder', async () => {
  const { net, contract } = newPod();
  net.height = Number(VALID_UNTIL);
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await spend(net, contract, {
    fn: 'refund', args: [client.pub, client.sig], inputs: [u], time: VALID_UNTIL,
    outs: [{ to: addr(client.pkh), amount: 100000n - REFUND_FEE }],
  });
});

await t('11 CHEAT provider cannot refund the pod to itself', async () => {
  const { net, contract } = newPod();
  net.height = Number(VALID_UNTIL);
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'refund', args: [provider.pub, provider.sig], inputs: [u], time: VALID_UNTIL,
    outs: [{ to: addr(provider.pkh), amount: 100000n - REFUND_FEE }],
  }));
});

await t('12 CHEAT refund to the wrong destination rejected', async () => {
  const { net, contract } = newPod();
  net.height = Number(VALID_UNTIL);
  const u = fund(net, contract, 100000n, contract.lockingBytecode);
  await mustReject(() => spend(net, contract, {
    fn: 'refund', args: [client.pub, client.sig], inputs: [u], time: VALID_UNTIL,
    outs: [{ to: addr(attacker.pkh), amount: 100000n - REFUND_FEE }],
  }));
});

console.log('\nChunkPod.scash — the SolidCash port, evaluated by the SolidCash VM\n');
let failed = 0;
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${status}  ${name}${msg ? `\n        → ${msg}` : ''}`);
  if (status === 'FAIL') failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passing\n`);
const out = new URL('../tests/solidcash-results.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed, total: results.length, results }, null, 2));
process.exit(failed ? 1 : 0);
