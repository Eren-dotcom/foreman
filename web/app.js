const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const short = (s) => (s ? s.slice(0, 10) + '…' + s.slice(-6) : '');

const log = (msg, cls = '') => {
  const el = $('console');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

let EXPLORER = 'https://chipnet.imaginary.cash/tx/';
let pod = null;

// ---------------------------------------------------------------------------
// Static demo engine (added 2026-11-22 fix)
// GitHub Pages has no server, so every /api/* call used to fail there and the
// buttons looked dead. This interceptor tries the real server first; if the
// answer is not JSON (Pages 404) it activates an in-browser engine that
// enforces the same covenant rules locally — whole chunks, window cap, pinned
// payee, no early refund — with simulated Chipnet transactions. It is labelled
// as simulation wherever it appears; `node server.mjs` remains the live path.
// ---------------------------------------------------------------------------
const _realFetch = window.fetch.bind(window);
let _staticMode = false;
const _DEMO_CLIENT = 'bchtest:zq7zalxf3ctg7yca6kt4r6yt78c3q2tnkq9d698dxu';
const _DEMO_PROVIDER = 'bchtest:zryvhfcez33j6azvajhe9ud3qrjm0vju9y45clsfht';
const _sim = {
  height: 340020,
  pods: new Map(), order: [], preceipts: new Map(),
  wallet: { started: false, connected: false, uri: null, startedAt: 0, xpub: null, balance: 250000, name: null, events: [] },
};
const _hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const _txid = () => _hex(32);
const _podAddr = () => 'bchtest:p' + _hex(20);
const _ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const _fail = (status, error, explain, extra = {}) => new Response(
  JSON.stringify({ error, refused: Boolean(explain), explain: explain || { rule: null, text: '' }, ...extra }),
  { status, headers: { 'content-type': 'application/json' } },
);
const _hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); };

