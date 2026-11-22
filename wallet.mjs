/**
 * wallet.mjs — WizardConnect, dapp side, hosted by the server.
 *
 * The browser never holds a key. The server runs the relay session, gives the
 * page a `wiz://` URI to draw as a QR, the judge's phone wallet scans it, and
 * from then on every spend request is signed on that phone. This is the path a
 * real product would ship; the server-held demo keys in `server.mjs` stay as a
 * fallback so a judge with no wallet can still click through the whole run.
 *
 * CashScript helper: `lib.mjs` builds the unsigned transaction and serialises it
 * for the relay; `wallet.mjs` only speaks protocol + broadcasting.
 */
import {
  binToHex, decodeTransaction, hexToBin, lockingBytecodeToCashAddress, decodeCashAddress,
} from '@bitauth/libauth';
import { ElectrumNetworkProvider, Network } from 'cashscript';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { initiateDappRelay, PATH_RECEIVE } from '@wizardconnect/core';

export const RECEIVE_INDEX = 0; // BIP44 receive branch, per WizardConnect hdwalletv1

const NET = {
  chipnet: { network: Network.CHIPNET, prefix: 'bchtest' },
  mainnet: { network: Network.MAINNET, prefix: 'bitcoincash' },
};

export const explorerFor = (networkName, txid) => (networkName === 'mainnet'
  ? `https://explorer.bch.ninja/tx/${txid}`
  : `https://chipnet.imaginary.cash/tx/${txid}`);

export const cashAddressOf = (lockingBytecode, networkName) => {
  const res = lockingBytecodeToCashAddress({
    bytecode: lockingBytecode,
    prefix: NET[networkName]?.prefix ?? 'bchtest',
    tokenSupport: true,
  });
  return typeof res === 'string' ? null : res.address;
};

const providerFor = (networkName) => new ElectrumNetworkProvider(NET[networkName].network);

