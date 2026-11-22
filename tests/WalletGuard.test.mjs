/**
 * tests/WalletGuard.test.mjs — the promise the wallet path makes, tested.
 *
 * Foreman's wallet flow says: "the server re-checks what the wallet signed and
 * refuses to broadcast anything that does not pay the pod the exact amount."
 * That is a security claim, so it gets tests — offline, against the real BCH VM,
 * with no relay and no network.
 *
 *   npm test        # runs both suites
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToBin, binToHex, encodeTransaction, decodeTransaction, secp256k1,
  hash160, deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative,
  deriveHdPublicNode, encodeHdPublicKey, addressContentsToLockingBytecode,
} from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';
import {
  buildWalletFundFromSources, verifySignedSpend, keyFromSeedHex, podAddress, redeemLockingOf,
} from '../lib.mjs';
import { WalletSession } from '../wallet.mjs';

// ---------------------------------------------------------------- fixtures
const client = keyFromSeedHex('11'.repeat(32), 0);
const provider = keyFromSeedHex('22'.repeat(32), 0);
const stranger = keyFromSeedHex('33'.repeat(32), 0);

const POD = {
  clientPkh: client.pkh,
  providerPkh: provider.pkh,
  chunk: 20000n,
  window: 60000n,
  validUntil: 400000n,
};

const lockOf = (key) => binToHex(addressContentsToLockingBytecode({ type: 'P2PKH', payload: key.pkh }));
const ADDRESS = 'bchtest:zpaee8uy3s030xs5tvtaxaq4husz5z2dhv6qr3p0kp';

/** A wallet with two coins, both owned by `key`. */
const coins = (key, values = [400000n, 300000n]) => values.map((satoshis, i) => ({
  txid: String(i + 1).repeat(64).slice(0, 64),
  vout: i,
  satoshis,
  lockingBytecode: lockOf(key),
  address: ADDRESS,
}));

const build = (overrides = {}) => buildWalletFundFromSources({
  pod: POD,
  network: 'chipnet',
  sources: coins(client),
  funderAddresses: [ADDRESS],
  changeAddress: ADDRESS,
  satoshis: 150000n,
  ...overrides,
});

/**
 * Sign like a wallet would. `mutate` runs BEFORE signing, which models a
 * dishonest wallet that signs a transaction of its own choosing — the case the
 * server-side guardrail exists to catch.
 */
const signWith = (fund, key, { mutate } = {}) => {
  const unsigned = decodeTransaction(hexToBin(fund.txHex));
  let outputs = unsigned.outputs;
  if (mutate) ({ outputs } = mutate({ outputs, tx: { outputs: unsigned.outputs } }));
  const tx = { version: 2, inputs: unsigned.inputs, outputs, locktime: 0 };
  const inputs = tx.inputs.map((input, i) => ({
    ...input,
    unlockingBytecode: new SignatureTemplate(key.priv)
      .unlockP2PKH()
      .generateUnlockingBytecode({ transaction: tx, sourceOutputs: fund.sourceOutputs, inputIndex: i }),
  }));
  return binToHex(encodeTransaction({ ...tx, inputs }));
};

const expectOk = (txHex) => verifySignedSpend({
  txHex, pod: POD, network: 'chipnet',
  expect: { sourceOutputs: build().sourceOutputs, amount: 150000n },
});

// ---------------------------------------------------------------- tests
describe('funding builder', () => {
  it('1 · pays the pod the requested amount and returns the rest as change', () => {
    const fund = build();
    assert.equal(fund.tx.outputs.length, 2);
    assert.equal(fund.tx.outputs[0].valueSatoshis, 150000n);
    assert.equal(binToHex(fund.tx.outputs[0].lockingBytecode), binToHex(redeemLockingOf(podAddress(POD, 'chipnet'))));
    assert.equal(fund.tx.outputs[1].valueSatoshis, BigInt(fund.change));
    const inTotal = fund.sourceOutputs.reduce((a, s) => a + BigInt(s.valueSatoshis), 0n);
    const outTotal = fund.tx.outputs.reduce((a, o) => a + o.valueSatoshis, 0n);
    assert.equal(inTotal - outTotal, BigInt(fund.fee)); // every satoshi is accounted for
  });

  it('2 · picks the fewest coins that cover amount + fee', () => {
    const fund = build();
    assert.equal(fund.spends.length, 1);
    assert.equal(fund.spends[0].satoshis, '400000');
  });

  it('3 · refuses when the wallet cannot cover the funding plus fee', () => {
    assert.throws(() => build({ satoshis: 10_000_000n }), /wallet holds 700000 sat/);
  });

  it('4 · refuses to build with no coins rather than sending an empty transaction', () => {
    assert.throws(() => build({ sources: [] }), /wallet holds 0 sat/);
  });

  it('5 · change below dust fails loudly instead of creating an unspendable output', () => {
    assert.throws(() => build({ satoshis: 699_900n }), /too small|holds/);
  });

  it('6 · the relay payload is bigint-safe (how the protocol carries sats)', () => {
    const fund = build();
    for (const so of fund.relaySourceOutputs) {
      assert.match(so.valueSatoshis, /^<bigint: \d+n>$/);
      assert.equal(typeof so.outpointTransactionHash, 'string');
      assert.equal(so.lockingBytecode, lockOf(client));
    }
  });
});

