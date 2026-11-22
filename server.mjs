/**
 * foreman/server.mjs — the live app.
 *
 * One process serves the front end, the demo evidence, and a small API that
 * builds real Chipnet transactions on demand, so a judge can click a button and
 * watch a covenant pay, refuse, or refund.
 */
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  keyFromSeedHex, randomSeedHex, addressOf, addressToPkh, podAddress, podContract, readPod,
  fundPod, deliverChunks, simulateSteal, refundPod, closePod, chunkReceipt,
  jobHash, explainVmError, verifyDeliverTx, buildWalletFund, verifySignedSpend,
  NETWORKS, FEES, RULES, measurePayout, reconcileJob,
} from './lib.mjs';
import { WalletSession, explorerFor, cashAddressOf, txidOf, walletUtxos } from './wallet.mjs';
import QRCode from 'qrcode';
import { judge, intentId, INTENT_RULES } from './guard.mjs';

// A relay socket can die at any moment; that must never take the demo offline.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled]', reason?.message ?? reason);
});

const app = express();
app.use(express.json());
app.use(express.static(new URL('./web/', import.meta.url).pathname));

const NETWORK = process.env.FOREMAN_NETWORK || 'chipnet';
const PORT = Number(process.env.PORT || 4173);
const SECRETS = new URL('./.secrets/server.json', import.meta.url);

// ---------------------------------------------------------------------------
// keys: a demo client + a demo provider, chipnet only, deliberately small
// ---------------------------------------------------------------------------
function loadKeys() {
  try { return JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { /* create */ }
  const seeds = { client: randomSeedHex(), provider: randomSeedHex() };
  fs.mkdirSync(new URL('./.secrets/', import.meta.url), { recursive: true });
  fs.writeFileSync(SECRETS, JSON.stringify(seeds, null, 2));
  return seeds;
}
const seeds = loadKeys();
const client = keyFromSeedHex(seeds.client, 0);
const provider = keyFromSeedHex(seeds.provider, 0);

// Job records persist to disk: the chain is the source of truth, but the app
// should not forget a pod just because the process restarted.
const JOBS_FILE = new URL('./.secrets/jobs.json', import.meta.url);
const jobs = new Map();
try {
  for (const j of JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))) jobs.set(j.id, j);
} catch { /* first run */ }
// Intent ids already executed this session — the replay rule needs history.
const executedIntents = new Set();
const preceipts = [];
// Preceipts by intent id: asking the same question twice must give the same
// answer, not a second decision. That is idempotency, and it is what makes an
// agent's retry safe.
const preceiptByIntent = new Map();

const persist = () => {
  fs.mkdirSync(new URL('./.secrets/', import.meta.url), { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2));
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const readJson = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8')); } catch { return fallback; }
};

/** Each pod remembers the network it was created on: chipnet by default, mainnet on request. */
const net = (job) => (job?.network === 'mainnet' ? 'mainnet' : NETWORK);
const explorerOf = (job, txid) => NETWORKS[net(job)].explorer + txid;

const podOf = (job) => ({
  clientPkh: client.pkh,
  providerPkh: job.providerPkh ? new Uint8Array(Buffer.from(job.providerPkh, 'hex')) : provider.pkh,
  chunk: BigInt(job.chunk),
  window: BigInt(job.window),
  validUntil: BigInt(job.validUntil),
});

function shape(job) {
  return {
    id: job.id,
    address: podAddress(podOf(job), net(job)),
    chunk: job.chunk,
    window: job.window,
    validUntil: job.validUntil,
    description: job.description,
    network: net(job),
    createdAt: job.createdAt,
    events: job.events,
    receipts: job.receipts ?? [],
  };
}