// ---------------------------------------------------------------------------
// one session = one QR code
// ---------------------------------------------------------------------------
export class WalletSession {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.manager = new DappConnectionManager('Foreman', null, { session: false });
    this.relay = null;
    this.uri = null;
    this.ready = false;
    this.wallet = null;
    this.startedAt = null;
    this.events = [];
    this.xpub = null; // optional manual pairing: address derivation without a phone
  }

  log(message) {
    this.events.push({ at: new Date().toISOString(), message });
    if (this.events.length > 40) this.events.shift();
    this.onLog(message);
  }

  start() {
    if (this.relay) return this.uri;
    this.manager.on('walletready', (msg) => {
      this.ready = true;
      this.wallet = {
        name: msg.wallet_name ?? 'wallet',
        icon: msg.wallet_icon ?? null,
        paths: Object.keys(msg.supported_protocols ?? {}),
      };
      this.log(`paired with ${this.wallet.name}`);
    });
    this.manager.on('disconnect', (reason, message) => {
      if (!this.ready) return;
      this.ready = false;
      this.log(`wallet disconnected${reason ? ` (${reason})` : ''}${message ? `: ${message}` : ''}`);
    });
    this.manager.on('messagereceived', (msg) => {
      if (msg.action) this.log(`<- ${msg.action}`);
    });
    this.manager.on('messagesent', (msg) => {
      if (msg.action) this.log(`-> ${msg.action}`);
    });

    // Background tab visibility handling tears the relay down when a phone
    // locks; a server has no visibility state, so turn it off.
    // The relay callback receives a single `{ client, status }` payload.
    this.relay = initiateDappRelay(({ client, status } = {}) => {
      try {
        this.manager.updateConnection(client, status);
      } catch (e) {
        // The relay callback can fire before `client` is populated; log and continue.
        this.log(`relay callback skipped: ${e.message}`);
      }
    }, { enableVisibilityHandling: false });
    this.manager.attachRelay(this.relay);
    this.uri = this.relay.uri;
    this.startedAt = new Date().toISOString();
    this.log('relay session opened');
    return this.uri;
  }

  stop() {
    // Courtesy disconnect only: if the relay is already gone the promise rejects,
    // and an unawaited rejection would take the whole server down.
    try {
      const p = this.manager.sendDisconnect?.('Foreman session closed');
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore */ }
    try { this.relay?.cleanup?.(); } catch { /* ignore */ }
    this.relay = null;
    this.uri = null;
    this.ready = false;
    this.wallet = null;
  }

  status() {
    return {
      started: Boolean(this.relay),
      connected: this.ready,
      uri: this.uri,
      wallet: this.wallet,
      mode: this.ready ? 'wallet-signs' : (this.xpub ? 'xpub-read-only' : 'paired-none'),
      startedAt: this.startedAt,
      events: this.events.slice(-10),
    };
  }

  /** Wallet receive addresses, derived locally from the xpub the wallet sent. */
  addresses(networkName, count = 8) {
    if (this.xpub) return this.xpubAddresses(this.xpub, networkName, count);
    const out = [];
    for (let i = 0n; i < BigInt(count); i += 1n) {
      const pubkey = this.manager.getPubkey(RECEIVE_INDEX, i);
      if (!pubkey) break;
      const pkh = pkhOf(pubkey);
      const addr = lockingBytecodeToCashAddress({
        bytecode: p2pkhLocking(pkh),
        prefix: NET[networkName].prefix,
        tokenSupport: true,
      });
      out.push({ index: i, address: addr.address, pkh });
    }
    return out;
  }

  /**
   * Addresses from a bare xpub (the path a judge can use without pairing a
   * phone: their wallet shows the xpub, Foreman derives the same addresses).
   */
  xpubAddresses(xpub, networkName, count = 8) {
    const node = decodeHdPublicKey(xpub);
    if (typeof node === 'string') throw new Error(`not an xpub: ${node}`);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const child = deriveHdPathRelative(node.node, String(i));
      if (typeof child === 'string') throw new Error(child);
      const pkh = pkhOf(child.publicKey);
      const addr = lockingBytecodeToCashAddress({
        bytecode: p2pkhLocking(pkh),
        prefix: NET[networkName].prefix,
        tokenSupport: true,
      });
      out.push({ index: BigInt(i), address: addr.address, pkh });
    }
    return out;
  }

  /** Ask the wallet to sign. Returns the exact signed bytes; nothing is broadcast here. */
  async sign(request, { timeoutMs = 180000 } = {}) {
    if (!this.ready) throw new Error('no wallet paired yet — scan the QR with a WizardConnect wallet');
    // signTransaction() fills in `action`, `sequence` and `time` for us; a
    // hand-built request without `time` is silently dropped by the relay.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.manager.signTransaction(request, { signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`the wallet did not answer within ${Math.round(timeoutMs / 1000)}s`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async broadcast(networkName, signedHex) {
    const provider = providerFor(networkName);
    const txid = await provider.sendRawTransaction(signedHex);
    return { txid, explorer: explorerFor(networkName, txid) };
  }

  /** Decode the bytes the wallet returned, so the app can show what actually got signed. */
  describeSigned(signedHex, networkName) {
    const tx = decodeTransaction(hexToBin(signedHex));
    if (typeof tx === 'string') return { error: tx };
    return {
      txid: txidOf(hexToBin(signedHex)),
      size: hexToBin(signedHex).length,
      locktime: tx.locktime,
      inputs: tx.inputs.length,
      outputs: tx.outputs.map((o) => ({
        value: o.valueSatoshis.toString(),
        address: cashAddressOf(o.lockingBytecode, networkName),
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
import {
  hash160, sha256, encodeLockingBytecodeP2pkh, decodeHdPublicKey, deriveHdPathRelative,
} from '@bitauth/libauth';

export const pkhOf = (pubkey) => hash160(pubkey);
export const p2pkhLocking = (pkh) => encodeLockingBytecodeP2pkh(pkh);

export function txidOf(txBytes) {
  const digest = sha256.hash(sha256.hash(txBytes));
  let hex = binToHex(digest);
  const pairs = hex.match(/../g);
  return pairs.reverse().join('');
}

/** Which of the wallet's addresses actually hold coins right now. */
export async function walletUtxos(session, networkName, count = 8) {
  const provider = providerFor(networkName);
  const found = [];
  for (const a of session.addresses(networkName, count)) {
    const utxos = await provider.getUtxos(a.address);
    for (const u of utxos) found.push({ ...u, address: a.address, index: a.index });
  }
  return found;
}

export function explorerNetwork(networkName) {
  return NET[networkName] ? networkName : 'chipnet';
}
