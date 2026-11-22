# Foreman

> **BCH BLAZE 2026 — Mainnet Track**
> - **Live demo:** https://eren-dotcom.github.io/foreman/
> - **Slides:** https://eren-dotcom.github.io/foreman/docs/presentation.html
> - **Repo:** https://github.com/Eren-dotcom/foreman
> - **EMBER2026 (Community Choice):** `bitcoincash:zqcj6f9nx5ce6q3e469nge8hmlsu3uv2gshqpqxjg9`
> - **Wallet connectors:** WizardConnect (`wiz://`) · XO Template · Paytaca · Selene · Cashonize · Zapit · xpub read-only
> - **Mainnet:** In the live app (local server), set Chain = mainnet in Advanced and fund from your own wallet — that sends a real BCH mainnet transaction. The hosted static demo replays the recorded Chipnet run; the full server demo runs live transactions.

**Pre-authorised, refundable pay for AI work, enforced by a Bitcoin Cash covenant.**

An agent locks a budget on BCH. A provider can only pull *whole chunks* as it delivers, never more than the
window in one transaction. Whatever isn't delivered is refunded by the contract when the authority expires.

```
agent ──funds 100,000 sat──► [ ChunkPod covenant ]
                                  │
   provider delivers ─────────────┤ deliver()  → pays a whole chunk, remainder returns to the pod
   provider over-reaches ─────────┤ deliver()  → ✗ refused by the VM (window)
   payment redirected ────────────┤ deliver()  → ✗ refused (payee pinned)
   client panics mid-job ─────────┤ refund()   → ✗ refused until expiry
   job stops, window closes ──────┘ refund()   → everything left returns to the agent
```

- **Contract:** 930 bytes of CashScript 0.14, three spend paths, 29 named covenant rules.
- **Tests:** 49 offline assertions — 16 against the real BCH VM (10 cheat paths), plus the wallet, guard,
  reconciliation and UI-wiring suites. No relay, no network.
- **Live:** fund → 3 chunk payments → refused theft → refused early reclaim → close, all on chipnet.
- **Batching:** 16 payments in one 514-byte transaction for one 700-sat fee (93.8% cheaper than one by one).

## Quickstart

```bash
npm install
npm test          # 16 covenant tests, real VM
node server.mjs   # the app + API on http://localhost:4173
```

Open the app, then:

| button | what happens |
|---|---|
| **Open a pod** | a `ChunkPod` is instantiated: 20,000 sat/chunk, 60,000 sat window, 24 blocks of authority |
| **Fund 100,000 sat** | a real transaction pre-authorises the budget into the covenant |
| **Pull a chunk** | the provider signs and takes one whole chunk; the rest returns to the pod |
| **Try to steal** | a 4-chunk pull is **evaluated and refused** — `deliver.window`, line 44 |
| **Try an early reclaim** | the client cannot pull money out mid-job — `refund.not-expired`, line 64 |
| **Close by agreement** | both keys: provider paid for the final chunk, client made whole for the rest |
| **Refund after expiry** | authority ends, the money does not |

Every valid action prints a real txid with an explorer link. Invalid actions print the exact covenant rule that
refused them. Click **Run the whole job live** to do all of it in one go.

## Scripted runs

```bash
node scripts/demo.mjs        # a complete job on chipnet → web/data.json (the page's recorded evidence)
node scripts/batch-run.mjs   # the batching measurement, 1 → 16 chunks per transaction → web/batch.json
node scripts/chipnet-run.mjs --new        # fresh identities + faucet funding
node scripts/chipnet-run.mjs --steal      # the refusal, printed with its rule
node scripts/fund-server.mjs 3000000      # top up the web demo's wallets from the chipnet faucet
```

## How it works