async function state(job) {
  const live = await readPod(podOf(job), net(job));
  return { ...shape(job), live };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
/**
 * One shape for every failure. A covenant refusal is not an error string: it is a
 * named rule and the line that enforces it, and the UI already knows how to render
 * that. `explainVmError` existed but was never called, so refusals from `/deliver`,
 * `/close` and `/refund` came back as a bare sentence with the rule thrown away.
 */
function fail(res, e, extra = {}) {
  // Kept in one place so a route cannot invent its own failure shape.
  const explain = explainVmError(e?.message ?? String(e));
  // A covenant refusal is a 400 the caller can act on; an unclassified fault is a 500.
  const { status: explicit, ...rest } = extra;
  const status = explicit ?? (explain.rule ? 400 : 500);
  return res.status(status).json({
    error: (e?.message ?? String(e)).split('\n')[0],
    refused: Boolean(explain.rule),
    explain,
    ...rest,
  });
}


app.get('/api/health', (_req, res) => {
  res.json({ ok: true, network: NETWORK, client: addressOf(client.pkh, NETWORK), provider: addressOf(provider.pkh, NETWORK) });
});

/** Everything the page needs to replay the recorded run. */
app.get('/api/evidence', (_req, res) => {
  res.json({
    demo: readJson('./web/data.json'),
    batch: readJson('./web/batch.json'),
    contract: readJson('./web/contract.json'),
  });
});


// ---------------------------------------------------------------------------
// Pre-execution guard + preceipts
//
// The covenant can refuse a bad spend, but only after it has been built and
// signed, and an agent learns about it by failing. This endpoint lets an agent
// (or the UI) ask BEFORE it spends, and get a signed-by-nobody, hashable record
// of what it was told. Borrowed in spirit from Intent Firewall (KeeperHub, 47771).
// ---------------------------------------------------------------------------
function podForGuard(job, live) {
  return {
    chunk: BigInt(job.chunk),
    window: BigInt(job.window),
    balance: live?.balance,
    blocksToExpiry: live?.blocksToExpiry,
    blockHeight: live?.blockHeight,
    providerAddress: addressOf(podOf(job).providerPkh, net(job)),
  };
}

function preceiptOf({ job, intent, verdict, chain }) {
  const body = {
    kind: 'preceipt',
    pod: job.id,
    podAddress: shape(job).address,
    network: net(job),
    intent: { ...intent, id: intent.id ?? intentId(intent) },
    verdict: verdict.decision,
    code: verdict.code,
    reason: verdict.reason,
    effect: verdict.effect,
    rules: verdict.rules,
    chainState: chain,
    decidedAt: new Date().toISOString(),
  };
  body.hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return body;
}

/** Ask the guard about an intent without executing anything. Always 200: a "deny" is an answer, not an error. */
app.post('/api/pods/:id/intent', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown pod' });
  const live = await readPod(podOf(job), net(job)).catch(() => null);
  const intent = { ...(req.body ?? {}), pod: req.body?.pod ?? shape(job).address };
  if (!intent.id) intent.id = intentId(intent);
  // Already answered this exact intent in this session? Return that answer.
  const prior = preceiptByIntent.get(intent.id);
  if (prior) {
    return res.json({ ...prior, duplicate: true, note: 'this intent was already judged; the preceipt above is the original decision' });
  }
  const verdict = judge({ intent, pod: podForGuard(job, live), seen: executedIntents });
  const preceipt = preceiptOf({
    job, intent, verdict,
    chain: { balance: live?.balance, blockHeight: live?.blockHeight, blocksToExpiry: live?.blocksToExpiry },
  });
  preceipts.push({ ...preceipt, executed: false });
  preceiptByIntent.set(intent.id, preceipt);
  if (preceipts.length > 200) preceipts.shift();
  if (preceiptByIntent.size > 200) preceiptByIntent.delete(preceiptByIntent.keys().next().value);
  res.json(preceipt);
});

/** Every preceipt this session, newest first — the agent's own decision log. */
app.get('/api/preceipts', (_req, res) => {
  res.json({ preceipts: [...preceipts].reverse(), executedIntents: [...executedIntents] });
});

/** Every pod this session has opened, with its live on-chain balance. */
app.get('/api/pods', async (_req, res) => {
  try {
    const out = [];
    for (const job of [...jobs.values()].slice(-25)) {
      const live = await readPod(podOf(job), net(job)).catch(() => null);
      out.push({
        ...shape(job),
        balance: live?.balance ?? '0',
        blockHeight: live?.blockHeight ?? 0,
        expired: live?.expired ?? false,
        blocksToExpiry: live?.blocksToExpiry ?? 0,
        blocks: Number(job.validUntil) - Number(live?.blockHeight ?? job.validUntil),
        explorer: NETWORKS[net(job)].explorer,
        fundedTxid: job.events.find((e) => e.kind === 'fund')?.txid ?? null,
      });
    }
    res.json({ pods: out, network: NETWORK });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** One pod, with live state. */
app.get('/api/pods/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown pod' });
  res.json(await state(job));
});