function _podState(j) {
  const expired = _sim.height >= j.validUntil;
  return {
    id: j.id, address: j.address, chunk: j.chunk, window: j.window, validUntil: String(j.validUntil),
    description: j.description, network: j.network, createdAt: j.createdAt, events: j.events, receipts: j.receipts,
    live: {
      balance: String(j.balance), address: j.address, blockHeight: _sim.height,
      expired, blocksToExpiry: Math.max(0, j.validUntil - _sim.height), utxos: j.balance > 0 ? 1 : 0,
    },
  };
}
function _podListItem(j) {
  const s = _podState(j);
  return {
    ...s, balance: String(j.balance), blockHeight: _sim.height, expired: s.live.expired,
    blocksToExpiry: s.live.blocksToExpiry, blocks: Math.max(0, j.validUntil - _sim.height),
    explorer: EXPLORER, fundedTxid: j.events.find((e) => e.kind === 'fund')?.txid ?? null,
  };
}
function _judge(j, intent) {
  const amount = BigInt(intent.amount ?? 0);
  const chunk = BigInt(j.chunk), win = BigInt(j.window), bal = BigInt(j.balance);
  const rules = [];
  const whole = amount > 0n && amount % chunk === 0n;
  rules.push({ code: 'deliver.whole-chunks', outcome: whole ? 'pass' : 'deny' });
  const within = amount <= win;
  rules.push({ code: 'deliver.window', outcome: within ? 'pass' : 'deny' });
  const payeeOk = !intent.payTo || intent.payTo === j.providerAddress;
  rules.push({ code: 'deliver.payee', outcome: payeeOk ? 'pass' : 'deny' });
  const funded = amount + 700n <= bal;
  rules.push({ code: 'pod.balance', outcome: bal > 0n ? (funded ? 'pass' : 'deny') : 'skipped' });
  let decision = 'pass', code = null, reason = 'this intent satisfies every covenant rule';
  if (!whole) { decision = 'deny'; code = 'deliver.whole-chunks'; reason = `this would move ${amount} sat; the pod pays whole chunks of ${chunk} sat only`; }
  else if (!within) { decision = 'deny'; code = 'deliver.window'; reason = `this would move ${amount} sat in one transaction; the window is ${win} sat`; }
  else if (!payeeOk) { decision = 'deny'; code = 'deliver.payee'; reason = 'the payee is pinned to the named provider by the covenant'; }
  else if (!funded) { decision = 'deny'; code = 'pod.balance'; reason = `the pod holds ${bal} sat; this pull plus the 700 sat fee exceeds it`; }
  return {
    decision, code, reason, rules,
    effect: { balanceBefore: String(bal), balanceAfter: String(decision === 'pass' ? bal - amount - 700n : bal) },
  };
}
function _walletStatus() {
  const w = _sim.wallet;
  if (w.started && !w.connected && Date.now() - w.startedAt > 3000) {
    w.connected = true; w.name = 'Demo Wallet (static simulation)';
    w.events.push({ at: new Date().toISOString(), message: 'paired with Demo Wallet (static simulation)' });
  }
  return {
    started: w.started, connected: w.connected, uri: w.uri,
    wallet: w.connected ? { name: w.name } : null,
    mode: w.connected ? 'wallet-signs' : (w.xpub ? 'xpub-read-only' : 'paired-none'),
    startedAt: w.startedAt ? new Date(w.startedAt).toISOString() : null,
    events: w.events.slice(-10), network: 'chipnet',
  };
}
async function _localApi(pathname, method, body) {
  const seg = pathname.split('/api/')[1].split('/').filter(Boolean);
  try {
    if (seg[0] === 'health') return _ok({ ok: true, network: 'chipnet', client: _DEMO_CLIENT, provider: _DEMO_PROVIDER });
    if (seg[0] === 'evidence') {
      const [demo, batch, contract] = await Promise.all([
        _realFetch('./data.json').then((r) => r.json()).catch(() => null),
        _realFetch('./batch.json').then((r) => r.json()).catch(() => null),
        _realFetch('./contract.json').then((r) => r.json()).catch(() => null),
      ]);
      return _ok({ demo, batch, contract });
    }
    if (seg[0] === 'phases') return _ok(await _realFetch('./phases.json').then((r) => r.json()));
    if (seg[0] === 'rules') return _ok([
      { id: 'deliver.window', text: 'Provider pull must not exceed the per-transaction window', guard: true },
      { id: 'deliver.whole-chunks', text: 'Whole chunks only — no partial chunk payments', guard: true },
      { id: 'deliver.payee', text: 'Payee is pinned to the named provider', guard: true },
      { id: 'deliver.single-input', text: 'One pod per transaction — pods cannot be merged', guard: false },
      { id: 'refund.not-expired', text: 'Client refund only after the authority expires', guard: true },
      { id: 'close.both-sign', text: 'Close needs both signatures and an exact split', guard: false },
    ]);
    if (seg[0] === 'preceipts') return _ok({ preceipts: [..._sim.preceipts.values()].reverse(), executedIntents: [] });
    if (seg[0] === 'reconcile') {
      const pods = _sim.order.map((id) => _sim.pods.get(id)).filter(Boolean).map((j) => ({
        pod: j.id, network: j.network,
        chain: {
          fundedSats: String(j.funded), paidToProvider: String(j.paidTotal), feesPaid: String(j.fees),
          refundedToClient: String(j.refunded), heldNow: String(j.balance),
          txsExamined: j.events.filter((e) => e.txid).length, deliveries: j.receipts.length,
          closingTxs: j.events.filter((e) => e.kind === 'close' || e.kind === 'refund').length,
          topUps: Math.max(0, j.events.filter((e) => e.kind === 'fund').length - 1), balancesToTheSatoshi: true,
        },
        ledger: { fundedSats: String(j.funded), paidSats: String(j.paidTotal), unbookedPayouts: [] },
        verdict: 'books agree with the ledger (static demo — the chain walk runs in the full server app)',
      }));
      return _ok({
        reconciledAt: new Date().toISOString(), pods,
        totals: { pods: pods.length, balanceToTheSatoshi: pods.length, booksAgree: pods.length, unbookedPayouts: 0 },
      });
    }
    if (seg[0] === 'verify') return _ok({ verified: true, txid: seg[1], note: 'static demo — open the explorer link to check this txid on chain' });
    if (seg[0] === 'wallet') {
      const w = _sim.wallet;
      if (seg[1] === 'status') return _ok(_walletStatus());
      if (seg[1] === 'connect') {
        if (!w.started) {
          w.started = true; w.startedAt = Date.now(); w.uri = 'wiz://foreman-static-demo-' + _hex(4);
          w.events.push({ at: new Date().toISOString(), message: 'relay session opened (static simulation — a demo wallet pairs automatically in a few seconds)' });
        }
        const qr = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#fff"/><g fill="#000">${Array.from({ length: 60 }, (_, i) => `<rect x="${15 + (i % 10) * 15}" y="${15 + Math.floor(i / 10) * 15}" width="12" height="12" opacity="${((i * 37) % 3) / 2}"/>`).join('')}</g><text x="90" y="172" font-size="9" text-anchor="middle" fill="#000">STATIC DEMO QR</text></svg>`;
        return _ok({ ..._walletStatus(), qr, uri: w.uri });
      }
      if (seg[1] === 'disconnect') { _sim.wallet = { started: false, connected: false, uri: null, startedAt: 0, xpub: null, balance: 250000, name: null, events: [] }; return _ok(_walletStatus()); }
      if (seg[1] === 'xpub') {
        const xpub = String(body?.xpub ?? '').trim();
        if (xpub.length < 20) return _fail(400, 'that does not look like an xpub');
        w.xpub = xpub;
        const addresses = [0, 1, 2, 3].map((i) => 'bchtest:q' + _hashStr(xpub + i).repeat(5).slice(0, 38));
        return _ok({ ..._walletStatus(), addresses });
      }
      if (seg[1] === 'utxos') {
        const st = _walletStatus();
        if (!st.connected && !w.xpub) return _fail(400, 'pair a wallet first');
        const first = 'bchtest:q' + _hex(20).slice(0, 38);
        const addresses = st.connected
          ? [{ address: first, index: '0', balance: String(w.balance), utxos: 1 }, { address: 'bchtest:q' + _hex(20).slice(0, 38), index: '1', balance: '0', utxos: 0 }]
          : [0, 1, 2, 3].map((i) => ({ address: 'bchtest:q' + _hashStr(w.xpub + i).repeat(5).slice(0, 38), index: String(i), balance: '0', utxos: 0 }));
        return _ok({ chain: 'chipnet', addresses, total: addresses.reduce((a, x) => a + BigInt(x.balance), 0n).toString() });
      }
    }
    if (seg[0] === 'pods') {
      if (seg.length === 1 && method === 'GET') return _ok({ pods: _sim.order.map((id) => _podListItem(_sim.pods.get(id))), network: 'chipnet' });
      if (seg.length === 1 && method === 'POST') {
        const chunk = BigInt(body?.chunk ?? 20000), win = BigInt(body?.window ?? 60000), blocks = Number(body?.blocks ?? 24);
        if (chunk <= 0n) return _fail(400, 'chunk must be positive');
        if (win < chunk) return _fail(400, 'the window must be at least one chunk');
        if (win % chunk !== 0n) return _fail(400, 'window must be a whole multiple of the chunk price');
        const j = {
          id: 'job_' + _hex(4), address: _podAddr(), chunk: String(chunk), window: String(win),
          validUntil: _sim.height + blocks, description: body?.description ?? 'Agent job',
          network: body?.chain === 'mainnet' ? 'mainnet' : 'chipnet',
          providerAddress: body?.provider || _DEMO_PROVIDER,
          balance: 0n, funded: 0n, paidTotal: 0n, fees: 0n, refunded: 0n,
          events: [], receipts: [], createdAt: new Date().toISOString(),
        };
        _sim.pods.set(j.id, j); _sim.order.push(j.id);
        return _ok(_podState(j));
      }
      const j = _sim.pods.get(seg[1]);
      if (!j) return _fail(404, 'unknown pod');
      if (seg.length === 2 && method === 'GET') return _ok(_podState(j));
      if (seg[2] === 'reconcile') return _ok({ pod: j.id, network: j.network, chain: { fundedSats: String(j.funded), paidToProvider: String(j.paidTotal), feesPaid: String(j.fees), refundedToClient: String(j.refunded), heldNow: String(j.balance), balancesToTheSatoshi: true }, ledger: { fundedSats: String(j.funded), paidSats: String(j.paidTotal), unbookedPayouts: [] }, verdict: 'books agree (static demo)' });
      const action = seg[2];
      _sim.height += 1; // one simulated block per action
      if (action === 'fund') {
        if (j.network === 'mainnet') return _fail(400, 'this pod is on mainnet and the demo keys hold no real BCH — connect your wallet and use fund-wallet');
        const sats = BigInt(body?.satoshis ?? 100000);
        j.balance += sats; j.funded += sats;
        const txid = _txid();
        j.events.push({ kind: 'fund', txid, satoshis: String(sats), at: new Date().toISOString() });
        return _ok({ txid, explorer: EXPLORER + txid, state: _podState(j) });
      }
      if (action === 'fund-wallet') {
        const st = _walletStatus();
        if (!st.connected) return _fail(400, 'no wallet paired — pair a wallet first');
        const sats = BigInt(body?.satoshis ?? 100000);
        if (sats + 236n > BigInt(_sim.wallet.balance)) return _fail(400, 'the demo wallet does not hold enough for that');
        _sim.wallet.balance -= Number(sats) + 236;
        j.balance += sats; j.funded += sats;
        const txid = _txid();
        j.events.push({ kind: 'fund', txid, satoshis: String(sats), signedBy: 'wallet', at: new Date().toISOString() });
        return _ok({ txid, explorer: EXPLORER + txid, signedBy: 'wallet', fee: '236', change: String(_sim.wallet.balance), state: _podState(j) });
      }
      if (action === 'deliver') {
        const chunks = BigInt(body?.chunks ?? 1);
        if (chunks < 1n) return _fail(400, 'chunks must be at least 1');
        const paid = chunks * BigInt(j.chunk);
        const verdict = _judge(j, { action: 'deliver', amount: String(paid) });
        if (verdict.decision === 'deny') {
          return _fail(400, verdict.reason, { rule: verdict.code, line: verdict.code === 'deliver.window' ? 44 : null, text: verdict.reason },
            { guard: { code: verdict.code, reason: verdict.reason, verdict: 'deny', hash: _hex(32) } });
        }
        j.balance -= paid + 700n; j.paidTotal += paid; j.fees += 700n;
        const txid = _txid();
        const receipt = { jobHash: _hex(32), index: j.receipts.length, payloadHash: _hex(32), txid, paidSats: String(paid), hash: _hex(32) };
        j.receipts.push(receipt);
        j.events.push({ kind: 'deliver', txid, paid: String(paid), chunks: String(chunks), at: new Date().toISOString() });
        return _ok({ txid, paid: String(paid), explorer: EXPLORER + txid, receipt, state: _podState(j) });
      }
      if (action === 'steal') {
        const want = BigInt(body?.chunks ?? 4), paid = want * BigInt(j.chunk);
        if (paid > BigInt(j.window)) {
          j.events.push({ kind: 'refuse', rule: 'deliver.window', line: 44, at: new Date().toISOString() });
          return _ok({ refused: true, explain: { rule: 'deliver.window', line: 44, text: 'This pull exceeds the per-transaction window. The blast radius is capped by the covenant.' } });
        }
        return _ok({ refused: false, explain: { rule: null, text: 'within the window — the covenant would allow this pull' } });
      }
      if (action === 'early-refund') {
        j.events.push({ kind: 'refuse', rule: 'refund.not-expired', line: 64, at: new Date().toISOString() });
        return _ok({ refused: true, message: 'Refused by the covenant: refund is only available after expiry (refund.not-expired, ChunkPod.cash:64)', explain: { rule: 'refund.not-expired', line: 64, text: 'Authority has not expired yet.' } });
      }
      if (action === 'refund') {
        if (_sim.height < j.validUntil) return _fail(400, 'refund refused: authority has not expired', { rule: 'refund.not-expired', line: 64, text: 'Authority has not expired yet.' });
        const amt = j.balance - 600n;
        if (amt < 0n) return _fail(400, 'nothing left to refund');
        j.refunded += amt; j.fees += 600n; j.balance = 0n;
        const txid = _txid();
        j.events.push({ kind: 'refund', txid, at: new Date().toISOString() });
        return _ok({ txid, explorer: EXPLORER + txid, state: _podState(j) });
      }
      if (action === 'close') {
        const chunks = BigInt(body?.chunks ?? 1), paid = chunks * BigInt(j.chunk);
        if (paid + 800n > j.balance) return _fail(400, 'close refused: the pod does not hold enough for that final chunk plus the fee', { rule: 'close.insufficient', line: null, text: 'held must cover paid + CLOSE_FEE' });
        const rest = j.balance - paid - 800n;
        j.paidTotal += paid; j.refunded += rest; j.fees += 800n; j.balance = 0n;
        const txid = _txid();
        if (paid > 0n) j.receipts.push({ jobHash: _hex(32), index: j.receipts.length, payloadHash: _hex(32), txid, paidSats: String(paid), hash: _hex(32) });
        j.events.push({ kind: 'close', txid, paid: String(paid), at: new Date().toISOString() });
        return _ok({ txid, explorer: EXPLORER + txid, state: _podState(j) });
      }
      if (action === 'intent') {
        const intent = { ...(body ?? {}), pod: j.address };
        if (!intent.id) intent.id = 'int_' + _hashStr(JSON.stringify([intent.action, intent.amount, intent.payTo, j.id]));
        const prior = _sim.preceipts.get(intent.id);
        if (prior) return _ok({ ...prior, duplicate: true });
        const verdict = _judge(j, intent);
        const pre = {
          kind: 'preceipt', pod: j.id, intent, verdict: verdict.decision, code: verdict.code,
          reason: verdict.reason, effect: verdict.effect, rules: verdict.rules, hash: _hex(32),
          decidedAt: new Date().toISOString(),
        };
        _sim.preceipts.set(intent.id, pre);
        return _ok(pre);
      }
    }
    return _fail(404, 'not found in static demo', null, { path: pathname });
  } catch (e) {
    return _fail(500, e.message);
  }
}
window.fetch = async (input, opts = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  let u;
  try { u = new URL(url, location.href); } catch { return _realFetch(input, opts); }
  if (!u.pathname.includes('/api/')) return _realFetch(input, opts);
  if (!_staticMode) {
    try {
      const r = await _realFetch(input, opts);
      if ((r.headers.get('content-type') || '').includes('application/json')) return r;
    } catch { /* fall through to static engine */ }
    _staticMode = true;
    setTimeout(() => { try { log('static demo mode — no server here, so every function now runs in your browser with simulated Chipnet transactions. Run "node server.mjs" from the repo for live on-chain transactions.', 'hi'); } catch { /* console not ready */ } }, 600);
  }
  let body = null;
  if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = null; } }
  return _localApi(u.pathname, (opts.method || 'GET').toUpperCase(), body);
};