```
contract ChunkPod(bytes20 clientPkh, bytes20 providerPkh, int chunk, int window, int validUntil)

deliver(providerPk, providerSig)   // the provider pulls payment for whole chunks
  require hash160(providerPk) == providerPkh      // only the named provider
  require checkSig(providerSig, providerPk)
  require tx.inputs.length == 1                   // one pod per transaction
  require paid >= chunk
  require paid <= window                          // ← the blast-radius cap
  require paid % chunk == 0                       // whole chunks only
  require held >= paid + FEE
  require tx.outputs[0] pays providerPkh          // payee is pinned
  require tx.outputs.length == 2
  require tx.outputs[1] is this same pod, exact remainder

refund(clientPk, clientSig)        // after expiry the client takes the rest
  require hash160(clientPk) == clientPkh
  require checkSig(clientSig, clientPk)
  require tx.time >= validUntil                   // ← authority is time-bounded
  ... one output, to the client, exactly balance − REFUND_FEE

close(clientPk, clientSig, providerPk, providerSig)   // both agree, no waiting
  ... both signatures, exact split: paid + refund + CLOSE_FEE = balance
```

Read it in full: [`contracts/ChunkPod.cash`](contracts/ChunkPod.cash). The UI shows it too (**Read the contract**).

### Why the fee budgets are constants

`FEE`, `REFUND_FEE` and `CLOSE_FEE` are top-level constants so the covenant can check the remainder *to the
satoshi* (`tx.outputs[1].value == held - paid - FEE`). A production build would take a fee policy as a parameter,
or use a fee-aware covenant. This is a deliberate trade: exact arithmetic in exchange for a fixed budget.

## Receipts

Every delivery returns a receipt binding the job, the delivered payload and the payment:

```json
{
  "jobHash":     "sha256(canonical job definition)",
  "index":       2,
  "payloadHash": "sha256(the delivered work)",
  "txid":        "…",
  "paidSats":    "20000",
  "hash":        "sha256(all of the above)"
}
```

The covenant enforces money, not truth. The receipt is the honest seam: the payer can challenge a payload hash,
the provider can prove payment, and `GET /api/verify/:txid` re-reads the transaction from chain and confirms the
payee and amount.

## Refusing before spending: the guard and the preceipt

A receipt is written *after* the money moves. A **preceipt** is written after a decision and before
anything is built. `POST /api/pods/:id/intent` takes an intent — `{action, amount, payTo?}` — judges it
against the covenant's own rules on live chain state, and returns a hashed record:

```json
{
  "kind": "preceipt", "pod": "job_…", "verdict": "deny",
  "code": "deliver.window",
  "reason": "this would move 1000000 sat in one transaction; the window is 60000 sat",
  "effect": { "podBalanceBefore": "287900", "podBalanceAfter": "267200" },
  "rules": [{"code": "deliver.window", "outcome": "deny"}, …],
  "hash": "sha256(the decision and the chain state it was made against)"
}
```

Three properties make it useful rather than decorative:

- **A refusal is an answer.** Denials return `200`, with the rule that fired — not a `4xx` the agent has to parse.
- **Asking costs nothing.** No transaction is built, no fee is paid, no relay is touched. The guard restates
  the covenant one step earlier so a bad job never reaches the chain.
- **Retries are safe.** The same intent id returns the same preceipt (`"duplicate": true`), so a blind agent
  retry cannot cause a second decision, let alone a second payment.

Rule ids mirror `RULES` in `lib.mjs`, so `deliver.window` in a guard denial and `deliver.window` in a covenant
refusal are the same sentence. Where state is unknown a rule returns `skipped` rather than assuming the best.
The guard is a courtesy; the covenant remains the final authority.

## Reconciliation: the books have to prove themselves

`GET /api/reconcile`, `GET /api/pods/:id/reconcile`, and `npm run reconcile` ignore Foreman's own ledger and
rebuild each pod's finances by walking its real transaction history — then check one identity:

```
funded = paid + fees + refunded + elsewhere + held
```

If that does not close to the satoshi, the reconstruction is wrong and the tool says so instead of printing a
plausible gap. Where the chain and the ledger disagree the chain is right: the covenant cannot pay twice or pay
anyone but the pinned provider, so a disagreement is always a payment nobody wrote down. The report names the
transactions.

Fixing this found a real bug. A `close()` pays the last chunk *and* returns the remainder, but the app booked
only a `close` event and no receipt for that chunk, so the ledger under-reported settlement by one chunk on a
chain that was perfectly correct. Receipts are now built from `measurePayout()`, which reads the transaction
back off the chain — a receipt states what was paid, never what we intended to pay.