/** Create a pod. The demo client will fund it from the sandbox wallet. */
app.post('/api/pods', async (req, res) => {
  try {
    const {
      chunk = 20000, window: win = 60000, blocks = 24,
      description = 'Agent job', provider: providerAddress = null,
      chain = NETWORK,
    } = req.body ?? {};
    if (!NETWORKS[chain]) throw new Error(`unknown chain: ${chain}`);
    const chainNet = chain;
    const chunkN = BigInt(chunk);
    const winN = BigInt(win);
    if (chunkN <= 0n) throw new Error('chunk must be positive');
    if (winN < chunkN) throw new Error('the window must be at least one chunk');
    if (winN % chunkN !== 0n) throw new Error('window must be a whole multiple of the chunk price');
    if (!Number.isInteger(Number(blocks)) || Number(blocks) < 1) throw new Error('blocks must be positive');
    // A real client names their own provider; the demo provider is the fallback.
    const providerPkh = providerAddress ? addressToPkh(providerAddress) : provider.pkh;
    const height = (await readPod({ clientPkh: client.pkh, providerPkh, chunk: 1n, window: 1n, validUntil: 1n }, chainNet)).blockHeight;
    const job = {
      id: 'job_' + crypto.randomBytes(4).toString('hex'),
      chunk: String(chunkN), window: String(winN),
      validUntil: String(height + Number(blocks)),
      description, network: chainNet,
      providerPkh: providerAddress ? Buffer.from(providerPkh).toString('hex') : null,
      events: [], receipts: [], createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    persist();
    res.json(await state(job));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Fund: the client pre-authorises a budget into the pod (real tx). */
app.post('/api/pods/:id/fund', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    const satoshis = BigInt(req.body?.satoshis ?? 100000n);
    if (net(job) === 'mainnet') {
      return res.status(400).json({
        error: 'this pod is on mainnet and the demo keys hold no real BCH — connect your wallet and use POST /api/pods/:id/fund-wallet',
      });
    }
    const pod = podOf(job);
    const r = await fundPod({ pod, network: net(job), funder: client, satoshis });
    job.events.push({ kind: 'fund', txid: r.txid, satoshis: String(satoshis), at: new Date().toISOString() });
    persist();
    res.json({ txid: r.txid, explorer: explorerOf(job, r.txid), state: await state(job) });
  } catch (e) {
    fail(res, e);
  }
});

/** Deliver: the provider pulls N chunks (real tx). */
app.post('/api/pods/:id/deliver', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    const chunks = BigInt(req.body?.chunks ?? 1);
    const pod = podOf(job);
    // A zero-chunk pull used to be booked as an amount, hit the replay rule and come
    // back with the wrong reason. It is a malformed request, and the guard has a code
    // for exactly that — give it the amount in a shape the rule can reject.
    if (chunks < 1n) return fail(res, new Error('chunks must be a whole number of chunks, at least 1'), { status: 400 });
    const intent = { pod: shape(job).address, action: 'deliver', amount: String(BigInt(job.chunk) * chunks) };
    intent.id = intentId(intent);
    // Idempotency is content-derived on purpose: re-sending the exact same pull is a
    // retry, not a second delivery. Only a *new* intent id may reach the guard, so a
    // duplicate is answered from the record instead of being judged as a replay.
    const prior = preceiptByIntent.get(intent.id);
    if (prior?.executed) {
      return res.json({
        duplicate: true,
        note: 'this exact pull was already delivered; the receipt below is the original',
        txid: prior.txid, receiptHash: prior.receiptHash, preceiptId: intent.id,
        state: await state(job),
      });
    }
    // Guard first, on real on-chain state: if the covenant would refuse this, say so
    // in the covenant's own words before building anything.
    const live = await readPod(pod, net(job)).catch(() => null);
    const verdict = judge({ intent, pod: podForGuard(job, live), seen: executedIntents });
    if (verdict.decision === 'deny') {
      const refused = preceiptOf({ job, intent, verdict, chain: { balance: live?.balance, blockHeight: live?.blockHeight } });
      preceipts.push({ ...refused, executed: false });
      job.events.push({ kind: 'refuse', rule: verdict.code, line: null, at: new Date().toISOString(), source: 'guard' });
      persist();
      return res.status(400).json({ refused: true, guard: refused, explain: { rule: verdict.code, text: verdict.reason } });
    }
    const r = await deliverChunks({ pod, network: net(job), provider, chunks });
    r.preceiptId = intent.id;
    // Book what the transaction actually paid, read back off the chain — not what
    // we asked it to pay. A receipt that states an intention is not a receipt.
    const measured = await measurePayout({ txid: r.txid, network: net(job), providerPkh: pod.providerPkh })
      .catch(() => BigInt(r.paid));
    const payload = req.body?.payload ?? `chunk ${job.receipts.length + 1}`;
    const receipt = chunkReceipt({
      job: { jobId: job.id, ...pod }, index: job.receipts.length,
      payloadHash: crypto.createHash('sha256').update(payload).digest('hex'),
      txid: r.txid, paidSats: measured,
    });
    job.receipts.push(receipt);
    executedIntents.add(intent.id);
    // remember the settled decision so a retry is answered from the record, not re-judged
    preceiptByIntent.set(intent.id, {
      kind: 'preceipt', pod: job.id, intent, verdict: 'pass', executed: true,
      txid: r.txid, receiptHash: receipt.hash, decidedAt: new Date().toISOString(),
    });
    job.events.push({ kind: 'deliver', txid: r.txid, paid: String(r.paid), chunks: String(chunks), at: new Date().toISOString() });
    // The preceipt is the agent's decision record; the receipt is the chain's.
    // Pairing them is the audit trail: what was predicted, and what settled.
    preceipts.push({
      kind: 'preceipt', pod: job.id, network: net(job), intent,
      verdict: 'pass', code: null, reason: 'guard passed; covenant settled it',
      effect: verdict.effect, executed: true, txid: r.txid, receiptHash: receipt.hash,
      decidedAt: new Date().toISOString(),
      hash: crypto.createHash('sha256').update(JSON.stringify({ intent, txid: r.txid, receipt: receipt.hash })).digest('hex'),
    });
    persist();
    res.json({
      txid: r.txid, paid: String(r.paid), explorer: explorerOf(job, r.txid), receipt,
      preceiptId: r.preceiptId, state: await state(job),
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Cheat: try to pull more than the window allows. Nothing is broadcast. */
app.post('/api/pods/:id/steal', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    const wantChunks = BigInt(req.body?.chunks ?? 4);
    const r = await simulateSteal({ pod: podOf(job), network: net(job), provider, wantChunks });
    job.events.push({ kind: 'refuse', rule: r.explain?.rule ?? null, line: r.explain?.line ?? null, at: new Date().toISOString() });
    persist();
    res.json(r);
  } catch (e) {
    fail(res, e);
  }
});

/** Early reclaim attempt: also refused, until the pod expires. */
app.post('/api/pods/:id/early-refund', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    const why = await refundPod({ pod: podOf(job), network: net(job), client }).then(
      (r) => ({ refunded: true, txid: r.txid }),
      (e) => ({ refused: true, message: e.message.split('\n')[0] }),
    );
    res.json(why);
  } catch (e) {
    fail(res, e);
  }
});

/** Refund after expiry (real tx). */
app.post('/api/pods/:id/refund', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    const r = await refundPod({ pod: podOf(job), network: net(job), client });
    job.events.push({ kind: 'refund', txid: r.txid, at: new Date().toISOString() });
    persist();
    res.json({ txid: r.txid, explorer: explorerOf(job, r.txid), state: await state(job) });
  } catch (e) {
    fail(res, e);
  }
});

