/**
 * tests/ReconcileWalk.test.mjs — the transaction walk itself, offline.
 *
 * `tests/Reconcile.test.mjs` pins the comparison with the books. This pins the part
 * that matters more: classifying real transactions into funding / delivery / close,
 * and refusing to invent numbers when the chain tells it nothing.
 *
 * No relay and no network: `reconcilePod` takes a provider override, so a fake
 * indexer serving hand-built transactions exercises the same code path the live
 * app uses. This is the test that would have caught the three bugs that made the
 * first version report "0/2 pods reconcile".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToBin, binToHex, encodeLockingBytecodeP2pkh, encodeTransaction,
  sha256,
} from '@bitauth/libauth';
import { reconcilePod, keyFromSeedHex } from '../lib.mjs';

const client = keyFromSeedHex('11'.repeat(32), 0);
const provider = keyFromSeedHex('22'.repeat(32), 0);
const POD = {
  clientPkh: client.pkh,
  providerPkh: provider.pkh,
  chunk: 20000n,
  window: 60000n,
  validUntil: 400000n,
};

const lockP2pkh = (pkh) => encodeLockingBytecodeP2pkh(pkh);
const outpoint = (txid) => Uint8Array.from(Buffer.from(txid, 'hex'));

/** Build a transaction touching known lockings. Value in is declared, not derived. */
function tx({ inputs = [], outputs = [] }) {
  const t = {
    version: 2,
    locktime: 0,
    inputs: inputs.map((i) => ({
      outpointTransactionHash: outpoint(i.txid),
      outpointIndex: i.vout,
      unlockingBytecode: new Uint8Array([]),
      sequenceNumber: 0xffffffff,
    })),
    outputs: outputs.map((o) => ({ lockingBytecode: o.lock, valueSatoshis: o.value })),
  };
  const encoded = encodeTransaction(t);
  return { tx: t, txid: binToHex(sha256.hash(encoded)), hex: binToHex(encoded) };
}

/**
 * A fake indexer: history per script hash, raw transactions by txid.
 * Only the two calls `reconcilePod` makes are implemented — that is the point.
 */
function fakeProvider({ history, raws, utxos = [] }) {
  return {
    performRequest: async (method, scriptHash) => {
      assert.equal(method, 'blockchain.scripthash.get_history');
      return history[scriptHash] ?? [];
    },
    getRawTransaction: async (txid) => {
      if (!raws[txid]) throw new Error(`no such tx ${txid}`);
      return raws[txid];
    },
    getUtxos: async () => utxos,
  };
}

/** Assemble a ledger of transactions plus the indexer that can serve them. */
function chain(parts) {
  const raws = {};
  const entries = [];
  for (const p of parts) {
    raws[p.txid] = p.hex;
    entries.push({ tx_hash: p.txid, height: 1 });
  }
  return { raws, entries };
}

// The pod's locking bytecode, obtained the same way the app gets it.
const { podContract } = await import('../lib.mjs');
// CashScript hands back a hex string here; `encodeTransaction` wants bytes, and
// passing the string encodes the ASCII of its characters — a trap worth one comment.
const podLock = () => Uint8Array.from(Buffer.from(podContract(POD, 'chipnet').contract.lockingBytecode, 'hex'));
const podScriptHash = binToHex(sha256.hash(podLock()).slice().reverse());

test('a funding tx, two deliveries and a top-up are classified and balance exactly', async () => {
  const CLIENT = lockP2pkh(client.pkh);
  const PROV = lockP2pkh(provider.pkh);

  const fund = tx({ inputs: [{ txid: 'aa'.repeat(32), vout: 0 }], outputs: [{ lock: podLock(), value: 100000n }] });
  // delivery: spends the pod coin, pays 20000 to provider, 700 fee, rest back to pod
  const d1 = tx({
    inputs: [{ txid: fund.txid, vout: 0 }],
    outputs: [{ lock: PROV, value: 20000n }, { lock: podLock(), value: 79300n }],
  });
  const d2 = tx({
    inputs: [{ txid: d1.txid, vout: 1 }],
    outputs: [{ lock: PROV, value: 20000n }, { lock: podLock(), value: 58600n }],
  });
  // close: pays the last chunk and returns the remainder to the client
  const close = tx({
    inputs: [{ txid: d2.txid, vout: 1 }],
    outputs: [{ lock: PROV, value: 20000n }, { lock: CLIENT, value: 37800n }],
  });

  const { raws, entries } = chain([fund, d1, d2, close]);
  const fake = fakeProvider({ history: { [podScriptHash]: entries }, raws });

  const r = await reconcilePod({ pod: POD, network: 'chipnet' }, fake);
  assert.equal(r.funded, 100000n);
  assert.equal(r.paid, 60000n, 'three chunks reached the provider, including the one inside close()');
  assert.equal(r.fees, 2200n, '700 + 700 + 800, counted from the transactions themselves');
  assert.equal(r.refunded, 37800n);
  assert.equal(r.held, 0n);
  assert.equal(r.deliveries, 2);
  assert.equal(r.closing, 1);
  assert.equal(r.balances, true);
  assert.equal(r.elsewhere, 0n);
  assert.equal(r.funded, r.paid + r.fees + r.refunded + r.held, 'the identity, checked explicitly');
});

test('an empty pod reports zero and still balances', async () => {
  const fake = fakeProvider({ history: {}, raws: {} });
  const r = await reconcilePod({ pod: POD, network: 'chipnet' }, fake);
  assert.equal(r.funded, 0n);
  assert.equal(r.paid, 0n);
  assert.equal(r.held, 0n);
  assert.equal(r.balances, true, 'zero = zero is a balance, not a gap');
});

test('a pruned transaction is skipped, never guessed at', async () => {
  const PROV = lockP2pkh(provider.pkh);
  const fund = tx({ inputs: [{ txid: 'aa'.repeat(32), vout: 0 }], outputs: [{ lock: podLock(), value: 50000n }] });
  const { raws, entries } = chain([fund]);
  entries.push({ tx_hash: 'de'.repeat(32), height: 1 }); // indexer knows it, relay does not have it
  const fake = fakeProvider({ history: { [podScriptHash]: entries }, raws });

  const r = await reconcilePod({ pod: POD, network: 'chipnet' }, fake);
  assert.equal(r.funded, 50000n, 'the readable transaction is still counted');
  assert.equal(r.anomalies.length, 0, 'a pruned tx is not an anomaly, it is missing data');
  void PROV;
});

test('money paid to a third party is separated out and named', async () => {
  const PROV = lockP2pkh(provider.pkh);
  const stranger = lockP2pkh(keyFromSeedHex('33'.repeat(32), 0).pkh);
  const fund = tx({ inputs: [{ txid: 'aa'.repeat(32), vout: 0 }], outputs: [{ lock: podLock(), value: 100000n }] });
  // A spend that pays the provider, a stranger, and nothing back to the pod.
  const steal = tx({
    inputs: [{ txid: fund.txid, vout: 0 }],
    outputs: [{ lock: PROV, value: 20000n }, { lock: stranger, value: 30000n }],
  });
  const { raws, entries } = chain([fund, steal]);
  const fake = fakeProvider({ history: { [podScriptHash]: entries }, raws });

  const r = await reconcilePod({ pod: POD, network: 'chipnet' }, fake);
  assert.equal(r.elsewhere, 30000n);
  assert.equal(r.anomalies.length, 1);
  assert.match(r.anomalies[0].why, /neither party/);
  // Money going to a stranger means the reconstruction cannot add up unless the
  // exit is named — which is the whole reason `elsewhere` exists.
  assert.equal(r.balances, true);
});
