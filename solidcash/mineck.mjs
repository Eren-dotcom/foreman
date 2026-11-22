import { Contract, SignatureTemplate, TransactionBuilder, Network, randomUtxo } from '@solidcash/solidcash';
import { hash160, secp256k1, deriveHdPrivateNodeFromSeed, deriveHdPath, encodeCashAddress } from '@bitauth/libauth';
import fs from 'node:fs';
const artifact = JSON.parse(fs.readFileSync('./artifacts/ChunkPod.json','utf8'));
const seed = deriveHdPrivateNodeFromSeed(new Uint8Array(32).fill(9), true);
const mk = i => { const n = deriveHdPath(seed, `m/44'/145'/0'/0/${i}`); const priv=n.privateKey; const pub=secp256k1.derivePublicKeyCompressed(priv); return {pub,pkh:hash160(pub),sig:new SignatureTemplate(priv)}; };
const client=mk(1), provider=mk(2);
const addr = pkh => encodeCashAddress({prefix:'bchtest',type:'p2pkhWithTokens',payload:pkh}).address;
class Mock {
  constructor(){ this.u=new Map(); this.txs=new Map(); this.h=900000; }
  async getUtxos(address){ return this.u.get(address) ?? []; }
  async getUtxosForLockingBytecode(lb){ for (const [a,us] of this.u) if (us[0]?.lockingBytecode===lb) return us; return []; }
  async getBlockHeight(){ return this.h; }
  async getRawTransaction(txid){ return this.txs.get(txid); }
  async sendRawTransaction(hex){ const id='f'.repeat(64); this.txs.set(id,hex); return id; }
  addUtxo(a,u){ const l=[...(this.u.get(a)??[]),u]; this.u.set(a,l); return u; }
}
const net = new Mock();
let c;
try {
  c = new Contract(artifact, [client.pkh, provider.pkh, 20000n, 60000n, 900000n], { provider: net, network: Network.CHIPNET });
  console.log('contract', c.address, 'bytes', c.bytesize);
} catch (e) { console.log('CONSTRUCT ERR', e.message.slice(0,300)); process.exit(1); }
const u = net.addUtxo(c.address, randomUtxo({ satoshis: 100000n, lockingBytecode: c.lockingBytecode }));
const unlocker = c.unlock.deliver(provider.pub, provider.sig);
const tb = new TransactionBuilder({ provider: net });
tb.addInput(u, unlocker);
tb.addOutput({ to: addr(provider.pkh), amount: 20000n });
tb.addOutput({ to: c.address, amount: 100000n - 20000n - 700n });
tb.setLocktime(0);
try { const r = await tb.send(); console.log('SENT', r.txid); } catch (e) { console.log('SEND ERR', e.constructor.name, e.message.slice(0,400)); }