/** Mutual close with a final chunk (real tx). */
app.post('/api/pods/:id/close', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    const chunks = BigInt(req.body?.chunks ?? 1);
    const r = await closePod({ pod: podOf(job), network: net(job), client, provider, chunks });
    // close() pays the last chunk *and* returns the remainder. The old bookkeeping
    // recorded the close event but no receipt for the chunk, so the ledger drifted
    // from settlement by one chunk. Measure it and book it as a delivery too.
    const paidOnClose = await measurePayout({ txid: r.txid, network: net(job), providerPkh: podOf(job).providerPkh })
      .catch(() => 0n);
    job.events.push({ kind: 'close', txid: r.txid, paid: String(paidOnClose), at: new Date().toISOString() });
    if (paidOnClose > 0n) {
      job.receipts.push(chunkReceipt({
        job: { jobId: job.id, ...podOf(job) }, index: job.receipts.length,
        payloadHash: crypto.createHash('sha256').update(`close:${r.txid}`).digest('hex'),
        txid: r.txid, paidSats: paidOnClose,
      }));
    }
    persist();
    res.json({ txid: r.txid, explorer: explorerOf(job, r.txid), state: await state(job) });
  } catch (e) {
    fail(res, e);
  }
});


// ---------------------------------------------------------------------------
// Wallet connector (WizardConnect)
//
// A judge opens /wallet.html, scans the QR with a BCH wallet, and from that
// point the *client's own* wallet signs. The demo keys above stay as a fallback
// so the page still works with no phone in hand.
// ---------------------------------------------------------------------------
let wallet = new WalletSession({ onLog: (m) => console.log('[wallet]', m) });