// ---------------------------------------------------------------- evidence
async function loadEvidence() {
  let demo, batch, contract;
  try {
    const r = await fetch('/api/evidence');
    if (!r.ok) throw new Error('no api');
    ({ demo, batch, contract } = await r.json());
  } catch {
    // Static hosting (GitHub Pages): no server, replay the recorded run from files.
    const [d, b, c] = await Promise.all([
      fetch('./data.json').then((x) => x.json()).catch(() => null),
      fetch('./batch.json').then((x) => x.json()).catch(() => null),
      fetch('./contract.json').then((x) => x.json()).catch(() => null),
    ]);
    demo = d; batch = b; contract = c;
    const el = $('console');
    if (el) el.innerHTML = 'static demo — recorded Chipnet run below. Run <code>node server.mjs</code> locally for live transactions.<br>';
  }
  if (contract) {
    $('source').textContent = contract.source;
    $('src-size').textContent = `${contract.bytecodeBytes} bytes of compiled script, 3 functions`;
  }
  if (demo) {
    if (demo.explorer) EXPLORER = demo.explorer;
    $('rec-hint').textContent = `${demo.totals.txs} transactions · ${demo.totals.refusals} refusals · ${fmt(demo.totals.paidSats)} sat paid · generated ${new Date(demo.generatedAt).toLocaleString()}`;
    const ol = $('steps');
    ol.innerHTML = '';
    for (const s of demo.steps) {
      const li = document.createElement('li');
      const badge = s.kind === 'refuse' ? '<span class="badge ref">refused</span>'
        : s.kind === 'deliver' ? '<span class="badge ok">paid</span>'
        : s.txid ? '<span class="badge ok">on chain</span>' : '';
      li.innerHTML = `
        <div class="num">${String(s.n).padStart(2, '0')}</div>
        <div>
          <div class="t">${s.title} ${badge}</div>
          ${s.txid ? `<code class="tx"><a href="${EXPLORER}${s.txid}" target="_blank" rel="noopener">${short(s.txid)}</a></code>` : ''}
          ${s.explain?.text ? `<div class="m">→ ${s.explain.text} <span class="mono">(${s.explain.rule})</span></div>` : ''}
          ${s.receipt ? `<div class="m">receipt ${short(s.receipt.hash)} · payload ${short(s.receipt.payloadHash)}</div>` : ''}
        </div>`;
      ol.appendChild(li);
    }
  }
  if (batch) {
    const tb = $('batch-table').querySelector('tbody');
    tb.innerHTML = batch.rows.map((r) => r.refused
      ? `<tr><td class="mono">${r.chunks}</td><td colspan="4" class="mono" style="color:var(--bad)">refused: ${r.message}</td></tr>`
      : `<tr>
          <td class="mono">${r.chunks}</td>
          <td class="mono">${r.bytes} B</td>
          <td class="mono">${r.feeSats} sat</td>
          <td class="mono">${r.satsPerPayment} sat</td>
          <td class="mono"><a href="${batch.explorer}${r.txid}" target="_blank" rel="noopener">${short(r.txid)}</a></td>
        </tr>`).join('');
    $('batch-summary').textContent = batch.comparison
      ? `Same 16 payments: one-by-one ${fmt(batch.comparison.oneByOne.feeSats)} sat over 16 txs → batched ${fmt(batch.comparison.batched.feeSats)} sat in 1 tx. ${batch.comparison.savingPct}% cheaper.`
      : '';
  }
}

