/**
 * tests/Guard.test.mjs — the pre-execution guard, tested offline.
 *
 * The important property is not "it blocks bad intents". It is that the guard can
 * never approve something the covenant would refuse: every deny case below is also
 * a refusal the contract produces, and the guard's reason codes match the VM's
 * rule ids in lib.mjs RULES, so the two can be compared by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judge, intentId, INTENT_RULES } from '../guard.mjs';

const POD = {
  chunk: 20000n,
  window: 60000n,
  balance: '100000',
  blocksToExpiry: 20,
  blockHeight: 340000,
  providerAddress: 'bchtest:zqug9udc45dur0pwhehdr7wn76htvurwvcvuzclgll',
};

const base = { pod: 'bchtest:pw9lll4pcv6a9v69adqhxjmv0jz996pt0vnk6s3rd20h9yq7cd3yzwssceh4y', action: 'deliver', amount: 20000 };

describe('guard · the happy path', () => {
  it('1 · a whole chunk inside the window passes, with an effect the caller can preview', () => {
    const r = judge({ intent: base, pod: POD });
    assert.equal(r.decision, 'pass');
    assert.equal(r.effect.podBalanceAfter, '79300'); // 100000 − 20000 − 700
    assert.match(r.detail, /final authority/);
  });

  it('2 · every rule is reported, not just the first failure', () => {
    const r = judge({ intent: base, pod: POD });
    assert.equal(r.rules.length, INTENT_RULES.length);
    assert.ok(r.rules.every((x) => x.outcome === 'pass' || x.outcome === 'skipped'));
  });

  it('3 · a pull at exactly the window passes — the boundary is real, not decorative', () => {
    assert.equal(judge({ intent: { ...base, amount: 60000 }, pod: POD }).decision, 'pass');
  });
});

describe('guard · refuses what the covenant would refuse', () => {
  const denied = (intent, pod = POD) => judge({ intent, pod });

  it('4 · over the window → deliver.window', () => {
    const r = denied({ ...base, amount: 80000 });
    assert.equal(r.decision, 'deny');
    assert.equal(r.code, 'deliver.window');
    assert.match(r.detail, /Split it into 2 transactions/);
  });

  it('5 · partial chunk → deliver.whole-chunks', () => {
    assert.equal(denied({ ...base, amount: 30000 }).code, 'deliver.whole-chunks');
  });

  it('6 · more than the pod holds → deliver.overdraw (within the window)', () => {
    // 60000 is inside the window, so the first thing wrong with it is the balance
    assert.equal(denied({ ...base, amount: 60000 }, { ...POD, balance: '40000' }).code, 'deliver.overdraw');
  });

  it('7 · paying the wrong address → deliver.payee-pinned', () => {
    const r = denied({ ...base, payTo: 'bchtest:zzzjunk' });
    assert.equal(r.code, 'deliver.payee-pinned');
  });

  it('8 · early refund → refund.not-expired', () => {
    assert.equal(denied({ ...base, action: 'refund', amount: undefined }).code, 'refund.not-expired');
    const expired = { ...POD, blocksToExpiry: 0 };
    assert.equal(judge({ intent: { ...base, action: 'refund', amount: undefined }, pod: expired }).decision, 'pass');
  });

  it('9 · unknown action → intent.malformed, with the known actions listed', () => {
    const r = denied({ ...base, action: 'sudo' });
    assert.equal(r.code, 'intent.malformed');
    assert.match(r.reason, /deliver, close, refund, fund/);
  });
});

describe('guard · refuses the things a covenant cannot see', () => {
  it('10 · a float amount is a unit bug, not a rounding detail', () => {
    assert.equal(judge({ intent: { ...base, amount: 20000.5 }, pod: POD }).code, 'intent.amount-shape');
  });

  it('11 · wei-shaped string amounts are caught before they hit a satoshi contract', () => {
    assert.equal(judge({ intent: { ...base, amount: '20000000000000000000' }, pod: POD }).decision, 'deny');
  });

  it('12 · stale state is denied, because another delivery may have spent the budget', () => {
    const r = judge({ intent: { ...base, observedHeight: 339900 }, pod: POD });
    assert.equal(r.code, 'intent.stale');
    assert.match(r.reason, /100 blocks old/);
  });

  it('13 · a replayed intent id is denied — retries must mint a new id', () => {
    const id = intentId(base);
    const seen = new Set([id]);
    assert.equal(judge({ intent: { ...base, id }, pod: POD, seen }).code, 'intent.replay');
    assert.equal(judge({ intent: { ...base, id }, pod: { ...POD }, seen: new Set() }).decision, 'pass');
  });

  it('14 · intent ids are stable for the same intent and differ when anything material changes', () => {
    assert.equal(intentId(base), intentId({ ...base }));
    assert.notEqual(intentId(base), intentId({ ...base, amount: 40000 }));
    assert.match(intentId(base), /^int_[0-9a-f]{8}$/);
  });
});

describe('guard · honesty about what it does not know', () => {
  it('15 · with no balance supplied, the overdraw rule is skipped rather than assumed safe', () => {
    const r = judge({ intent: { ...base, amount: 60000 }, pod: { ...POD, balance: undefined } });
    assert.equal(r.decision, 'pass');
    assert.ok(r.rules.find((x) => x.code === 'deliver.overdraw').outcome === 'skipped');
    assert.equal(r.effect.podBalanceAfter, null);
  });

  it('16 · with no provider address supplied, payee pinning cannot be checked and is skipped', () => {
    const r = judge({ intent: { ...base, payTo: 'anything' }, pod: { ...POD, providerAddress: undefined } });
    assert.equal(r.decision, 'pass', 'an unverifiable payee must not become a silent approval of the wrong one');
    assert.ok(r.rules.find((x) => x.code === 'deliver.payee-pinned').outcome === 'pass');
    // …but the covenant still pins it, so a wrong payee can never actually settle
    assert.equal(judge({ intent: { ...base, payTo: 'wrong' }, pod: POD }).code, 'deliver.payee-pinned');
  });

  it('17 · a passing guard always says the covenant still decides', () => {
    assert.match(judge({ intent: base, pod: POD }).detail, /covenant remains the final authority/);
  });
});
