import { Contract, MockNetworkProvider, TransactionBuilder, SignatureTemplate, randomUtxo } from 'cashscript';
import { hash160, secp256k1, deriveHdPrivateNodeFromSeed, deriveHdPath, encodeCashAddress } from '@bitauth/libauth';
import fs from 'fs';

const artifact = JSON.parse(fs.readFileSync(new URL('../artifacts/ChunkPod.json', import.meta.url)));

// --- keys ---------------------------------------------------------------
const seed = deriveHdPrivateNodeFromSeed(new Uint8Array(32).fill(7), true);
function key(i) {
  const node = deriveHdPath(seed, `m/44'/145'/0'/0/${i}`);
  const priv = node.privateKey;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
}
const client = key(1);
const provider = key(2);
const attacker = key(3);

const CHUNK = 10000n;
const WINDOW = 25000n;
const VALID_UNTIL = 900000n;
const FEE = 700n;
const REFUND_FEE = 600n;
const CLOSE_FEE = 800n;

const addr = (pkh) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address;

function newPod(overrides = {}) {
  const net = new MockNetworkProvider();
  const contract = new Contract(artifact, [
    overrides.clientPkh ?? client.pkh,
    overrides.providerPkh ?? provider.pkh,
    overrides.chunk ?? CHUNK,
    overrides.window ?? WINDOW,
    overrides.validUntil ?? VALID_UNTIL,
  ], { provider: net });
  return { net, contract };
}

function fund(net, contract, satoshis) {
  return net.addUtxo(contract.address, randomUtxo({ satoshis }));
}

// Build + send a pod spend. outs = [{to, amount}, ...]
async function spend(net, contract, { fn, args, inputs, outs, time }) {
  const tb = new TransactionBuilder({ provider: net });
  inputs.forEach((utxo) => tb.addInput(utxo, contract.unlock[fn](...args)));
  outs.forEach((o) => tb.addOutput({ to: o.to, amount: o.amount }));
  if (time !== undefined) tb.setLocktime(Number(time));
  return tb.send();
}

// --- harness ------------------------------------------------------------
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, (e.message ?? String(e)).split('\n')[0].slice(0, 140)]); }
}
async function mustReject(fn) {
  let ok = false;
  try { await fn(); } catch { ok = true; }
  if (!ok) throw new Error('transaction was ACCEPTED but should have been rejected');
}

// --- happy paths --------------------------------------------------------
await t('1  deliver 1 chunk → provider paid, remainder returns to the pod', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 10000n }, { to: contract.address, amount: 100000n - 10000n - FEE }],
  });
});

await t('2  deliver 2 chunks in one tx (within window)', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: contract.address, amount: 100000n - 20000n - FEE }],
  });
});

await t('3  two sequential chunks from the same pod (state carried in the coin)', async () => {
  const { net, contract } = newPod();
  const u0 = fund(net, contract, 100000n);
  const r1 = await spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u0],
    outs: [{ to: addr(provider.pkh), amount: 10000n }, { to: contract.address, amount: 100000n - 10000n - FEE }],
  });
  const u1 = { txid: r1.txid, vout: 1, satoshis: 100000n - 10000n - FEE, lockingBytecode: contract.bytecode ? undefined : undefined };
  const utxos = await net.getUtxos(contract.address);
  const next = utxos[0];
  const remain = next.satoshis;
  await spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [next],
    outs: [{ to: addr(provider.pkh), amount: 10000n }, { to: contract.address, amount: remain - 10000n - FEE }],
  });
});

// --- cheat paths --------------------------------------------------------
await t('4  CHEAT over-window pull (30000 > window 25000) rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 30000n }, { to: contract.address, amount: 100000n - 30000n - FEE }],
  }));
});

await t('5  CHEAT partial chunk (15000 is not a whole chunk) rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 15000n }, { to: contract.address, amount: 100000n - 15000n - FEE }],
  }));
});

await t('6  CHEAT unknown key signs as provider rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [attacker.pub, attacker.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 10000n }, { to: contract.address, amount: 100000n - 10000n - FEE }],
  }));
});

await t('7  CHEAT provider redirects its own payment to a stranger rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(attacker.pkh), amount: 10000n }, { to: contract.address, amount: 100000n - 10000n - FEE }],
  }));
});

await t('8  CHEAT extra third output (skimming the pod) rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [
      { to: addr(provider.pkh), amount: 10000n },
      { to: contract.address, amount: 100000n - 10000n - FEE },
      { to: addr(attacker.pkh), amount: 2000n },
    ],
  }));
});

await t('9  CHEAT overdraw — pulling more than the pod holds rejected', async () => {
  const { net, contract } = newPod({ window: 200000n });
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 100000n }, { to: contract.address, amount: 0n }],
  }));
});

await t('10 CHEAT short-changing the pod remainder rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 10000n }, { to: contract.address, amount: 85000n }],
  }));
});

await t('11 CHEAT merging two pods in one tx rejected', async () => {
  const { net, contract } = newPod({ window: 200000n });
  const u1 = fund(net, contract, 100000n);
  const u2 = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'deliver', args: [provider.pub, provider.sig], inputs: [u1, u2],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: contract.address, amount: 200000n - 20000n - FEE }],
  }));
});

await t('12 CHEAT refund before expiry rejected', async () => {
  const { net, contract } = newPod();
  net.setBlockHeight(Number(VALID_UNTIL) - 1);
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'refund', args: [client.pub, client.sig], inputs: [u], time: VALID_UNTIL - 1n,
    outs: [{ to: addr(client.pkh), amount: 100000n - REFUND_FEE }],
  }));
});

await t('13 refund on the expiry block: client recovers the remainder', async () => {
  const { net, contract } = newPod();
  net.setBlockHeight(Number(VALID_UNTIL));
  const u = fund(net, contract, 100000n);
  await spend(net, contract, {
    fn: 'refund', args: [client.pub, client.sig], inputs: [u], time: VALID_UNTIL,
    outs: [{ to: addr(client.pkh), amount: 100000n - REFUND_FEE }],
  });
});

await t('14 CHEAT provider cannot refund the pod to itself', async () => {
  const { net, contract } = newPod();
  net.setBlockHeight(Number(VALID_UNTIL));
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'refund', args: [provider.pub, provider.sig], inputs: [u], time: VALID_UNTIL,
    outs: [{ to: addr(provider.pkh), amount: 100000n - REFUND_FEE }],
  }));
});

await t('15 mutual close: provider paid, client made whole', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await spend(net, contract, {
    fn: 'close', args: [client.pub, client.sig, provider.pub, provider.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: addr(client.pkh), amount: 100000n - 20000n - CLOSE_FEE }],
  });
});

await t('16 CHEAT close with one signature reused for both roles rejected', async () => {
  const { net, contract } = newPod();
  const u = fund(net, contract, 100000n);
  await mustReject(() => spend(net, contract, {
    fn: 'close', args: [client.pub, client.sig, provider.pub, client.sig], inputs: [u],
    outs: [{ to: addr(provider.pkh), amount: 20000n }, { to: addr(client.pkh), amount: 100000n - 20000n - CLOSE_FEE }],
  }));
});

// --- report -------------------------------------------------------------
console.log('\nChunkPod covenant — executed against the real BCH VM (libauth via CashScript 0.14)\n');
let failed = 0;
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${status}  ${name}${msg ? `\n        → ${msg}` : ''}`);
  if (status === 'FAIL') failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passing\n`);
process.exit(failed ? 1 : 0);
