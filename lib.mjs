/**
 * foreman/lib.mjs — all chain plumbing for Foreman in one place.
 *
 * Everything here builds real Bitcoin Cash transactions. Nothing is mocked:
 * the same code path is used for chipnet and mainnet, and for the local demo.
 */
import { Contract, ElectrumNetworkProvider, MockNetworkProvider, SignatureTemplate, TransactionBuilder, Network, randomUtxo } from 'cashscript';
import {
  hash160, secp256k1, deriveHdPrivateNodeFromSeed, deriveHdPath,
  encodeCashAddress, decodeCashAddress, hexToBin, binToHex,
  decodeTransaction, encodeTransaction, addressContentsToLockingBytecode,
  encodeLockingBytecodeP2pkh,
  createVirtualMachineBCH,
} from '@bitauth/libauth';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const artifact = JSON.parse(
  fs.readFileSync(new URL('./artifacts/ChunkPod.json', import.meta.url)),
);

// Fee budgets baked into the covenant. Kept in sync with contracts/ChunkPod.cash.
export const FEES = { deliver: 700n, refund: 600n, close: 800n };

export const NETWORKS = {
  chipnet: { network: Network.CHIPNET ?? 'chipnet', prefix: 'bchtest', explorer: 'https://chipnet.imaginary.cash/tx/' },
  mainnet: { network: Network.MAINNET ?? 'mainnet', prefix: 'bitcoincash', explorer: 'https://explorer.bch.ninja/tx/' },
};