describe('guardrail: what the wallet is allowed to return', () => {
  it('7 · accepts an honest signature', () => {
    const ok = expectOk(signWith(build(), client));
    assert.equal(ok.vmPassed, true);
    assert.equal(ok.outputs[0].value, '150000');
  });

  it('8 · rejects a wallet that signs a different amount into the pod', () => {
    const fund = build();
    const txHex = signWith(fund, client, {
      mutate: ({ outputs }) => ({
        outputs: [
          { ...outputs[0], valueSatoshis: 1000n },
          { ...outputs[1], valueSatoshis: outputs[1].valueSatoshis + 149000n },
        ],
      }),
    });
    assert.throws(
      () => verifySignedSpend({ txHex, pod: POD, network: 'chipnet', expect: { sourceOutputs: fund.sourceOutputs, amount: 150000n } }),
      /pod output is 1000 sat, expected 150000/,
    );
  });

  it('9 · rejects a wallet that pays a different pod (address substitution)', () => {
    const fund = build();
    const otherPod = { ...POD, chunk: 30000n }; // same keys, different terms → different address
    const txHex = signWith(fund, client, {
      mutate: ({ outputs }) => ({
        outputs: [{ ...outputs[0], lockingBytecode: redeemLockingOf(podAddress(otherPod, 'chipnet')) }, outputs[1]],
      }),
    });
    assert.throws(
      () => verifySignedSpend({ txHex, pod: POD, network: 'chipnet', expect: { sourceOutputs: fund.sourceOutputs, amount: 150000n } }),
      /does not pay the pod/,
    );
  });

  it('10 · rejects bytes with no valid signature (tampered after signing)', () => {
    const fund = build();
    const signed = signWith(fund, client);
    // flip a byte deep inside the first input's unlocking bytecode
    const bytes = hexToBin(signed);
    bytes[12] ^= 0xff;
    assert.throws(
      () => verifySignedSpend({ txHex: binToHex(bytes), pod: POD, network: 'chipnet', expect: { sourceOutputs: fund.sourceOutputs, amount: 150000n } }),
      /signature check|does not pay/,
    );
  });

  it('11 · rejects a transaction signed by someone else’s key', () => {
    const fund = build();
    const txHex = signWith({ ...fund, sourceOutputs: fund.sourceOutputs }, stranger);
    assert.throws(
      () => verifySignedSpend({ txHex, pod: POD, network: 'chipnet', expect: { sourceOutputs: fund.sourceOutputs, amount: 150000n } }),
      /signature check|does not pay/,
    );
  });

  it('12 · without an amount expectation the pod output is still required', () => {
    const fund = build();
    assert.doesNotThrow(() => verifySignedSpend({
      txHex: signWith(fund, client), pod: POD, network: 'chipnet',
      expect: { sourceOutputs: fund.sourceOutputs }, // no `amount`
    }));
    // …and a transaction that pays something else entirely still fails
    const otherPod = { ...POD, chunk: 30000n };
    const txHex = signWith(fund, client, {
      mutate: ({ outputs }) => ({
        outputs: [{ ...outputs[0], lockingBytecode: redeemLockingOf(podAddress(otherPod, 'chipnet')) }, outputs[1]],
      }),
    });
    assert.throws(
      () => verifySignedSpend({ txHex, pod: POD, network: 'chipnet', expect: { sourceOutputs: fund.sourceOutputs } }),
      /does not pay the pod/,
    );
  });

  it('13 · the VM check is real: a spend of a coin you do not own fails', () => {
    const fund = build();
    const unsigned = decodeTransaction(hexToBin(fund.txHex));
    // claim the coin belongs to us but present the stranger's signature
    const tx = { version: 2, inputs: unsigned.inputs, outputs: unsigned.outputs, locktime: 0 };
    const inputs = tx.inputs.map((input, i) => ({
      ...input,
      unlockingBytecode: new SignatureTemplate(stranger.priv).unlockP2PKH()
        .generateUnlockingBytecode({ transaction: tx, sourceOutputs: fund.sourceOutputs, inputIndex: i }),
    }));
    assert.throws(
      () => verifySignedSpend({
        txHex: binToHex(encodeTransaction({ ...tx, inputs })), pod: POD, network: 'chipnet',
        expect: { sourceOutputs: fund.sourceOutputs, amount: 150000n },
      }),
      /signature check|does not pay/,
    );
  });
});

describe('xpub path (read-only pairing)', () => {
  const xpub = (() => {
    const root = deriveHdPrivateNodeFromSeed(hexToBin('11'.repeat(32)), true);
    const branch = deriveHdPath(root, "m/44'/145'/0'/0");
    return encodeHdPublicKey({ node: deriveHdPublicNode(branch), network: 'mainnet' }).hdPublicKey;
  })();

  it('14 · derives the same addresses a wallet would for the same xpub', () => {
    const session = new WalletSession();
    const derived = session.xpubAddresses(xpub, 'chipnet', 2).map((a) => a.address);
    const expected = [0, 1].map((i) => {
      const root = deriveHdPrivateNodeFromSeed(hexToBin('11'.repeat(32)), true);
      const child = deriveHdPathRelative(deriveHdPath(root, "m/44'/145'/0'/0"), String(i));
      const pkh = hash160(secp256k1.derivePublicKeyCompressed(child.privateKey));
      return pkh;
    });
    const got = session.xpubAddresses(xpub, 'chipnet', 2).map((a) => binToHex(a.pkh));
    assert.deepEqual(got, expected.map(binToHex));
    assert.equal(derived.length, 2);
  });

  it('15 · rejects something that is not an xpub', () => {
    const session = new WalletSession();
    assert.throws(() => session.xpubAddresses('not-an-xpub', 'chipnet', 1), /not an xpub/);
  });

  it('16 · an xpub alone cannot sign — the session says so instead of pretending', async () => {
    const session = new WalletSession();
    session.xpub = xpub;
    assert.equal(session.status().mode, 'xpub-read-only');
    await assert.rejects(
      session.sign({ transaction: {}, inputPaths: [] }),
      /no wallet paired yet/,
    );
  });
});

// ---------------------------------------------------------------- helpers