app.get('/api/wallet/status', (_req, res) => {
  res.json({ ...wallet.status(), network: NETWORK });
});

/** Open a pairing session: returns the wiz:// URI plus a QR as inline SVG. */
app.post('/api/wallet/connect', async (_req, res) => {
  try {
    if (wallet.relay && wallet.ready) return res.json({ ...wallet.status(), qr: null, reused: true });
    if (!wallet.relay) wallet.start();
    const qrSvg = await QRCode.toString(wallet.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ ...wallet.status(), qr: qrSvg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Pair a bare xpub instead of a phone: read-only, but enough for real UTXOs. */
app.post('/api/wallet/xpub', (req, res) => {
  try {
    const { xpub } = req.body ?? {};
    if (!xpub) return res.status(400).json({ error: 'xpub is required' });
    wallet.xpub = String(xpub).trim();
    const addresses = wallet.xpubAddresses(wallet.xpub, NETWORK, 4).map((a) => a.address);
    res.json({ ...wallet.status(), addresses });
  } catch (e) {
    wallet.xpub = null;
    fail(res, e);
  }
});

app.post('/api/wallet/disconnect', (_req, res) => {
  wallet.stop();
  wallet = new WalletSession({ onLog: (m) => console.log('[wallet]', m) });
  res.json(wallet.status());
});

/** What coins does the paired wallet actually hold right now? `?chain=mainnet` to look at real BCH. */
app.get('/api/wallet/utxos', async (req, res) => {
  try {
    if (!wallet.ready && !wallet.xpub) return res.status(400).json({ error: 'pair a wallet first' });
    const chain = NETWORKS[req.query.chain] ? req.query.chain : NETWORK;
    // walletUtxos walks the addresses on one provider; building a provider per
    // address opened eight relay connections for one read.
    const found = await walletUtxos(wallet, chain, 8);
    const out = wallet.addresses(chain, 8).map((a) => {
      const mine = found.filter((u) => u.address === a.address);
      return {
        address: a.address, index: String(a.index),
        balance: mine.reduce((x, u) => x + u.satoshis, 0n).toString(),
        utxos: mine.length,
      };
    });
    res.json({ chain, addresses: out, total: out.reduce((x, a) => x + BigInt(a.balance), 0n).toString() });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Fund a pod straight from the paired wallet: build → the wallet signs over the
 * relay → verify the signature locally → broadcast. The server never sees a key.
 */
app.post('/api/pods/:id/fund-wallet', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown pod' });
    if (!wallet.ready) return res.status(400).json({ error: 'no wallet paired — scan the QR on /wallet.html' });
    const satoshis = BigInt(req.body?.satoshis ?? 100000n);
    const chain = net(job);
    const addresses = wallet.addresses(chain, 8).map((a) => a.address);
    const fund = await buildWalletFund({
      pod: podOf(job), network: chain, funderAddresses: addresses,
      changeAddress: addresses[0], satoshis,
    });
    job.events.push({ kind: 'fund-build', fee: fund.fee, at: new Date().toISOString() });

    const signed = await wallet.sign({
      transaction: {
        transaction: fund.txHex,
        sourceOutputs: fund.relaySourceOutputs,
        broadcast: false,
        userPrompt: `Authorise ${satoshis} sat for Foreman pod ${job.id} (${chain})`,
      },
      inputPaths: fund.inputPaths,
    });

    const check = verifySignedSpend({
      txHex: signed.signedTransaction, pod: podOf(job), network: chain,
      expect: { sourceOutputs: fund.sourceOutputs, amount: satoshis },
    });
    const broadcast = await wallet.broadcast(chain, signed.signedTransaction);
    job.events.push({ kind: 'fund', txid: broadcast.txid, satoshis: String(satoshis), signedBy: 'wallet', at: new Date().toISOString() });
    persist();
    res.json({
      txid: broadcast.txid, explorer: broadcast.explorer, signedBy: 'wallet',
      walletCheck: check, spends: fund.spends, fee: fund.fee, change: fund.change,
      state: await state(job),
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Verification: read a delivered tx back off the chain and check the payee. */
app.get('/api/verify/:txid', async (req, res) => {
  try {
    const job = [...jobs.values()].find((j) => j.events.some((e) => e.txid === req.params.txid));
    if (!job) return res.status(404).json({ error: 'unknown txid for this session' });
    const receipt = job.receipts.find((r) => r.txid === req.params.txid);
    const check = await verifyDeliverTx({
      txid: req.params.txid, network: net(job), pod: podOf(job),
      providerPkh: provider.pkh, expectedPaid: receipt?.paidSats ?? '0',
    });
    res.json({ ...check, receipt, explorer: explorerOf(job, req.params.txid) });
  } catch (e) {
    res.status(500).json({ error: e.message.split('\n')[0] });
  }
});

/**
 * Reconciliation for one pod: rebuild settlement from the chain and say, plainly,
 * where the books and the chain disagree. Read-only; nothing is broadcast.
 */
app.get('/api/pods/:id/reconcile', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown pod' });
  try {
    res.json(await reconcileJob(job, { client, provider }));
  } catch (e) {
    res.status(502).json({ error: e.message.split('\n')[0] });
  }
});

/** Reconciliation across every pod this session has opened. */
app.get('/api/reconcile', async (_req, res) => {
  const pods = [...jobs.values()].slice(-25);
  const out = [];
  for (const job of pods) {
    try { out.push(await reconcileJob(job, { client, provider })); }
    catch (e) { out.push({ pod: job.id, error: e.message.split('\n')[0] }); }
  }
  res.json({
    reconciledAt: new Date().toISOString(),
    pods: out,
    totals: {
      pods: out.length,
      balanceToTheSatoshi: out.filter((p) => p.chain?.balancesToTheSatoshi).length,
      booksAgree: out.filter((p) => p.ledger?.agrees).length,
      unbookedPayouts: out.reduce((a, p) => a + (p.ledger?.unbookedPayouts?.length ?? 0), 0),
      unrecordedOnChain: out.reduce((a, p) => a + (p.ledger?.unrecordedOnChain?.length ?? 0), 0),
    },
  });
});

/** The state machine, derived from the compiled artifact (see scripts/phases.mjs). */
app.get('/api/phases', (_req, res) => {
  res.json(readJson('./web/phases.json', { states: [], edges: [] }));
});

/** The recorded run in one GET for anyone verifying without a browser.
 *  `web/data.json` is already a static file under `web/`, so this route is only a
 *  stable alias with the project header attached — it used to re-serve a different
 *  subset of the same file, which is two shapes of one truth. */
app.get('/api/run.json', (_req, res) => res.redirect(302, '/data.json'));

/** The rules the covenant enforces — the same RULES the UI explains a refusal with. */
app.get('/api/rules', (_req, res) => {
  const guardIds = new Set(INTENT_RULES.map((r) => r.code));
  res.json(Object.entries(RULES).map(([line, r]) => ({ line: Number(line), ...r, guard: guardIds.has(r.id) })));
});

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Foreman on http://0.0.0.0:${PORT}  (${NETWORK})`);
  console.log(`  client ${addressOf(client.pkh, NETWORK)}`);
  console.log(`  provider ${addressOf(provider.pkh, NETWORK)}`);
});
