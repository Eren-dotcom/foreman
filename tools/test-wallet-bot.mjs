/**
 * tools/test-wallet-bot.mjs — a headless WizardConnect wallet, for testing.
 *
 * Not part of the product. It pairs with a `wiz://` URI exactly like a phone
 * wallet would, then signs whatever Foreman asks it to sign, so the connector can
 * be exercised end to end without a human holding a phone:
 *
 *   node tools/test-wallet-bot.mjs 'wiz://?p=...&s=...'
 *
 * It prints the addresses it will sign for, then signs with those keys.
 */
import {
  binToHex, hexToBin, deriveHdPrivateNodeFromSeed, deriveHdPath,
  deriveHdPublicNode, encodeHdPublicKey, secp256k1, hash160,
  encodeTransaction, decodeTransaction, deriveHdPathRelative,
  generateSigningSerializationBCH, addressContentsToLockingBytecode,
} from '@bitauth/libauth';
import { WalletConnectionManager } from '@wizardconnect/wallet';
import { SignatureTemplate } from 'cashscript';
import crypto from 'node:crypto';

const uri = process.argv[2];
if (!uri) { console.error('usage: node tools/test-wallet-bot.mjs <wiz://...>'); process.exit(1); }

// Deterministic test seed: never use this for real money.
const SEED = process.env.BOT_SEED ? hexToBin(process.env.BOT_SEED) : hexToBin('11'.repeat(32));
const root = deriveHdPrivateNodeFromSeed(SEED, true);
const PATHS = { receive: "m/44'/145'/0'/0", change: "m/44'/145'/0'/1", defi: "m/44'/145'/0'/7" };

const nodeAt = (path, index) => {
  const branch = deriveHdPath(root, path);
  if (typeof branch === 'string') throw new Error(branch);
  if (index === undefined) return branch;
  const child = deriveHdPathRelative(branch, String(index));
  if (typeof child === 'string') throw new Error(child);
  return child;
};

const xpubOf = (path) => {
  const branch = nodeAt(path);
  return encodeHdPublicKey({ node: deriveHdPublicNode(branch), network: 'mainnet' }).hdPublicKey;
};

const adapter = {
  walletName: 'Foreman test bot',
  walletIcon: '',
  getRelayPrivateKey(_uri) {
    return crypto.createHash('sha256').update('bot:' + SEED.toString('hex')).digest();
  },
  getPublicKey(path, index) {
    const child = nodeAt(PATHS[path] ?? PATHS.receive, Number(index));
    const pub = secp256k1.derivePublicKeyCompressed(child.privateKey);
    if (typeof pub === 'string') throw new Error(pub);
    return pub;
  },
  getXpub(path) {
    return xpubOf(PATHS[path] ?? PATHS.receive);
  },

  async signTransaction(request) {
    const tx = request.transaction;
    const raw = tx.transaction;
    const txHex = typeof raw === 'string' ? raw : (raw?.bin ? binToHex(hexToBin(raw.bin)) : binToHex(raw));
    const inputs = decodeTransaction(hexToBin(txHex));
    if (typeof inputs === 'string') throw new Error(inputs);

    const sources = tx.sourceOutputs.map((so) => ({
      outpointTransactionHash: hexToBin(so.outpointTransactionHash),
      outpointIndex: so.outpointIndex,
      unlockingBytecode: hexToBin(so.unlockingBytecode ?? ''),
      sequenceNumber: so.sequenceNumber,
      valueSatoshis: parseSat(so.valueSatoshis),
      lockingBytecode: hexToBin(so.lockingBytecode),
    }));

    const pathOf = (i) => {
      const entry = request.inputPaths[i] ?? [0, 'receive', 0];
      // protocol shape: [childIndex, pathName, addressIndex]
      if (Array.isArray(entry)) return [entry[1] ?? 'receive', entry[2] ?? 0];
      return [entry.pathName ?? 'receive', entry.index ?? 0];
    };
    const builtInputs = inputs.inputs.map((input, i) => {
      const [pathName, index] = pathOf(i);
      const branch = PATHS[pathName] ?? PATHS.receive;
      const child = nodeAt(branch, Number(index));
      const pub = secp256k1.derivePublicKeyCompressed(child.privateKey);
      const pkh = hash160(pub);
      const expected = addressContentsToLockingBytecode({ type: 'P2PKH', payload: pkh });
      if (binToHex(expected) !== binToHex(sources[i].lockingBytecode)) {
        throw new Error(`input ${i}: my key does not own this coin (mine ${binToHex(expected)}, coin ${binToHex(sources[i].lockingBytecode)})`);
      }
      return { ...input, unlockingBytecode: new Uint8Array(0) };
    });

    const unsigned = { version: 2, inputs: builtInputs, outputs: inputs.outputs, locktime: inputs.locktime ?? 0 };
    const signedInputs = builtInputs.map((input, i) => {
      const [pathName, index] = pathOf(i);
      const branch = PATHS[pathName] ?? PATHS.receive;
      const child = nodeAt(branch, String(index));
      // Use cashscript's own unlocker so the signature format matches the
      // sighash type the dapp expects (ALL|FORKID|UTXOS, Schnorr).
      const template = new SignatureTemplate(child.privateKey);
      const unlockingBytecode = template.unlockP2PKH().generateUnlockingBytecode({
        transaction: unsigned,
        sourceOutputs: sources,
        inputIndex: i,
      });
      return { ...input, unlockingBytecode };
    });
    const signed = { ...unsigned, inputs: signedInputs };

    const hex = binToHex(encodeTransaction(signed));
    const d = decodeTransaction(hexToBin(hex));
    const txidBytes = crypto.createHash('sha256').update(crypto.createHash('sha256').update(hexToBin(hex)).digest()).digest();
    const txid = Buffer.from(txidBytes).reverse().toString('hex');
    console.log(`[bot] signed ${d.inputs.length} input(s), ${hex.length / 2} bytes, txid ${txid}`);
    return { signedTransaction: hex };
  },
};

function parseSat(v) {
  const m = /<bigint: (\d+)n>/.exec(String(v));
  return m ? BigInt(m[1]) : BigInt(v);
}

const manager = new WalletConnectionManager(adapter);
manager.on('connectionStatusChanged', (id, status) => console.log(`[bot] connection ${id.slice(0, 8)} ${status.status}`));
manager.on('pendingSignRequest', async (p) => {
  console.log('[bot] sign request received, signing…');
  try {
    const result = await adapter.signTransaction(p.request);
    await manager.sendSignResponse(p.connectionId, p.request.sequence, result.signedTransaction);
    console.log('[bot] response sent', p.request.sequence);
  } catch (e) {
    console.log('[bot] sign failed:', e.message);
    await manager.sendSignError(p.connectionId, p.request.sequence, e.message);
  }
});
manager.on('signCancelled', (id, seq, reason) => console.log(`[bot] dapp cancelled ${seq}: ${reason ?? ''}`));
manager.on('connectionsChanged', () => {
  for (const c of Object.values(manager.getConnections())) {
    console.log(`[bot] dapp "${c.dappName ?? '?'}" status=${c.status.status}`);
  }
});
const id = manager.connect(uri);
console.log(`[bot] connecting as ${id.slice(0, 8)}…`);
console.log('[bot] receive addresses it will sign for:');
for (let i = 0; i < 3; i += 1) {
  const pkh = hash160(adapter.getPublicKey('receive', i));
  console.log(`  #${i} pkh=${binToHex(pkh)}`);
}
setTimeout(() => { console.log('[bot] idle, exiting'); process.exit(0); }, Number(process.env.BOT_SECONDS ?? 90) * 1000).unref();