## Checking the evidence itself

```bash
npm run verify:evidence   # re-reads every txid in web/data.json from chipnet; exits 1 on any mismatch
```

An evidence file that has drifted from the chain is the difference between a demo and a claim, and a
judge cannot easily tell by looking. This walks each recorded step, reads the transaction back, and
reports per step whether the chain agrees. It also states its own limit: it proves the transactions
exist and the amounts match, **not** that the steps happened in the order the file narrates.

## API

See [`/docs/api.html`](web/docs/api.html) in the running app, or the table in `server.mjs`:

`POST /api/pods` · `POST /api/pods/:id/fund` · `POST /api/pods/:id/fund-wallet` · `POST /api/pods/:id/deliver` ·
`POST /api/pods/:id/intent` · `GET /api/preceipts` · `GET /api/reconcile` · `GET /api/pods/:id/reconcile` ·
`POST /api/pods/:id/steal` · `POST /api/pods/:id/early-refund` · `POST /api/pods/:id/close` ·
`POST /api/pods/:id/refund` · `GET /api/pods` · `GET /api/pods/:id` · `GET /api/verify/:txid` ·
`GET /api/evidence` · `POST /api/wallet/connect` · `GET /api/wallet/status` · `GET /api/wallet/utxos` ·
`POST /api/wallet/xpub` · `POST /api/wallet/disconnect`

## Bring your own wallet (WizardConnect)