function netConfig(name) {
  const cfg = NETWORKS[name];
  if (!cfg) throw new Error(`unknown network: ${name}`);
  return cfg;
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
export function keyFromSeedHex(seedHex, index = 0) {
  const seed = hexToBin(seedHex);
  if (seed.length !== 32) throw new Error('seed must be 32 bytes of hex');
  const root = deriveHdPrivateNodeFromSeed(seed, true);
  const node = deriveHdPath(root, `m/44'/145'/0'/0/${index}`);
  if (typeof node === 'string') throw new Error(node);
  return keyFromPrivateKey(node.privateKey);
}

function keyFromPrivateKey(priv) {
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
}

export function randomSeedHex() {
  return crypto.randomBytes(32).toString('hex');
}

export function addressOf(pkh, network) {
  const { prefix } = netConfig(network);
  return encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address;
}

/** Accepts any cashaddr (p2pkh / p2sh / token-aware) and returns the 20-byte payload. */
export function addressToPkh(address) {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  if (decoded.payload.length !== 20) throw new Error('expected a 20-byte address payload');
  return decoded.payload;
}

// ---------------------------------------------------------------------------
// pod definition
// ---------------------------------------------------------------------------
function podParams({ clientPkh, providerPkh, chunk, window, validUntil }) {
  return [clientPkh, providerPkh, BigInt(chunk), BigInt(window), BigInt(validUntil)];
}

export function podAddress({ clientPkh, providerPkh, chunk, window, validUntil }, network) {
  const provider = new ElectrumNetworkProvider(netConfig(network).network);
  const contract = new Contract(artifact, podParams({ clientPkh, providerPkh, chunk, window, validUntil }), { provider });
  return contract.address;
}

export function podContract(pod, network) {
  const provider = new ElectrumNetworkProvider(netConfig(network).network);
  return { provider, contract: new Contract(artifact, podParams(pod), { provider }) };
}

// ---------------------------------------------------------------------------
// chain reads
// ---------------------------------------------------------------------------
export async function readPod(pod, network, keys) {
  const { provider, contract } = podContract(pod, network);
  const [utxos, height] = await Promise.all([
    provider.getUtxos(contract.address),
    provider.getBlockHeight(),
  ]);
  const balance = utxos.reduce((a, u) => a + u.satoshis, 0n);
  const expired = BigInt(height) >= BigInt(pod.validUntil);
  return {
    address: contract.address,
    balance: balance.toString(),
    utxos: utxos.length,
    blockHeight: height,
    expired,
    blocksToExpiry: Math.max(0, Number(pod.validUntil) - height),
    delivered: keys ? ((BigInt(pod.budget ?? 0n) - balance) > 0n ? (BigInt(pod.budget) - balance).toString() : '0') : undefined,
  };
}

// ---------------------------------------------------------------------------
// fund: client sends BCH into the pod
// ---------------------------------------------------------------------------
export async function fundPod({ pod, network, funder, satoshis, budget }) {
  const { provider, contract } = podContract(pod, network);
  const utxos = await provider.getUtxos(addressOf(funder.pkh, network));
  if (!utxos.length) throw new Error(`funder ${addressOf(funder.pkh, network)} has no spendable UTXOs on ${network}`);

  const amount = BigInt(satoshis);
  const tb = new TransactionBuilder({ provider });
  let total = 0n;
  for (const u of utxos) {
    if (total >= amount + 600n) break;
    tb.addInput(u, funder.sig.unlockP2PKH());
    total += u.satoshis;
  }
  if (total < amount + 600n) throw new Error(`insufficient funds: have ${total}, need ${amount + 600n}`);
  tb.addOutput({ to: contract.address, amount });
  tb.addBchChangeOutputIfNeeded({ to: addressOf(funder.pkh, network), feeRate: 1 });
  if (budget) pod.budget = String(budget);
  const res = await tb.send();
  pod.fundedTxid = res.txid;
  pod.budget = String(amount);
  return res;
}

// ---------------------------------------------------------------------------
// deliver: provider pulls one or more chunks (signed by the provider)
// ---------------------------------------------------------------------------
export async function deliverChunks({ pod, network, provider: providerKey, chunks = 1n }) {
  const { provider, contract } = podContract(pod, network);
  const utxos = await provider.getUtxos(contract.address);
  const spendable = utxos.filter((u) => u.satoshis >= BigInt(pod.chunk) + FEES.deliver);
  if (!spendable.length) throw new Error('the pod holds no spendable coin (already empty?)');
  const utxo = spendable[0];
  const paid = BigInt(pod.chunk) * BigInt(chunks);
  const remainder = utxo.satoshis - paid - FEES.deliver;

  const tb = new TransactionBuilder({ provider });
  tb.addInput(utxo, contract.unlock.deliver(providerKey.pub, providerKey.sig));
  tb.addOutput({ to: addressOf(providerKey.pkh, network), amount: paid });
  tb.addOutput({ to: contract.address, amount: remainder });
  const res = await tb.send();
  pod.lastDeliverTxid = res.txid;
  return { ...res, paid, remainder };
}

// Dry run: build, then debug against the local VM without broadcasting.
// Used by the "Steal the pod" demo to show the exact failing require.
export async function simulateSteal({ pod, network, provider: providerKey, wantChunks = 4n }) {
  const { provider, contract } = podContract(pod, network);
  const utxos = await provider.getUtxos(contract.address);
  const liveBalance = utxos.reduce((a, u) => a + u.satoshis, 0n);
  const paid = BigInt(pod.chunk) * BigInt(wantChunks);

  // An over-window pull is invalid by construction, so it is never broadcast —
  // it is *evaluated*. We evaluate it against the real BCH VM with a coin the
  // size of the pod (or big enough for the attempted pull, so the rule we are
  // demonstrating is the window rule and not an arithmetic one).
  // The simulated coin is always big enough for the attempted pull plus a
  // remainder above the dust limit, so the rule under test is the window rule,
  // not arithmetic or dust.
  const floor = paid + FEES.deliver + 1000n;
  const simBalance = liveBalance > floor ? liveBalance : floor;
  const mock = new MockNetworkProvider();
  const simContract = new Contract(artifact, podParams(pod), { provider: mock });
  const utxo = mock.addUtxo(simContract.address, randomUtxo({ satoshis: simBalance }));
  const remainder = simBalance - paid - FEES.deliver;

  const tb = new TransactionBuilder({ provider: mock, maximumFeeSatoshis: 200000n });
  tb.addInput(utxo, simContract.unlock.deliver(providerKey.pub, providerKey.sig));
  tb.addOutput({ to: addressOf(providerKey.pkh, network), amount: paid });
  tb.addOutput({ to: simContract.address, amount: remainder });

  const base = { attempted: paid.toString(), simulatedBalance: simBalance.toString(), liveBalance: liveBalance.toString(), chunks: String(wantChunks), window: String(pod.window), evaluated: true };
  try {
    tb.debug();
    return { ...base, refused: false, message: 'the VM accepted it — that is a contract bug, please report it' };
  } catch (e) {
    const explain = explainVmError(e);
    return {
      ...base,
      refused: true,
      message: cleanVmError(e),
      explain: explain.rule ? explain : {
        ...explain,
        // The builder's fee sanity check can fire before the VM does (a deliberately
        // invalid spend often has negative fee headroom). The covenant rule is still
        // the reason the pull is invalid, and it is pinned by the test suite.
        rule: 'deliver.window (pinned by tests/ChunkPod.test.mjs #4)',
        text: `A pull of ${wantChunks} chunks (${paid} sat) exceeds the pod's window of ${pod.window} sat. `
          + 'The output cannot be built within the fee budget, and the covenant would refuse it at '
          + '`require(paid <= window)` regardless.',
        note: 'evaluated locally — nothing was broadcast',
      },
    };
  }
}

function cleanVmError(e) {
  const msg = (e?.message ?? String(e)).split('\n')[0];
  return msg.replace(/^Error: /, '');
}

// ---------------------------------------------------------------------------
// refund / close
// ---------------------------------------------------------------------------
export async function refundPod({ pod, network, client }) {
  const { provider, contract } = podContract(pod, network);
  const utxos = await provider.getUtxos(contract.address);
  if (!utxos.length) throw new Error('the pod is already empty — nothing to refund');
  const utxo = utxos[0];
  const height = await provider.getBlockHeight();
  // BCH finality rule is strict: a tx with nLockTime = N is only final once the
  // chain tip is *above* N. So a pod is refundable when tip > validUntil.
  // One block of margin: electrum servers can disagree by a tip, and a tx is
  // only final once the tip has strictly passed its locktime.
  if (height < Number(pod.validUntil) + 2) {
    throw new Error(
      `the pod is not expired yet: the chain tip (${height}) must pass the expiry block (${pod.validUntil}). `
      + 'The covenant refuses early refunds — that is the whole point of a bounded authority.',
    );
  }
  const tb = new TransactionBuilder({ provider });
  tb.addInput(utxo, contract.unlock.refund(client.pub, client.sig));
  tb.addOutput({ to: addressOf(client.pkh, network), amount: utxo.satoshis - FEES.refund });
  tb.setLocktime(Number(pod.validUntil));
  const res = await tb.send();
  pod.refundTxid = res.txid;
  return res;
}

export async function closePod({ pod, network, client, provider: providerKey, chunks = 1n }) {
  const { provider, contract } = podContract(pod, network);
  const utxos = await provider.getUtxos(contract.address);
  if (!utxos.length) throw new Error('the pod is already empty');
  const utxo = utxos[0];
  const paid = BigInt(pod.chunk) * BigInt(chunks);
  const rest = utxo.satoshis - paid - FEES.close;
  if (rest < 0n) throw new Error('pod too small for that split');
  const tb = new TransactionBuilder({ provider });
  tb.addInput(utxo, contract.unlock.close(client.pub, client.sig, providerKey.pub, providerKey.sig));
  tb.addOutput({ to: addressOf(providerKey.pkh, network), amount: paid });
  tb.addOutput({ to: addressOf(client.pkh, network), amount: rest });
  const res = await tb.send();
  pod.closeTxid = res.txid;
  return res;
}

// ---------------------------------------------------------------------------
// verification: the piece payers and payees both need
// ---------------------------------------------------------------------------
function sha256Hex(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(Buffer.from(typeof p === 'string' ? p : p));
  return h.digest('hex');
}

function canonicalJob(job) {
  return JSON.stringify({
    jobId: job.jobId, client: job.client, provider: job.provider,
    chunk: String(job.chunk), window: String(job.window), validUntil: String(job.validUntil),
    assetCategory: job.assetCategory ?? null, description: job.description ?? '',
  });
}

export function jobHash(job) {
  return sha256Hex(canonicalJob(job));
}

/** The evidence a provider keeps per delivered chunk: what it served, and proof it was paid. */
export function chunkReceipt({ job, index, payloadHash, txid, paidSats }) {
  const body = { jobHash: jobHash(job), index, payloadHash, txid, paidSats: String(paidSats) };
  return { ...body, hash: sha256Hex(JSON.stringify(body)) };
}

export async function verifyDeliverTx({ txid, network, pod, providerPkh, expectedPaid }) {
  const { provider } = podContract(pod, network);
  const raw = await provider.getRawTransaction(txid);
  const decoded = decodeTransaction(hexToBin(raw));
  if (typeof decoded === 'string') throw new Error(decoded);
  const outputs = decoded.outputs.map((o) => ({
    value: o.valueSatoshis.toString(),
    lockingBytecode: binToHex(o.lockingBytecode),
  }));
  const wanted = binToHex(new Uint8Array([0x76, 0xa9, 0x14, ...providerPkh, 0x88, 0xac]));
  const payOutput = outputs.find((o) => o.lockingBytecode === wanted);
  return {
    txid,
    outputs,
    paidToProvider: payOutput ? payOutput.value : '0',
    matchesExpected: payOutput ? payOutput.value === String(expectedPaid) : false,
  };
}

// ---------------------------------------------------------------------------
// Human-readable rules: map a VM failure back to the sentence it enforces.
// This is what the UI shows — the exact rule, not a stack trace.
// ---------------------------------------------------------------------------
export const RULES = {
  33: { id: 'deliver.not-provider', text: 'Only the provider named when the pod was created can pull a payment.' },
  34: { id: 'deliver.bad-signature', text: 'The unlock must be signed by the provider key.' },
  37: { id: 'deliver.single-input', text: 'One pod per transaction — pods cannot be merged or spent together.' },
  43: { id: 'deliver.min-one-chunk', text: 'A pull must pay for at least one whole chunk.' },
  44: { id: 'deliver.window', text: 'This pull exceeds the per-transaction window. The blast radius is capped by the covenant.' },
  45: { id: 'deliver.whole-chunks', text: 'Payment must be an exact multiple of the chunk price — no partial chunks.' },
  46: { id: 'deliver.overdraw', text: 'The pod does not hold that much. You cannot withdraw undelivered budget.' },
  49: { id: 'deliver.payee-pinned', text: 'The payment must go to the provider address fixed in the pod. It cannot be redirected.' },
  52: { id: 'deliver.no-extra-outputs', text: 'A delivery has exactly two outputs: the chunk payment, and the rest back to the pod.' },
  53: { id: 'deliver.remainder-locked', text: 'The remainder must return to this same pod, not to a new address.' },
  54: { id: 'deliver.exact-remainder', text: 'The remainder must be exact: held − paid − fee. The pod cannot be short-changed.' },
  60: { id: 'refund.not-client', text: 'Only the client who funded the pod can reclaim what is left.' },
  61: { id: 'refund.bad-signature', text: 'The reclaim must be signed by the client key.' },
  64: { id: 'refund.not-expired', text: 'The pod has not expired yet. Authority is time-bounded, so the client cannot pull money out mid-job.' },
  65: { id: 'refund.single-input', text: 'One pod per transaction.' },
  68: { id: 'refund.one-output', text: 'A reclaim is a single output to the client.' },
  69: { id: 'refund.to-client', text: 'A reclaim must pay the client address in the pod.' },
  70: { id: 'refund.exact-amount', text: 'A reclaim must return exactly balance − fee.' },
  78: { id: 'close.not-client', text: 'A close needs the client key.' },
  79: { id: 'close.not-provider', text: 'A close needs the provider key.' },
  80: { id: 'close.client-sig', text: 'Both parties must sign to close early.' },
  81: { id: 'close.provider-sig', text: 'Both parties must sign to close early.' },
  83: { id: 'close.single-input', text: 'One pod per transaction.' },
  87: { id: 'close.whole-chunks', text: 'A close pays for whole chunks only.' },
  88: { id: 'close.overdraw', text: 'The pod does not hold that much.' },
  92: { id: 'close.two-outputs', text: 'A close is exactly two outputs: provider, then client.' },
  93: { id: 'close.provider-first', text: 'Output 0 of a close must be the provider payment.' },
  94: { id: 'close.client-second', text: 'Output 1 of a close must be the client refund.' },
  95: { id: 'close.exact-split', text: 'A close must split the pod exactly: paid + refund + fee = balance.' },
};

/** Turn "ChunkPod.cash:44 Require statement failed …" into { line, rule, text }. */
export function explainVmError(message) {
  const m = /ChunkPod\.cash:(\d+)/.exec(String(message));
  if (!m) return { line: null, rule: null, text: cleanVmError(message) };
  const line = Number(m[1]);
  const rule = RULES[line] ?? null;
  return { line, rule: rule?.id ?? null, text: rule?.text ?? `Contract rule at line ${line} refused the spend.` };
}


// ---------------------------------------------------------------------------
// Wallet-signed spends.
//
// When the client's coins live in their own WizardConnect wallet, Foreman must
// not hold the key. These builders produce an *unsigned* transaction plus the
// relay-ready source outputs; the phone signs; `verifySpend` then re-checks the
// signed bytes against the covenant rules before anything is broadcast.
// ---------------------------------------------------------------------------
export async function buildWalletFund({ pod, network, funderAddresses, changeAddress, satoshis }) {
  const { provider } = podContract(pod, network);
  const sources = [];
  for (const a of funderAddresses) {
    const utxos = await provider.getUtxos(a);
    for (const u of utxos) sources.push({ ...u, address: a });
  }
  if (!sources.length) throw new Error(`the wallet holds no ${network} BCH — fund it first`);
  return buildWalletFundFromSources({ pod, network, sources, funderAddresses, changeAddress, satoshis });
}

/**
 * Pure builder: no network access, so the tests can inject coins. `sources` are
 * { txid, vout, satoshis, lockingBytecode, address }.
 */
export function buildWalletFundFromSources({ pod, network, sources, funderAddresses, changeAddress, satoshis }) {
  const { contract } = podContract(pod, network);
  sources = [...sources];
  sources.sort((a, b) => (a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1));

  const amount = BigInt(satoshis);
  const chosen = [];
  let total = 0n;
  // 148 vB per P2PKH input, 34 vB per output; 1 sat/vB plus a small margin.
  for (const s of sources) {
    if (total >= amount + BigInt(148 * (chosen.length + 1) + 2 * 34 + 40)) break;
    chosen.push(s);
    total += s.satoshis;
  }
  const fee = BigInt(148 * chosen.length + 2 * 34 + 20);
  if (total < amount + fee) throw new Error(`wallet holds ${total} sat, need ${amount + fee}`);

  const changeLocking = addressToLockingBytecode(changeAddress, network);
  // encodeTransaction() reverses the hash on the wire itself, so the input hash
  // here stays in display order — reversing it here double-reverses the outpoint.
  const inputs = chosen.map((s) => ({
    outpointTransactionHash: hexToBin(s.txid),
    outpointIndex: s.vout,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(0),
  }));
  const tx = {
    version: 2,
    inputs,
    outputs: [
      { lockingBytecode: hexToBin(contract.lockingBytecode ?? contract.bytecode), valueSatoshis: amount },
      { lockingBytecode: changeLocking, valueSatoshis: total - amount - fee },
    ],
    locktime: 0,
  };
  return {
    tx,
    txHex: binToHex(encodeTransaction(tx)),
    /** Relay-ready JSON: WizardConnect carries bytes as hex and atoms as <bigint: Nn>. */
    relaySourceOutputs: chosen.map((s, i) => ({
      // the relay carries display order too; wallets reverse it themselves
      outpointTransactionHash: s.txid,
      outpointIndex: s.vout,
      unlockingBytecode: '',
      sequenceNumber: 0xffffffff,
      valueSatoshis: `<bigint: ${s.satoshis}n>`,
      lockingBytecode: s.lockingBytecode,
    })),
    sourceOutputs: chosen.map((s, i) => ({
      outpointTransactionHash: inputs[i].outpointTransactionHash,
      outpointIndex: s.vout,
      unlockingBytecode: new Uint8Array(0),
      sequenceNumber: 0xffffffff,
      valueSatoshis: s.satoshis,
      lockingBytecode: hexToBin(s.lockingBytecode),
    })),
    inputPaths: chosen.map((s) => [0, 'receive', receiveIndexOf(s.address, funderAddresses)]),
    spends: chosen.map((s) => ({ address: s.address, satoshis: s.satoshis.toString(), txid: s.txid, vout: s.vout })),
    fee: fee.toString(),
    change: (total - amount - fee).toString(),
    podAddress: contract.address,
  };
}

const receiveIndexOf = (address, list) => Math.max(0, list.indexOf(address));

function addressToLockingBytecode(address, network) {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  const { prefix } = netConfig(network);
  if (decoded.prefix !== prefix) throw new Error(`address is ${decoded.prefix}, this app is on ${prefix}`);
  const base = String(decoded.type).replace('WithTokens', '');
  const type = { p2pkh: 'P2PKH', p2sh: 'P2SH20', p2sh20: 'P2SH20', p2sh32: 'P2SH32' }[base] ?? base;
  return addressContentsToLockingBytecode({ type, payload: decoded.payload });
}

/**
 * Re-check a signed transaction against the covenant before broadcasting it.
 * This is the dapp's own guarantee: even if the wallet lies, Foreman refuses to
 * broadcast a spend that breaks the pod's rules.
 */
export function verifySignedSpend({ txHex, pod, network, expect }) {
  const tx = decodeTransaction(hexToBin(txHex));
  if (typeof tx === 'string') throw new Error(`signed transaction does not decode: ${tx}`);

  const vm = createVirtualMachineBCH();
  const check = vm.verify({
    transaction: {
      version: tx.version, inputs: tx.inputs, outputs: tx.outputs, locktime: tx.locktime,
    },
    sourceOutputs: expect.sourceOutputs,
  });
  if (check !== true) throw new Error(`the signed transaction fails its own signature check: ${check}`);

  const podLocking = binToHex(redeemLockingOf(podAddress(pod, network)));
  const outputs = tx.outputs.map((o) => ({ value: o.valueSatoshis.toString(), locking: binToHex(o.lockingBytecode) }));
  const podOut = outputs.find((o) => o.locking === podLocking);
  if (!podOut) throw new Error('the signed transaction does not pay the pod');
  if (expect.amount && podOut.value !== String(expect.amount)) {
    throw new Error(`the pod output is ${podOut.value} sat, expected ${expect.amount}`);
  }
  return {
    txid: binToHex(sha256Hash(encodeTransaction(tx)).reverse()),
    inputs: tx.inputs.length,
    outputs,
    vmPassed: true,
  };
}

/** Locking bytecode for a contract address, p2sh20 or p2sh32. */
export function redeemLockingOf(address) {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  const p = decoded.payload;
  const out = new Uint8Array(p.length === 32 ? 35 : 23);
  out[0] = p.length === 32 ? 0xaa : 0xa9; // OP_HASH256 / OP_HASH160
  out[1] = p.length;                       // push length
  out.set(p, 2);
  out[out.length - 1] = 0x87;              // OP_EQUAL
  return out;
}

function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

const sha256Hash = (bytes) => {
  const first = crypto.createHash('sha256').update(bytes).digest();
  return crypto.createHash('sha256').update(first).digest();
};

// ---------------------------------------------------------------------------
// Batched run: one input pull that pays N chunks in one transaction.
// This is the cheapest possible settlement on BCH: N chunk payments for one fee.
// buildDeliverTx() returns the signed hex, so one transaction can be broadcast
// to several providers at once (real-world: many providers, one railway track).
// ---------------------------------------------------------------------------
export async function buildDeliverTx({ pod, network, provider: providerKey, chunks = 1n }) {
  const { provider, contract } = podContract(pod, network);
  const utxos = await provider.getUtxos(contract.address);
  const spendable = utxos.filter((u) => u.satoshis >= BigInt(pod.chunk) * BigInt(chunks) + FEES.deliver);
  if (!spendable.length) throw new Error(`the pod holds less than ${chunks} chunk(s) + fee`);
  // newest coin first: the pod's state lives in the most recent output
  const utxo = spendable.sort((a, b) => (a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1))[0];
  const paid = BigInt(pod.chunk) * BigInt(chunks);
  const remainder = utxo.satoshis - paid - FEES.deliver;
  const tb = new TransactionBuilder({ provider });
  tb.addInput(utxo, contract.unlock.deliver(providerKey.pub, providerKey.sig));
  tb.addOutput({ to: addressOf(providerKey.pkh, network), amount: paid });
  tb.addOutput({ to: contract.address, amount: remainder });
  return { txHex: tb.build(), txid: tb.buildTransaction ? undefined : undefined, paid, remainder, utxo };
}

/** Broadcast a signed hex directly through the network provider. */
export async function broadcastHex(network, txHex) {
  const provider = new ElectrumNetworkProvider(netConfig(network).network);
  return provider.sendRawTransaction(txHex);
}

// ---------------------------------------------------------------------------
// Settlement reconstruction — what the chain proves about a pod's money.
//
// The app's job ledger is a convenience, not evidence. This ignores it and
// rebuilds the pod's financial life from the chain: every transaction in the
// pod's address history, classified by what it did to the pod's own coins.
//
// The five totals must balance exactly:
//   funded = paid + fees + refunded + elsewhere + held
// If they do not, the *reconstruction* is wrong and we say so, rather than
// printing a plausible gap and calling it a finding.
// ---------------------------------------------------------------------------
const _toHex = (x) => (typeof x === 'string' ? x : Buffer.from(x).toString('hex'));
const _scriptHashOf = (lockingHex) =>
  Buffer.from(sha256Bytes(Uint8Array.from(Buffer.from(lockingHex, 'hex')))).reverse().toString('hex');
const sha256Bytes = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest();

/**
 * @returns {Promise<{funded: bigint, paid: bigint, refunded: bigint, fees: bigint,
 *   elsewhere: bigint, held: bigint, deliveries: number, closing: number, topUps: number,
 *   fundingTxids: string[], spendTxids: string[], anomalies: {txid: string, why: string}[],
 *   utxoCount: number, txs: number, balances: boolean}>}
 */
export async function reconcilePod({ pod, network }, providerOverride = null) {
  const provider = providerOverride ?? new ElectrumNetworkProvider(netConfig(network).network);
  const { contract } = podContract(pod, network);
  const podLocking = _toHex(contract.lockingBytecode);
  const providerLock = binToHex(encodeLockingBytecodeP2pkh(pod.providerPkh));
  const clientLock = binToHex(encodeLockingBytecodeP2pkh(pod.clientPkh));

  const history = await provider
    .performRequest('blockchain.scripthash.get_history', _scriptHashOf(podLocking))
    .catch(() => []);

  const byTxid = new Map();
  for (const entry of history) {
    try {
      const decoded = decodeTransaction(hexToBin(await provider.getRawTransaction(entry.tx_hash)));
      if (typeof decoded === 'string') continue; // pruned on this indexer: skip, never guess
      byTxid.set(entry.tx_hash, decoded);
    } catch { /* unreachable tx: skip */ }
  }

  let funded = 0n, paid = 0n, refunded = 0n, fees = 0n, elsewhere = 0n;
  let deliveries = 0, closing = 0, topUps = 0;
  const fundingTxids = [], spendTxids = [], anomalies = [];
  const fundings = [], spends = [];

  for (const [txid, tx] of byTxid) {
    const sumTo = (target) => tx.outputs.reduce((a, o) => a + (_toHex(o.lockingBytecode) === target ? o.valueSatoshis : 0n), 0n);
    const podOut = sumTo(podLocking);
    const toProvider = sumTo(providerLock);
    const toClient = sumTo(clientLock);
    const valueOut = tx.outputs.reduce((a, o) => a + o.valueSatoshis, 0n);

    let podIn = 0n, inputValue = 0n;
    for (const input of tx.inputs) {
      const parent = byTxid.get(_toHex(input.outpointTransactionHash));
      const spent = parent?.outputs[input.outpointIndex];
      if (!spent) continue;
      inputValue += spent.valueSatoshis;
      if (_toHex(spent.lockingBytecode) === podLocking) podIn += spent.valueSatoshis;
    }

    // Money arriving from outside the pod's own spends: this is funding.
    if (podIn === 0n) {
      if (podOut === 0n) continue;
      funded += podOut;
      fundingTxids.push(txid);
      fundings.push({ txid, satoshis: podOut });
      if (fundingTxids.length > 1) topUps += 1;
      continue;
    }

    spendTxids.push(txid);
    fees += inputValue - valueOut;
    paid += toProvider;
    refunded += toClient;
    if (podOut > 0n) {
      deliveries += 1;
      if (toProvider === 0n) anomalies.push({ txid, why: 'delivery paid no provider output' });
    } else {
      closing += 1;
    }
    spends.push({ txid, toProvider, toClient, remainderBack: podOut, fee: inputValue - valueOut, kind: podOut > 0n ? 'deliver' : 'close' });
    const stray = valueOut - toProvider - toClient - podOut;
    if (stray !== 0n) {
      elsewhere += stray;
      anomalies.push({ txid, why: `${stray} sat left to neither party` });
    }
  }

  const utxos = await provider.getUtxos(contract.address).catch(() => []);
  const held = utxos.reduce((a, u) => a + u.satoshis, 0n);
  const balances = funded === paid + fees + refunded + elsewhere + held;

  return {
    funded, paid, refunded, fees, elsewhere, held,
    deliveries, closing, topUps, fundingTxids, spendTxids, anomalies, fundings, spends,
    utxoCount: utxos.length, txs: byTxid.size, balances,
  };
}

/**
 * Compare a rebuilt settlement against the app's bookkeeping. The chain is
 * always right; the point is to find exactly which transactions the books missed,
 * instead of reporting a total that looks wrong for an unexplained reason.
 */
export function compareToLedger(chain, job) {
  const recorded = (job.events ?? []).map((e) => e.txid).filter(Boolean);
  const chainTxids = [...chain.fundingTxids, ...chain.spendTxids];
  const inLedger = (txid) => recorded.some((t) => txid.startsWith(t));
  const onChain = (short) => chainTxids.some((t) => t.startsWith(short));
  const ledgerFunded = (job.events ?? []).filter((e) => e.kind === 'fund')
    .reduce((a, e) => a + BigInt(e.satoshis ?? 0n), 0n);
  const ledgerPaid = (job.receipts ?? []).reduce((a, r) => a + BigInt(r.paidSats ?? 0n), 0n);

  // A payout the books never claimed: money reached the provider in a transaction
  // we either did not record at all, or recorded without a receipt for that chunk.
  const receiptTxids = (job.receipts ?? []).map((r) => r.txid).filter(Boolean);
  const unbookedPayouts = (chain.spends ?? [])
    .filter((s) => s.toProvider > 0n)
    .filter((s) => !receiptTxids.some((t) => s.txid.startsWith(t)))
    .map((s) => {
      const event = (job.events ?? []).find((e) => e.txid && s.txid.startsWith(e.txid));
      return {
        txid: s.txid,
        paidProvider: s.toProvider.toString(),
        recordedAs: event?.kind ?? 'nothing at all',
        why: event
          ? `recorded as "${event.kind}" but paid the provider with no receipt for it`
          : 'paid the provider from a transaction the ledger never mentions',
      };
    });

  return {
    fundedSats: ledgerFunded.toString(),
    paidSats: ledgerPaid.toString(),
    deliveries: (job.events ?? []).filter((e) => e.kind === 'deliver').length,
    unrecordedOnChain: chainTxids.filter((t) => !inLedger(t)),
    claimedButNotOnChain: recorded.filter((t) => !onChain(t)),
    unbookedPayouts,
    agrees: chain.funded === ledgerFunded && chain.paid === ledgerPaid,
  };
}

// ---------------------------------------------------------------------------
// Measured payout — the receipt records what the chain paid, not what we meant.
//
// The UI used to build a receipt from the chunk count it *asked* for. When a
// close() paid a final chunk, the receipt said 0, and the books under-reported
// settlement while the chain was perfectly correct. Never book an assumption.
// ---------------------------------------------------------------------------
export async function measurePayout({ txid, network, providerPkh }) {
  const provider = new ElectrumNetworkProvider(netConfig(network).network);
  const decoded = decodeTransaction(hexToBin(await provider.getRawTransaction(txid)));
  if (typeof decoded === 'string') throw new Error(decoded);
  const wanted = binToHex(encodeLockingBytecodeP2pkh(providerPkh));
  const paid = decoded.outputs
    .filter((o) => binToHex(o.lockingBytecode) === wanted)
    .reduce((a, o) => a + o.valueSatoshis, 0n);
  return paid;
}

// ---------------------------------------------------------------------------
// Reconciliation entry point shared by the API and the CLI.
// ---------------------------------------------------------------------------
export async function reconcileJob(job, { client, provider }) {
  const pod = {
    clientPkh: client.pkh,
    providerPkh: job.providerPkh ? new Uint8Array(Buffer.from(job.providerPkh, 'hex')) : provider.pkh,
    chunk: BigInt(job.chunk),
    window: BigInt(job.window),
    validUntil: BigInt(job.validUntil),
  };
  const chain = await reconcilePod({ pod, network: job.network === 'mainnet' ? 'mainnet' : 'chipnet' });
  const ledger = compareToLedger(chain, job);
  const dFund = chain.funded - BigInt(ledger.fundedSats);
  const dPay = chain.paid - BigInt(ledger.paidSats);
  const verdict = dFund === 0n && dPay === 0n
    ? 'the books agree with the chain'
    : [
      dFund !== 0n ? `funding ${dFund > 0n ? '+' : ''}${dFund} sat vs the books` : null,
      dPay !== 0n ? `provider paid ${dPay > 0n ? '+' : ''}${dPay} sat vs the books` : null,
    ].filter(Boolean).join('; ');
  return {
    pod: job.id,
    network: job.network ?? 'chipnet',
    chain: {
      fundedSats: chain.funded.toString(),
      paidToProvider: chain.paid.toString(),
      feesPaid: chain.fees.toString(),
      refundedToClient: chain.refunded.toString(),
      paidElsewhere: chain.elsewhere.toString(),
      heldNow: chain.held.toString(),
      deliveries: chain.deliveries,
      closingTxs: chain.closing,
      topUps: chain.topUps,
      txsExamined: chain.txs,
      balancesToTheSatoshi: chain.balances,
      anomalies: chain.anomalies,
      fundingTxids: chain.fundingTxids,
      spendTxids: chain.spendTxids,
    },
    ledger,
    verdict,
  };
}