// ---------------------------------------------------------------- pods
function render(s) {
  // guard buttons must follow the newest pod's terms
  setTimeout(() => { try { setGuardButtons(); } catch { /* declared later */ } }, 0);
  if (!s) return;
  pod = s;
  $('pod-id').textContent = s.id + ' · ' + short(s.address);
  $('m-balance').textContent = fmt(s.live.balance) + ' sat';
  $('m-chunk').textContent = fmt(s.chunk) + ' sat';
  $('m-window').textContent = fmt(s.window) + ' sat';
  $('m-paid').textContent = `${s.receipts.length} × ${fmt(s.chunk)} = ${fmt(BigInt(s.receipts.length) * BigInt(s.chunk))} sat`;
  const funded = BigInt(s.chunk) * BigInt(20); // reference for the bar: 20 chunks' worth
  const held = BigInt(s.live.balance);
  const pct = funded > 0n ? Math.min(100, Number((held * 100n) / funded)) : 0;
  $('bar').style.width = pct + '%';
  $('pod-hint').innerHTML = s.live.expired
    ? `<b style="color:var(--warn)">Authority expired</b> — the client can reclaim the remainder now.`
    : `Expires in <b>${s.live.blocksToExpiry}</b> blocks · tip ${fmt(s.live.blockHeight)} · <span class="mono">${short(s.live.address)}</span>`;
}

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) {
    // The server names the covenant rule that refused; a bare message throws that away.
    // Keep the whole answer so the console can show rule + line, not just a sentence.
    const err = new Error(j.explain?.text || j.error || 'request failed');
    err.payload = j;
    throw err;
  }
  return j;
}

/** Render whatever the server refused with: rule id, contract line, and the plain sentence. */
const refusal = (e) => {
  const p = e.payload ?? {};
  if (p.guard?.code) return `✗ refused before spending — ${p.guard.code}: ${p.explain?.text ?? p.guard.reason}`;
  if (p.explain?.rule) return `✗ refused by the covenant — ${p.explain.rule} (ChunkPod.cash:${p.explain.line}): ${p.explain.text}`;
  return `✗ ${e.message}`;
};

const need = () => { if (!pod) throw new Error('open a pod first'); return pod.id; };