The demo runs on server-held keys so a judge can click through with no wallet installed. The
production path is the connector: open `/#wallet`, press **Pair a wallet**, and scan the QR
(<code>wiz://</code>) with any WizardConnect wallet. From then on the funding transaction is built by
the server, **signed on your phone over the relay**, re-checked locally against the covenant, and only
then broadcast. The server never sees a private key on this path.

The check before broadcast is the interesting part: the returned transaction is verified as a real
BCH transaction (all signatures valid) and the pod output must be exactly the amount that was
requested. A wallet that signs something else gets a `400`, not a broadcast.

Proof, no phone required — the repo ships a headless test wallet so the whole handshake is testable:

```bash
node tools/test-wallet-bot.mjs 'wiz://?p=…&s=…'   # a wallet, in a terminal
node tools/wallet-e2e.mjs                        # self-contained: pair → build → sign → verify → broadcast
```

`tools/wallet-e2e.mjs` prints the URI, launches the test wallet against it, funds a fresh pod with the
wallet's own coins, and broadcasts. Last run:

| step | result |
|---|---|
| pair (relay `relay.riften.net` / `relay.cauldron.quest`) | wallet announced itself, `dapp_ready` sent |
| build | 1 input, fee 236 sat, pod output 150000 sat, change 99528 sat back to the wallet |
| sign | 229 bytes returned over the relay, `broadcast: false` |
| verify | signatures valid, pod output exactly 150000 sat |
| broadcast | [`c47e0d6ec5f53ba85697a8140bded7c3cebd88fb840e561fbb1344b8f1ca1f0c`](https://chipnet.imaginary.cash/tx/c47e0d6ec5f53ba85697a8140bded7c3cebd88fb840e561fbb1344b8f1ca1f0c) |

Through the HTTP API, the same path with a paired wallet is one call:

```bash
curl -X POST localhost:4173/api/pods/$ID/fund-wallet -H 'content-type: application/json' -d '{"satoshis":200000}'
```

Live through the server on the same day, wallet-signed: `73a345b9…` funded pod `job_88e74a4a` (250000 sat,
phone-signed, VM re-checked), `c4639273…` and `c20077fc…` paid two 20000-sat chunks out of it, and a 4-chunk
pull was refused with rule `deliver.window`. An earlier run used the same path with `eaada812…` / `5befe01f…`.

Server-relevant source: `wallet.mjs` (relay session, address derivation, sign/verify/broadcast) and
`lib.mjs` (`buildWalletFund`, `verifySignedSpend`). An xpub can be pasted instead of pairing a phone —
that gives the same addresses read-only, which is enough to fund a pod but not to sign.

## Tests

```bash
npm test          # covenant 16 + wallet 16 + guard 17 + reconcile 8 + walk 4 + ui wiring 4 = 65 assertions, offline
npm run wallet:e2e  # pair a real relay session, sign with the test wallet, broadcast on chipnet
```

`tests/ChunkPod.test.mjs` executes the covenant against the BCH VM, including ten cheat paths.
`tests/WalletGuard.test.mjs` tests the promise the wallet path makes — that the server refuses to
broadcast anything that does not pay the pod the exact amount — against a dishonest wallet that signs
a smaller amount, a different pod, someone else's key, or tampered bytes.

`tests/Guard.test.mjs` (17) asserts the guard can never approve what the covenant would refuse, and that
unknown state degrades to `skipped` rather than a silent pass. `tests/Reconcile.test.mjs` (8) pins the
reconciliation arithmetic to hand-built histories, including a close that pays a final chunk and a top-up
the books never saw. `tests/ReconcileWalk.test.mjs` (4) covers the transaction walk itself against a fake
indexer — no relay — including a pruned transaction (skipped, never guessed) and money paid to a third
party (separated out and named).

## Also in this repo

| | |
|---|---|
| `solidcash/` | the same covenant ported to SolidCash (`ChunkPod.scash`), compiled with `solidc 0.51.1`, **12/12 tests** on the SolidCash VM |
| `xo/` | the covenant as an **XO wallet template** (`foreman.pod.template.json`), validated by the XO engine schema — `xo/README.md` has the invitation walkthrough |
| `SUBMISSION.md` | the submission itself: problem, evidence table, rubric answers, honest limits, bounty answers |
| `DECLARATION.md` | what was pre-existing vs built during the hackathon, what was adopted from other entries (credited) |
| `docs/competitor-survey.md` | every BCH BLAZE 2026 entry we could read, what they got right, and what we changed because of it |
| `scripts/phases.mjs` | renders the state machine from the compiled artifact (fails if the contract gains an undocumented path) |
| `scripts/simulate.mjs` | the economics of an agent fleet, three ways, including the case where the pod is more expensive |
| `BEFORE-AFTER.md` | the user's day before and after Foreman, with measured numbers |
| `web/docs/` | slides, economics and API pages served by the app |

## The gap this fills

x402 (HTTP 402 for AI agents — a Linux Foundation project with Visa, Mastercard, Stripe, Google and AWS in its
membership) has three documented holes: **no refunds or disputes**, **no per-provider spend ceiling**, and
**no BCH settlement**. Coinbase's own head of AI product has said escrow and refunds are the piece still missing.

Foreman is that piece, as a covenant. On BCH a sub-cent refund is economically sane, so the refund path can be the
dispute mechanism rather than a support ticket.

## Honest limits

- Not audited. Demo keys live in `.secrets/` (gitignored). Chipnet coins only.
- The covenant enforces money, not quality of work (see Receipts).
- `refund()` needs a block-height locktime. Every chipnet relay we tried currently rejects **all** non-zero
  locktimes, including a plain P2PKH self-spend — see [`docs/evidence-notes.md`](docs/evidence-notes.md). The path
  is verified in the VM (tests #12, #13) and is the same shape mainnet accepts today.
- Single provider per pod. Many providers = many pods (or one pod that pays a split, which is a different covenant).

## Layout

```
contracts/ChunkPod.cash      the whole contract (930 bytes compiled)
wallet.mjs                   WizardConnect dapp session: pair, derive, sign, verify, broadcast
artifacts/ChunkPod.json      compiled artifact (ABI + bytecode)
tests/ChunkPod.test.mjs      16 tests against the real BCH VM
lib.mjs                      funding, delivery, refund, close, verification, rule mapping,
                             reconciliation (reconcilePod, compareToLedger, measurePayout)
guard.mjs                    pre-execution intent guard: 9 rules, stable reason codes, preceipts
server.mjs                   the app + HTTP API
web/                         index.html (markup) + app.css + app.js, docs/, and the recorded evidence
scripts/                     demo, batching, chipnet runs, faucet funding, reconcile
docs/evidence-notes.md       what was broadcast, what the rail refused, and why
```
