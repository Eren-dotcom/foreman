/**
 * Reconciliation tests — offline, no relays, no network.
 *
 * The point of reconciliation is that a *total* is not evidence. These tests fix
 * the arithmetic and the classification rules against hand-built histories, so a
 * future change cannot quietly turn a real gap into a green tick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareToLedger } from '../lib.mjs';

const T = (s) => s.padEnd(64, '0');

/** A synthetic settlement, shaped exactly like reconcilePod's return value. */
const settlement = (over = {}) => ({
  funded: 0n, paid: 0n, refunded: 0n, fees: 0n, elsewhere: 0n, held: 0n,
  deliveries: 0, closing: 0, topUps: 0,
  fundingTxids: [], spendTxids: [], anomalies: [], fundings: [], spends: [],
  utxoCount: 0, txs: 0, balances: true,
  ...over,
});

test('the identity closes: funded = paid + fees + refunded + elsewhere + held', () => {
  const s = settlement({ funded: 350000n, paid: 60000n, fees: 2100n, held: 287900n });
  assert.equal(s.funded, s.paid + s.fees + s.refunded + s.elsewhere + s.held);
});

test('a close that pays the last chunk is still a payment, not a refund alone', () => {
  // 100000 in; three 20000 deliveries; close pays 20000 + returns 17100, fee 2900.
  const s = settlement({
    funded: 100000n, paid: 80000n, refunded: 17100n, fees: 2900n, held: 0n,
    deliveries: 3, closing: 1,
  });
  assert.equal(s.funded, s.paid + s.fees + s.refunded + s.held);
});

test('money leaving to a third party breaks the identity and is reported, not hidden', () => {
  const s = settlement({ funded: 100000n, paid: 20000n, elsewhere: 30000n, held: 50000n });
  assert.equal(s.funded, s.paid + s.fees + s.refunded + s.elsewhere + s.held);
  // The same history without the "elsewhere" term must NOT balance — that is the
  // whole reason the term exists rather than being folded into a gap.
  assert.notEqual(s.funded, s.paid + s.fees + s.refunded + s.held);
});

test('a top-up is funding, and the books that missed it are caught', () => {
  const chain = settlement({
    funded: 350000n, paid: 60000n, fees: 2100n, held: 287900n,
    topUps: 1, fundingTxids: [T('a1'), T('b2')], spendTxids: [T('c3'), T('d4'), T('e5')],
    spends: [
      { txid: T('c3'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('d4'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('e5'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
    ],
  });
  const job = {
    id: 'job_x', events: [
      { kind: 'fund', satoshis: '250000', txid: T('a1').slice(0, 8) },
      { kind: 'deliver', txid: T('c3').slice(0, 8) },
      { kind: 'deliver', txid: T('d4').slice(0, 8) },
    ],
    receipts: [{ txid: T('c3'), paidSats: '20000' }, { txid: T('d4'), paidSats: '20000' }],
  };
  const ledger = compareToLedger(chain, job);
  assert.equal(ledger.agrees, false);
  assert.equal(ledger.unrecordedOnChain.length, 2, 'the top-up and the third delivery are unbooked');
  assert.equal(ledger.unbookedPayouts.length, 1);
  assert.match(ledger.unbookedPayouts[0].why, /never mentions/);
});

test('a payout recorded under another name is named, not merely counted', () => {
  const chain = settlement({
    funded: 100000n, paid: 80000n, refunded: 17100n, fees: 2900n,
    spends: [
      { txid: T('c3'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('d4'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('e5'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('f6'), toProvider: 20000n, toClient: 17100n, remainderBack: 0n, fee: 800n, kind: 'close' },
    ],
  });
  const job = {
    id: 'job_y',
    events: [
      { kind: 'fund', satoshis: '100000', txid: T('a1').slice(0, 8) },
      { kind: 'deliver', txid: T('c3').slice(0, 8) },
      { kind: 'deliver', txid: T('d4').slice(0, 8) },
      { kind: 'deliver', txid: T('e5').slice(0, 8) },
      { kind: 'close', txid: T('f6').slice(0, 8) },
    ],
    receipts: [
      { txid: T('c3'), paidSats: '20000' },
      { txid: T('d4'), paidSats: '20000' },
      { txid: T('e5'), paidSats: '20000' },
    ],
  };
  const ledger = compareToLedger(chain, job);
  assert.equal(ledger.agrees, false, 'books claim 60000 paid, chain paid 80000');
  assert.equal(ledger.unbookedPayouts.length, 1);
  assert.equal(ledger.unbookedPayouts[0].recordedAs, 'close');
  assert.equal(ledger.unbookedPayouts[0].paidProvider, '20000');
  assert.match(ledger.unbookedPayouts[0].why, /no receipt/);
});

test('a transaction the books claim but the chain does not have is flagged', () => {
  const chain = settlement({
    funded: 100000n, paid: 20000n, fees: 700n, held: 79300n,
    fundingTxids: [T('a1')], spendTxids: [T('c3')],
    spends: [{ txid: T('c3'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' }],
  });
  const job = {
    events: [
      { kind: 'fund', satoshis: '100000', txid: T('a1').slice(0, 8) },
      { kind: 'deliver', txid: T('c3').slice(0, 8) },
      { kind: 'deliver', txid: 'deadbeef' },
    ],
    receipts: [{ txid: T('c3'), paidSats: '20000' }, { txid: 'deadbeef', paidSats: '20000' }],
  };
  const ledger = compareToLedger(chain, job);
  assert.deepEqual(ledger.claimedButNotOnChain, ['deadbeef']);
  assert.equal(ledger.agrees, false);
});

test('when the books are right, reconciliation says so without ceremony', () => {
  const chain = settlement({
    funded: 100000n, paid: 60000n, fees: 2100n, held: 37900n,
    fundingTxids: [T('a1')], spendTxids: [T('c3'), T('d4'), T('e5')],
    spends: [
      { txid: T('c3'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('d4'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
      { txid: T('e5'), toProvider: 20000n, toClient: 0n, remainderBack: 0n, fee: 700n, kind: 'deliver' },
    ],
  });
  const job = {
    events: [
      { kind: 'fund', satoshis: '100000', txid: T('a1').slice(0, 8) },
      { kind: 'deliver', txid: T('c3').slice(0, 8) },
      { kind: 'deliver', txid: T('d4').slice(0, 8) },
      { kind: 'deliver', txid: T('e5').slice(0, 8) },
    ],
    receipts: [
      { txid: T('c3'), paidSats: '20000' },
      { txid: T('d4'), paidSats: '20000' },
      { txid: T('e5'), paidSats: '20000' },
    ],
  };
  const ledger = compareToLedger(chain, job);
  assert.equal(ledger.agrees, true);
  assert.equal(ledger.unbookedPayouts.length, 0);
  assert.equal(ledger.unrecordedOnChain.length, 0);
  assert.equal(ledger.claimedButNotOnChain.length, 0);
});

test('an empty pod reconciles trivially instead of reporting a phantom gap', () => {
  const ledger = compareToLedger(settlement(), { events: [], receipts: [] });
  assert.equal(ledger.agrees, true);
  assert.equal(ledger.unrecordedOnChain.length, 0);
  assert.equal(ledger.claimedButNotOnChain.length, 0);
});