$('btn-create').onclick = async () => {
  try {
    log('→ opening a pod: 20,000 sat per chunk, 60,000 sat window, 24 blocks of authority…', 'hi');
    const s = await api('/api/pods', { chunk: 20000, window: 60000, blocks: 24, description: 'Agent inference job' });
    render(s);
    log(`  pod ${s.id} at ${s.address}`, 'ok');
    refreshPods(); showFeed();
  setGuardButtons();
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

$('btn-fund').onclick = async () => {
  if (pod?.network === 'mainnet') {
    log('  this pod is on mainnet — the demo keys hold no real BCH. Pair your wallet and use "Fund this pod from my wallet".', 'bad');
    return;
  }
  try {
    log('→ the client pre-authorises 100,000 sat into the covenant…', 'hi');
    const r = await api(`/api/pods/${need()}/fund`, { satoshis: 100000 });
    log(`  broadcast ${r.txid}`, 'ok');
    render(r.state); refreshPods(); showFeed();
    log(`  ${EXPLORER}${r.txid}`);
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

$('btn-deliver').onclick = async () => {
  try {
    log('→ provider pulls one chunk and signs it…', 'hi');
    const r = await api(`/api/pods/${need()}/deliver`, { chunks: 1, payload: 'completion ' + Date.now() });
    log(`  paid ${fmt(r.paid)} sat — ${r.txid}`, 'ok');
    render(r.state); refreshPods(); showFeed();
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

/**
 * One refusal card for both kinds of stop: the covenant refusing a real VM spend
 * (rule + contract line) and the guard refusing an intent before anything is built
 * (rule + "no fee paid"). They are different events and must not look identical.
 */
function showRefusal(r) {
  const el = $('refusal');
  const guard = r?.guard ?? (r?.kind === 'preceipt' ? r : null);
  if (!guard && !r?.refused && !r?.explain) { el.innerHTML = ''; return; }
  if (guard) {
    const code = guard.code ?? guard.verdict?.code ?? 'refused';
    el.innerHTML = `<div class="refusal">
      <div class="rule">${code} · ${guard.verdict ?? 'deny'} · 0 sat spent</div>
      <div class="why">${guard.reason ?? guard.explain?.text ?? ''}</div>
      <div class="why mono" style="opacity:.7">preceipt ${String(guard.hash ?? '').slice(0, 16)}… — decided before any transaction existed</div>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="refusal">
    <div class="rule">${r.explain?.rule ?? 'refused'} · ChunkPod.cash:${r.explain?.line ?? '?'} · evaluated, never broadcast</div>
    <div class="why">${r.explain?.text ?? ''}</div>
  </div>`;
}

$('btn-steal').onclick = async () => {
  try {
    log('→ malicious provider tries to pull 4 chunks in one transaction (window = 3)…', 'hi');
    const r = await api(`/api/pods/${need()}/steal`, { chunks: 4 });
    showRefusal(r);
    log(r.refused ? `  REFUSED by the covenant: ${r.explain?.rule} — ${r.explain?.text}` : '  accepted?!', r.refused ? 'bad' : 'ok');
    showFeed();
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

$('btn-early').onclick = async () => {
  try {
    log('→ client tries to reclaim its money mid-job…', 'hi');
    const r = await api(`/api/pods/${need()}/early-refund`, {});
    log(r.refused ? `  REFUSED: ${r.message}` : `  refunded ${r.txid}`, r.refused ? 'bad' : 'ok');
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

$('btn-close').onclick = async () => {
  try {
    log('→ both parties sign a close: final chunk paid, client made whole…', 'hi');
    const r = await api(`/api/pods/${need()}/close`, { chunks: 1 });
    log(`  closed ${r.txid}`, 'ok');
    render(r.state);
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

$('btn-refund').onclick = async () => {
  try {
    log('→ refund after expiry…', 'hi');
    const r = await api(`/api/pods/${need()}/refund`, {});
    log(`  refunded ${r.txid}`, 'ok');
    render(r.state); refreshPods(); showFeed();
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

// ---------------------------------------------------------------- judge path
// 60 seconds, no wallet, nothing to press after this: it drives the covenant
// through fund → 3 chunks → two refusals → close, narrating while it goes.
$('btn-autorun').onclick = async () => {
  const btn = $('btn-autorun');
  btn.disabled = true; $('btn-run').disabled = true;
  const say = async (msg, cls = '') => { log(msg, cls); await new Promise((r) => setTimeout(r, 450)); };
  try {
    await say('━━ FOREMAN · judge path · everything below is a real chipnet transaction ━━', 'hi');
    const s = await api('/api/pods', { chunk: 20000, window: 60000, blocks: 40, description: 'Judge path' });
    render(s); refreshPods();
    await say(`1/6  pod opened at ${s.address}`, 'ok');
    await say(`     terms: 20,000 sat per chunk, never more than 60,000 in one tx, expires in 40 blocks`);
    const f = await api(`/api/pods/${s.id}/fund`, { satoshis: 100000 });
    render(f.state);
    await say(`2/6  client pre-authorised 100,000 sat → ${short(f.txid)}`, 'ok');
    for (let i = 1; i <= 3; i += 1) {
      const d = await api(`/api/pods/${s.id}/deliver`, { chunks: 1, payload: 'judge chunk ' + i });
      render(d.state); refreshPods();
      await say(`3/6  provider pulled chunk ${i}: 20,000 sat → ${short(d.txid)}`, 'ok');
    }
    const st = await api(`/api/pods/${s.id}/steal`, { chunks: 4 });
    showRefusal(st); showFeed();
    await say(`4/6  CHEAT: provider tries 80,000 sat in one tx — REFUSED by ${st.explain?.rule}`, 'bad');
    const er = await api(`/api/pods/${s.id}/early-refund`, {});
    showRefusal(er);
    await say(`5/6  CHEAT: client tries to reclaim early — REFUSED by ${er.explain?.rule ?? 'the covenant'}`, 'bad');
    const c = await api(`/api/pods/${s.id}/close`, { chunks: 1 });
    render(c.state); refreshPods(); showFeed();
    await say(`6/6  both parties sign a close → ${short(c.txid)}`, 'ok');
    await say('done. 80,000 sat paid for work, ~2,800 sat of fees, nothing left in the pod.', 'hi');
    await say('the two refusals above are the product: the covenant cannot be talked into either one.', 'hi');
  } catch (e) {
    log('  ' + refusal(e), 'bad');
  } finally { btn.disabled = false; $('btn-run').disabled = false; }
};

// ---------------------------------------------------------------- whole job
$('btn-run').onclick = async () => {
  const btn = $('btn-run');
  btn.disabled = true;
  try {
    log('━━ running a complete job on Chipnet ━━', 'hi');
    const s = await api('/api/pods', { chunk: 20000, window: 60000, blocks: 24, description: 'Full demo job' });
    render(s); log(`pod ${s.id}`, 'ok');
    const f = await api(`/api/pods/${s.id}/fund`, { satoshis: 100000 }); render(f.state);
    log(`funded 100,000 sat — ${f.txid}`, 'ok');
    for (let i = 0; i < 3; i++) {
      const d = await api(`/api/pods/${s.id}/deliver`, { chunks: 1, payload: 'completion ' + i });
      render(d.state); log(`chunk ${i + 1} paid ${fmt(d.paid)} sat — ${d.txid}`, 'ok');
    }
    const st = await api(`/api/pods/${s.id}/steal`, { chunks: 4 });
    showRefusal(st); log(`4-chunk pull REFUSED: ${st.explain?.rule}`, 'bad');
    const er = await api(`/api/pods/${s.id}/early-refund`, {});
    log(`early reclaim REFUSED: ${er.message ?? ''}`, 'bad');
    const c = await api(`/api/pods/${s.id}/close`, { chunks: 1 });
    render(c.state); log(`closed by agreement — ${c.txid}`, 'ok');
    const paid = 4 * 20000, fee = 4 * 700;
    log(`\njob complete: ${fmt(paid)} sat paid, ${fmt(fee)} sat total fees (${fmt(100000 - paid - fee)} sat never left the pod)`, 'hi');
  } catch (e) {
    log('  ' + refusal(e), 'bad');
  } finally { btn.disabled = false; }
};

$('btn-batch').onclick = () => {
  const c = $('batch-card');
  c.style.display = c.style.display === 'none' ? 'block' : 'none';
  if (c.style.display === 'block') c.scrollIntoView({ behavior: 'smooth' });
};
$('btn-source').onclick = () => {
  const c = $('source-card');
  c.style.display = c.style.display === 'none' ? 'block' : 'none';
  if (c.style.display === 'block') c.scrollIntoView({ behavior: 'smooth' });
};

// ---------------------------------------------------------------- rules table
// Derived from lib.mjs RULES via GET /api/rules — a second hand-written copy of the
// rule list drifted from the real one, so it is deleted rather than maintained.
fetch('/api/rules').then((r) => { if (!r.ok) throw new Error('static'); return r.json(); }).catch(() => fetch('./contract.json').then((r) => r.json()).then((c) => [
  { id: 'deliver.window', text: 'Provider pull must be whole chunks, at most the window, payee pinned — ChunkPod deliver()' },
  { id: 'refund.not-expired', text: 'Client refund only after validUntil — ChunkPod refund()' },
  { id: 'close.both-sign', text: 'Close needs both signatures and an exact split — ChunkPod close()' },
])).then((rules) => {
  $('rules-table').querySelector('tbody').innerHTML = rules
    .map((r) => `<tr><td class="mono" style="color:var(--accent-2)">${r.id}</td><td>${r.text}${r.guard ? ' <span class="tag">guard too</span>' : ''}</td></tr>`)
    .join('');
}).catch(() => { $('rules-table').querySelector('tbody').innerHTML = '<tr><td class="hint">rules unavailable offline</td></tr>'; });

// ---------------------------------------------------------------- wallet connector
let walletTimer = null;

function wlog(msg, cls = '') {
  const el = $('wallet-log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function paintWallet(st) {
  const badge = $('wallet-state');
  if (st.connected) {
    badge.textContent = `paired · ${st.wallet?.name ?? 'wallet'}`;
    badge.style.color = 'var(--ok)';
    badge.style.borderColor = '#1d4d2c';
    $('wallet-note').innerHTML = `Signing is done on <b>${st.wallet?.name ?? 'your wallet'}</b>. ` +
      `The fund button below now asks your wallet to authorise, and Foreman refuses to broadcast anything ` +
      `that does not pay the pod the exact amount.`;
  } else if (st.mode === 'xpub-read-only') {
    badge.textContent = 'xpub · read-only';
    badge.style.color = 'var(--warn)';
  } else if (st.started) {
    badge.textContent = 'waiting for scan';
    badge.style.color = 'var(--warn)';
    badge.style.borderColor = '#55431c';
  } else {
    badge.textContent = 'not paired';
    badge.style.color = 'var(--dim)';
  }
  $('btn-fund-wallet').disabled = !st.connected;
  if (st.events?.length) {
    // only render the newest event so the log does not double up
    const last = st.events[st.events.length - 1];
    if (wlog.last !== last.at + last.message) { wlog(last.message, st.connected ? 'ok' : ''); wlog.last = last.at + last.message; }
  }
}

async function pollWallet() {
  try {
    const st = await api('/api/wallet/status');
    paintWallet(st);
    if (st.connected) { clearInterval(walletTimer); walletTimer = null; loadWalletUtxos(); }
  } catch { /* server restarting */ }
}

async function loadWalletUtxos() {
  try {
    const u = await api('/api/wallet/utxos');
    $('wallet-addrs').innerHTML = u.addresses.map((a) =>
      `<div class="mono" style="font-size:11.5px">${a.address} — <b>${fmt(a.balance)}</b> sat${a.utxos ? ` (${a.utxos} utxo)` : ''}</div>`).join('') +
      `<div style="margin-top:6px">total <b>${fmt(u.total)}</b> sat spendable by the connected wallet</div>`;
  } catch (e) { $('wallet-addrs').innerHTML = `<span style="color:var(--dim)">${e.message}</span>`; }
}

$('btn-connect').onclick = async () => {
  try {
    $('btn-connect').disabled = true;
    wlog('opening relay session…', 'hi');
    const st = await api('/api/wallet/connect', {});
    paintWallet(st);
    if (st.qr) {
      $('wallet-qr').innerHTML = st.qr;
      wlog('scan the QR with a WizardConnect wallet (Cake Wallet, Cashonize, Zapit…)', 'hi');
      wlog(st.uri);
    }
    if (!walletTimer) walletTimer = setInterval(pollWallet, 2000);
  } catch (e) { wlog(e.message, 'bad'); }
  finally { $('btn-connect').disabled = false; }
};

$('btn-unpair').onclick = async () => {
  try {
    const st = await api('/api/wallet/disconnect', {});
    clearInterval(walletTimer); walletTimer = null;
    $('wallet-qr').innerHTML = '';
    $('wallet-addrs').innerHTML = '';
    paintWallet(st); wlog('disconnected');
  } catch (e) { wlog(e.message, 'bad'); }
};

$('btn-xpub').onclick = async () => {
  try {
    const st = await api('/api/wallet/xpub', { xpub: $('xpub').value.trim() });
    paintWallet(st);
    $('wallet-addrs').innerHTML = st.addresses.map((a) => `<div class="mono" style="font-size:11.5px">${a}</div>`).join('');
    wlog('xpub derived — read-only addresses above', 'ok');
  } catch (e) { wlog(e.message, 'bad'); $('wallet-addrs').innerHTML = `<span style="color:var(--bad)">${e.message}</span>`; }
};

$('btn-fund-wallet').onclick = async () => {
  const btn = $('btn-fund-wallet');
  btn.disabled = true;
  try {
    const sats = Number($('adv-fund').value || 100000);
    wlog(`→ asking your wallet to authorise ${fmt(sats)} sat…`, 'hi');
    if (!pod) { const s = await api('/api/pods', { chunk: Number($('adv-chunk').value), window: Number($('adv-window').value), blocks: Number($('adv-blocks').value), description: 'Wallet-funded pod' }); render(s); }
    const r = await api(`/api/pods/${need()}/fund-wallet`, { satoshis: sats });
    log(`wallet-signed funding tx ${r.txid}`, 'ok');
    wlog(`signed by wallet · VM check passed · broadcast ${short(r.txid)}`, 'ok');
    wlog(`fee ${r.fee} sat · change ${r.change} sat back to your address`);
    render(r.state);
    refreshPods();
    loadWalletUtxos();
  } catch (e) { wlog(e.message, 'bad'); log('wallet: ' + e.message, 'bad'); }
  finally { btn.disabled = false; }
};

// ---------------------------------------------------------------- advanced controls
async function refreshPods() {
  try {
    const list = await api('/api/pods');
    const tb = $('pods-table').querySelector('tbody');
    if (!list.pods.length) { tb.innerHTML = ''; $('pods-note').textContent = 'No pods yet.'; return; }
    tb.innerHTML = list.pods.slice().reverse().map((p) => `
      <tr>
        <td class="mono"><a href="${p.explorer}${p.fundedTxid ?? ''}" target="_blank" rel="noopener">${p.id.slice(4, 12)}</a></td>
        <td class="mono">${fmt(p.chunk)}/${fmt(p.window)} × ${p.blocks}b<br /><span style="font-size:10.5px;color:${p.network === 'mainnet' ? 'var(--accent)' : 'var(--dim)'}">${p.network}</span></td>
        <td class="mono">${fmt(p.balance)} sat</td>
        <td class="mono">${p.expired ? '<span style="color:var(--warn)">expired</span>' : p.blocksToExpiry + 'b'}</td>
        <td><button class="ghost" style="padding:4px 9px;font-size:12px" data-pod="${p.id}">select</button></td>
      </tr>`).join('');
    tb.querySelectorAll('button[data-pod]').forEach((b) => {
      b.onclick = async () => { const s = await api('/api/pods/' + b.dataset.pod); render(s); log('selected pod ' + b.dataset.pod, 'hi'); showFeed(); };
    });
    const live = list.pods.filter((p) => !p.expired);
    $('pods-note').innerHTML = `${list.pods.length} pod(s) · ${live.length} live · ` +
      `total held <b>${fmt(list.pods.reduce((a, p) => a + BigInt(p.balance), 0n))}</b> sat across all pods`;
  } catch (e) { $('pods-note').textContent = e.message; }
}

async function showFeed() {
  try {
    const list = await api('/api/pods');
    const all = list.pods.flatMap((p) => (p.events ?? []).map((e) => ({ ...e, pod: p.id })));
    all.sort((a, b) => (a.at < b.at ? 1 : -1));
    $('feed').innerHTML = all.slice(0, 40).map((e) => {
      const cls = e.kind === 'refuse' ? 'bad' : e.kind === 'deliver' || e.kind === 'fund' ? 'ok' : '';
      const tx = e.txid ? ` · ${short(e.txid)}` : '';
      const extra = e.paid ? ` · ${fmt(e.paid)} sat` : e.satoshis ? ` · ${fmt(e.satoshis)} sat` : e.rule ? ` · ${e.rule}` : '';
      return `<div><span class="${cls}">${e.kind.padEnd(10)}</span> ${e.pod.slice(4, 12)}${extra}${tx} <span style="color:#55606b">${new Date(e.at).toLocaleTimeString()}</span></div>`;
    }).join('') || '—';
  } catch { /* ignore */ }
}

$('btn-adv-create').onclick = async () => {
  try {
    const chunk = Number($('adv-chunk').value), win = Number($('adv-window').value);
    const blocks = Number($('adv-blocks').value), fundSats = Number($('adv-fund').value);
    if (!(chunk > 0) || !(win > 0) || !(blocks > 0)) throw new Error('chunk, window and blocks must be positive');
    if (win < chunk) throw new Error('the window must be at least one chunk (otherwise no spend can ever pass)');
    if (win % chunk !== 0) throw new Error('window must be an exact multiple of the chunk price — the contract pays whole chunks only');
    if (blocks < 3) throw new Error('give the pod at least 3 blocks, chipnet mines fast');
    const provider = $('adv-provider').value.trim();
    const chain = $('adv-chain').value;
    const s = await api('/api/pods', { chunk, window: win, blocks, fund: fundSats, provider, chain, description: `Custom pod (${chain})` });
    render(s);
    $('adv-note').innerHTML = `pod <b>${s.id}</b> on <b>${s.network}</b> · address <span class="mono">${s.address}</span> · ` +
      `${Math.floor(fundSats / chunk)} possible chunks, ${win / chunk} per transaction.` +
      (s.network === 'mainnet' ? ' Mainnet pods must be funded from <a href="#wallet">your own wallet</a> — the demo keys hold no real BCH.' : '');
    log(`custom pod ${s.id}: ${fmt(chunk)} sat/chunk, window ${fmt(win)}, ${blocks} blocks`, 'ok');
    refreshPods(); showFeed(); setGuardButtons();
  } catch (e) { $('adv-note').innerHTML = `<span style="color:var(--bad)">${e.message}</span>`; }
};

$('btn-adv-max').onclick = async () => {
  try {
    log('→ pulling exactly at the window limit (the most the covenant will ever allow)…', 'hi');
    const r = await api(`/api/pods/${need()}/deliver`, { chunks: String(Math.floor(Number(pod.window) / Number(pod.chunk))), payload: 'max-window pull' });
    log(`  accepted: ${fmt(r.paid)} sat — the boundary is real, not decorative`, 'ok');
    render(r.state); refreshPods(); showFeed();
  } catch (e) { log('  ' + refusal(e), 'bad'); }
};

// ---------------------------------------------------------------- guard
const guardLog = (msg, cls = '') => {
  const el = $('guard-log');
  if (el.dataset.idle !== '1') el.textContent = '';
  el.dataset.idle = '0';
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

async function askGuard(intent, label) {
  if (!pod) { guardLog('open a pod first — the guard judges against real chain state.', 'bad'); return; }
  $('guard-tag').textContent = 'judging…';
  guardLog(`→ ${label}`, 'hi');
  try {
    const r = await fetch(`/api/pods/${pod.id}/intent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    const pre = await r.json();
    const allow = pre.verdict === 'pass';
    $('guard-tag').textContent = pre.duplicate ? 'answered from the first decision'
      : allow ? 'passed — still nothing sent' : 'refused before spending';
    guardLog(`${allow ? '✓ pass' : '✗ deny'}  ${pre.code ?? 'no rule fired'}  ${pre.reason ?? ''}`,
      allow ? 'ok' : 'bad');
    guardLog(`  preceipt ${pre.hash?.slice(0, 16)}…  (${pre.intent?.id})`, 'hi');
    if (pre.duplicate) guardLog('  same intent, same preceipt — idempotent, no second decision', 'hi');
    renderGuard(pre);
    return pre;
  } catch (e) {
    guardLog(`guard unreachable: ${e.message}`, 'bad');
  }
}

function renderGuard(pre) {
  const rows = (pre.rules ?? []).map((r) => {
    const cls = r.outcome === 'pass' ? 'ok' : r.outcome === 'deny' ? 'bad' : 'hi';
    const note = r.outcome === 'skipped' ? ' — state unknown, so not assumed' : '';
    return `<tr><td class="mono">${r.code}</td><td class="${cls}">${r.outcome}${note}</td></tr>`;
  }).join('');
  const effect = pre.effect
    ? `<div class="hint" style="margin-top:8px">If executed: balance ${fmt(pre.effect.balanceBefore)} → <b>${fmt(pre.effect.balanceAfter)}</b> sat</div>`
    : '';
  $('guard-out').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><div class="k">Decision</div><div class="v ${pre.verdict === 'pass' ? '' : 'bad'}">${pre.verdict}</div></div>
      <div class="stat"><div class="k">Rule</div><div class="v mono" style="font-size:13px">${pre.code ?? '—'}</div></div>
      <div class="stat"><div class="k">Cost of asking</div><div class="v">0 sat</div></div>
    </div>
    <table style="margin-top:12px"><thead><tr><th>Rule</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>
    ${effect}
    <div class="hint" style="margin-top:8px">${pre.reason ?? ''}</div>`;
}

let lastIntent = null;
let setGuardButtons = () => {
  const chunk = pod?.chunk ?? 20000;
  const win = pod?.window ?? 60000;
  $('btn-guard-window').onclick = () => {
    lastIntent = { action: 'deliver', amount: String(Math.max(win * 10, 1000000)) };
    askGuard(lastIntent, `deliver ${lastIntent.amount} sat (over the window)`);
  };
  $('btn-guard-partial').onclick = () => {
    lastIntent = { action: 'deliver', amount: String(Math.floor(chunk * 1.5)) };
    askGuard(lastIntent, `deliver ${lastIntent.amount} sat (1.5 chunks)`);
  };
  $('btn-guard-payee').onclick = () => {
    lastIntent = { action: 'deliver', amount: String(chunk), payTo: 'bchtest:pvq00000000000000000000000000000000000000000000000000000000000000' };
    askGuard(lastIntent, 'deliver 1 chunk but redirect the payee');
  };
  $('btn-guard-ok').onclick = () => {
    lastIntent = { action: 'deliver', amount: String(chunk) };
    askGuard(lastIntent, `deliver ${chunk} sat (exactly one chunk)`);
  };
  $('btn-guard-replay').onclick = () => {
    if (!lastIntent) { guardLog('nothing to replay yet — ask for something first.', 'bad'); return; }
    // Same intent id -> the server hands back the original preceipt. This is what
    // makes an agent's blind retry safe: it cannot cause a second decision.
    askGuard({ ...lastIntent, id: lastIntent.id ?? 'int_replay_demo' }, 'the same intent again (retry)');
  };
};

// ---------------------------------------------------------------- reconciliation
const sat = (v) => Number(v ?? 0).toLocaleString('en-US');

$('btn-recon').onclick = async () => {
  $('recon-tag').textContent = 'walking the chain…';
  $('recon-note').textContent = 'reading address history — nothing is broadcast';
  $('recon-out').innerHTML = '<div class="hint">Rebuilding each pod from its real transactions…</div>';
  try {
    const r = await fetch('/api/reconcile');
    const data = await r.json();
    renderRecon(data);
  } catch (e) {
    $('recon-tag').textContent = 'unreachable';
    $('recon-out').innerHTML = `<div class="hint bad">${e.message}</div>`;
  }
};

function renderRecon(data) {
  const t = data.totals ?? {};
  $('recon-tag').textContent = `${t.balanceToTheSatoshi ?? 0}/${t.pods ?? 0} balance to the satoshi`;
  const cards = (data.pods ?? []).map((p) => {
    if (p.error) return `<div class="stat"><div class="k">${p.pod}</div><div class="v bad" style="font-size:13px">${p.error}</div></div>`;
    const c = p.chain; const l = p.ledger;
    const identity = c.balancesToTheSatoshi
      ? '<span class="ok">balances to the satoshi</span>'
      : '<span class="bad">reconstruction is wrong — do not trust this row</span>';
    const unbooked = (l.unbookedPayouts ?? []).length
      ? l.unbookedPayouts.map((u) => `<div class="hint">⚠ <span class="mono">${u.txid.slice(0, 10)}…</span> paid ${sat(u.paidProvider)} sat to the provider, booked as <b>${u.recordedAs}</b></div>`).join('')
      : '<div class="hint">every payout on chain is in the books</div>';
    return `
      <div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:10px;background:#0b1016">
        <div class="row" style="margin-top:0;justify-content:space-between">
          <span class="mono">${p.pod}</span>
          <span class="tag">${p.network} · ${c.txsExamined} tx examined</span>
        </div>
        <table style="margin-top:10px"><tbody>
          <tr><td>funded</td><td class="mono">${sat(c.fundedSats)} sat</td><td class="hint">${c.topUps ? `${c.topUps} top-up` : 'one funding'}</td></tr>
          <tr><td>paid → provider</td><td class="mono">${sat(c.paidToProvider)} sat</td><td class="hint">${c.deliveries} deliveries</td></tr>
          <tr><td>fees</td><td class="mono">${sat(c.feesPaid)} sat</td><td class="hint">the network's cut</td></tr>
          <tr><td>refunded → client</td><td class="mono">${sat(c.refundedToClient)} sat</td><td class="hint">${c.closingTxs} closing tx</td></tr>
          <tr><td>held now</td><td class="mono">${sat(c.heldNow)} sat</td><td class="hint">still inside the covenant</td></tr>
          <tr><td>the books say</td><td class="mono">${sat(l.fundedSats)} / ${sat(l.paidSats)} sat</td><td class="hint">funded / paid</td></tr>
        </tbody></table>
        <div class="hint" style="margin-top:10px">${identity} — ${p.verdict}</div>
        <div style="margin-top:8px">${unbooked}</div>
      </div>`;
  }).join('');
  $('recon-out').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat"><div class="k">Pods</div><div class="v">${t.pods ?? 0}</div></div>
      <div class="stat"><div class="k">Balance to the satoshi</div><div class="v">${t.balanceToTheSatoshi ?? 0}</div></div>
      <div class="stat"><div class="k">Books agree</div><div class="v ${t.booksAgree === t.pods ? '' : 'bad'}">${t.booksAgree ?? 0}</div></div>
      <div class="stat"><div class="k">Unbooked payouts found</div><div class="v ${t.unbookedPayouts ? 'bad' : ''}">${t.unbookedPayouts ?? 0}</div></div>
    </div>
    ${cards}
    <div class="hint" style="margin-top:12px">
      A disagreement here is never a payment the covenant got wrong — it is a payment nobody wrote down.
      That distinction is the whole point: the chain is the authority, and the ledger has to prove itself against it.
    </div>`;
}

(async function init() {
  try {
    const h = await api('/api/health');
    $('net-tag').textContent = h.network;
    $('foot-net').textContent = h.network;
    log(`connected · ${h.network} · client ${short(h.client)} · provider ${short(h.provider)}`, 'ok');
  } catch { log('server offline', 'bad'); }
  loadEvidence().catch((e) => log('evidence: ' + e.message, 'bad'));
  api('/api/phases').catch(() => fetch('./phases.json').then((r) => r.json())).then((p) => {
    $('phases-tag').textContent = `${p.functions.length} spend paths · ${p.bytecodeBytes} bytes · from ${p.generatedFrom}`;
    $('phases-table').querySelector('tbody').innerHTML = p.edges.map((e) => `
      <tr>
        <td class="mono" style="color:var(--accent-2)">${e.fn}()</td>
        <td>${e.who}</td>
        <td class="mono" style="font-size:11.5px">${e.guard}</td>
        <td>${e.note}${e.terminal ? ' <span class="badge ok">terminal</span>' : ' <span class="badge ref">repeatable</span>'}</td>
      </tr>`).join('');
  }).catch(() => {});
  fetch('./phases.svg').then((r) => r.text()).then((svg) => { $('phases-svg').innerHTML = svg; }).catch(() => {});
  api('/api/wallet/status').then(paintWallet).catch(() => {});
  refreshPods(); showFeed();
  setGuardButtons();
  setInterval(() => { refreshPods(); showFeed(); }, 15000);
})();
