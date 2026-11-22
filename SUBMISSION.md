# Foreman — BCH BLAZE 2026 submission

**Track:** Mainnet · **Bounties:** Build with XO, Best SolidCash Application · **Community Choice:** EMBER2026

**One line:** *An agent locks a budget on Bitcoin Cash; the provider can only pull whole chunks as it delivers, and
whatever isn't delivered is refunded by the covenant when the authority expires.*

---

## 1. The problem

Agents and marketplaces already pay providers per unit of work — per inference, per GPU-minute, per scrape. Today
the money sits in one of two places:

- **A funded hot wallet.** No spend ceiling, no refunds. One buggy or hostile provider, or one compromised agent,
  and the budget is gone.
- **A custodian.** KYC, an account per side, a chargeback window that doesn't exist on-chain, and per-transaction
  pricing that cannot settle a tenth of a cent.

x402 — HTTP 402 for AI agents, now a Linux Foundation project with Visa, Mastercard, Stripe, Google and AWS in its
membership — has three documented holes: **no refund or dispute mechanism**, **no per-provider spend ceiling**, and
**no BCH settlement**. Coinbase's own head of AI product has said escrow and refunds are the piece still missing.

## 2. What Foreman is

One CashScript covenant per job. Three spend paths. 930 bytes compiled.

```
agent ──funds 100,000 sat──► [ pod ]
                                │
   provider delivers ───────────┤ deliver()  → pays a whole chunk, remainder returns to the pod
   provider over-reaches ───────┤ deliver()  → ✗ refused by the VM (window)
   payment redirected ──────────┤ deliver()  → ✗ refused (payee pinned)
   client panics mid-job ───────┤ refund()   → ✗ refused until expiry
   job stops, window closes ────┘ refund()   → everything left returns to the agent
```

**The refund path is the dispute system.** On BCH that costs about $0.0002 to exercise, so neither side has a reason
not to. That is the argument for BCH specifically, not for a chain with fees.

## 3. Evidence — what actually ran

Every txid below is real and opens on `https://chipnet.imaginary.cash/tx/<txid>`. Source of truth:
`web/data.json` (the recorded run) and `web/batch.json` (the batching measurement).

| # | Path | Where it is verified |
|---|---|---|
| 1 | fund a pod (client pre-authorises a budget) | real chipnet tx — `web/data.json` step 04 |
| 2 | `deliver()` one chunk, remainder returns to the pod | real chipnet tx — steps 05–07 |
| 3 | `deliver()` over the window (cheat) | **refused**: `ChunkPod.cash:44` → rule `deliver.window`; pinned by test #4 |
| 4 | `refund()` before expiry (cheat) | **refused**: `ChunkPod.cash:64` → rule `refund.not-expired`; pinned by test #12 |
| 5 | `close()` — both keys, provider paid, client made whole | real chipnet tx — step 10 |
| 6 | `refund()` at expiry | VM test #13 accepted; chipnet relay blocks all non-zero locktimes (see `docs/evidence-notes.md`) |
| 7 | 16 chunk payments in one 514-byte transaction | real chipnet txs — `web/batch.json` |
| 8 | every rule, incl. 10 cheat paths | `npm test` → **16/16** against the real BCH VM |
| 9 | the same covenant in SolidCash | `solidcash/tests` → **12/12** on the SolidCash VM |
| 10 | the covenant as an XO template | `xo/verify.mjs` → parsed by the XO engine, `templateIdentifier` `6bc7202…` |
| 11 | client's own wallet signs the funding tx (WizardConnect, `wiz://`) | real chipnet tx `c47e0d6e…` from `tools/wallet-e2e.mjs`; `73a345b9…` through `POST /api/pods/:id/fund-wallet` |
| 12 | the wallet guardrail itself (server refuses to broadcast a wrong payment) | `tests/WalletGuard.test.mjs` → **16/16** offline, incl. a wallet that signs a smaller amount, a different pod, or someone else's key |
| 13 | **pre-execution guard** — an intent is refused before any transaction exists | `POST /api/pods/:id/intent` → `deny` / `deliver.window` with a hashed preceipt; `tests/Guard.test.mjs` → **17/17** offline |
| 14 | **retry safety** — the same intent id returns the same preceipt, not a second decision | live: second call to `/intent` returns `"duplicate": true` with the original hash |
| 15 | **reconciliation** — settlement rebuilt from the chain and checked against the books | `npm run reconcile` → **3/3 pods balance to the satoshi**; found one real bookkeeping bug (below) |
| 16 | mainnet is a config switch, not a rewrite | same covenant, same app: a mainnet pod compiles and reads the mainnet tip (`job_c01b1f2c`, `bitcoincash:pw9r9g5e…`). **No mainnet transaction is claimed** — the demo holds chipnet coins only |

Grading discipline: real-wallet, scripted-broadcast, VM-only and rail-blocked are kept distinct. Nothing is rounded up.

### What reconciliation caught in our own app

`npm run reconcile` rebuilt all three chipnet pods from their real transaction history and checked
`funded = paid + fees + refunded + elsewhere + held`:

| pod | funded | paid → provider | fees | refunded | held now | identity |
|---|---|---|---|---|---|---|
| `job_88e74a4a` | 350,000 | 60,000 | 2,100 | 0 | 287,900 | ✓ balances |
| `job_e87bbcd1` | 100,000 | 80,000 | 2,900 | 17,100 | 0 | ✓ balances |

3/3 pods balance to the satoshi. **1/3 sets of books agreed**, and the disagreement was ours, not the
covenant's: `close()` pays the last chunk *and* returns the remainder, but the app recorded only a `close`
event — no receipt for that final chunk — so the ledger under-reported settlement by 20,000 sat on a chain
that was correct the whole time. Receipts are now built by `measurePayout()`, which reads the transaction
back off the chain. A receipt states what was paid, never what we intended to pay.

This is the honest version of a "settlement proof" feature: the tool is only worth something if it is
allowed to fail against its own authors. The covenant never paid the wrong amount; the paperwork did.

## 4. Why it wins on the rubric

| Category | Argument |
|---|---|
| **Innovation** | A new primitive, not another app category: bounded, expiring, refundable machine pay. Unclaimed in this field — every other build moves money between humans. It answers a published gap in the biggest agent-payments standard. |
| **Design & usability** | One page, three files, works on a phone. Every action is a real transaction with a clickable txid; every refusal shows the exact covenant rule and line number, and the guard can be *asked* for a refusal before anything is built. A judge can run the whole job in one click, or read a recorded run without a wallet. |
| **Technical strength** | 930 bytes, 3 spend paths, 29 named covenant rules, 16 VM tests including 10 serialised cheat paths, a SolidCash port with 12 more, 49 offline assertions across five suites, and an evidence verifier that re-reads every recorded txid from chain. Exact-arithmetic remainders, single-input enforcement, absolute timelock. |
| **Business** | 1% of settled volume on the agent side + $99/mo hosted spend-policy and audit dashboard. Customer: agent frameworks and marketplaces that already pay providers. Competitors: a funded x402 wallet (drainable, no refunds) or a custodian (KYC, can't settle sub-cent). |

### Where this sits next to the other entries

Enumerated from the live build list, not from memory. The AI-payments lane (BCH Mind AI and friends)
takes the money **before** the work and keeps it in a wallet — no ceiling, no refund. The escrow lane
(GigPact, MileVault, Allpaid) locks money correctly but is built for human milestones, not for a
machine that gets paid per delivered chunk. Foreman is the missing third shape: a **bounded, refundable
per-delivery budget**, with the wallet path and the guardrail that makes self-custody safe.

A second survey across three finished DoraHacks fields — *Agents Onchain* (190 builds), *Event Contracts*
(230 builds) and *PortalDot Hacker House 2026* (112 builds) — produced the two features above. What was
taken was the **thesis**, never the code: from *Intent Firewall* the idea that a policy should refuse an
intent before any service is contacted (we adopted the reason-code discipline and the "a denial costs
nothing" stance, and rebuilt it against a covenant instead of an ERC-20 allowance); from *An agent with its
own balance sheet* the rule that a system must record the cycles it did **not** act on, and must never print
a number it did not measure (this is why `effect: null` appears instead of a fake balance preview when state
is unknown, and why `measurePayout()` exists); from *Payout Replay* and *DreamDEX-Reclaim* the habit of
proving settlement against finalized chain state rather than a local record. A shipped product's own
reconciliation is the natural extension of that idea to a covenant.

What we learned from the strongest BCH entries and adopted, credited in `DECLARATION.md`: GigPact's
evidence split by proof level and its pre-hackathon declaration, blaze's per-stage offline tests, and
Allpaid's one-click self-driving judge demo. What we did **not** do: fork or copy any submission's
code — the rubric rewards "original or significantly improved", and a fork of a competing entry fails
that. The full survey, including what we still cannot claim, is in `docs/competitor-survey.md`.

## 4b. The wallet path (WizardConnect)

A judge should not have to trust a server that holds keys. The app ships the other path: open `/#wallet`,
press **Pair a wallet**, scan the `wiz://` QR with any WizardConnect wallet, then press **Fund this pod
from my wallet**. The server builds the transaction, the phone signs it over the relay, the server
re-verifies the returned bytes (all signatures valid, pod output exactly the requested amount) and only
then broadcasts. If the wallet returns anything else, the request fails with a 400 and nothing is sent.

That path is exercised end to end in the repo with a headless test wallet (`tools/wallet-e2e.mjs`):
pair → build → sign over the relay → verify → broadcast, `c47e0d6e…` on chipnet. Through the API the same
call is `POST /api/pods/:id/fund-wallet`: `73a345b9…` funded pod `job_88e74a4a` with 250000 sat, the covenant
then paid two 20000-sat chunks (`c4639273…`, `c20077fc…`), and a 4-chunk pull was refused with rule
`deliver.window`.

## 5. Why BCH

Measured, not modelled: **16 chunk payments in one 514-byte transaction for a 700-sat fee — 93.8% cheaper than 16
separate transactions.** A refund costs 600 sat. Sub-cent settlement is what makes per-chunk payment viable, and a
sub-cent refund is what makes the refund path usable as the dispute mechanism.

## 6. Honest limits

- Not audited. Demo keys are ours (`.secrets/`, gitignored). Chipnet coins only.
- Fee budgets are covenant constants so remainders can be checked to the satoshi. A production version takes a fee
  policy, or uses a fee-aware covenant.
- The covenant enforces money, not quality: it doesn't know whether the work was any good. Receipts carry a payload
  hash; a production version commits that hash per chunk so a quality dispute is visible on chain.
- `refund()` needs a block-height locktime, and every chipnet relay we tried rejects all non-zero locktimes —
  reproduced with a plain P2PKH self-spend, so it is the rail, not the covenant (`docs/evidence-notes.md`).
- **Reconciliation covers chipnet pods only.** `npm run reconcile` walks pods on this demo's chipnet keys. The
  mainnet pod exists to prove the config switch, so no mainnet settlement is reconciled or claimed.
- **The evidence verifier proves existence and amounts, not narrative.** `npm run verify:evidence` confirms every
  txid in `web/data.json` is on chain and matches the recorded figures. It cannot prove the steps happened in the
  order the file tells them.
- **No physical-wallet pairing.** The signing path is proven with a headless test wallet over the real relay.
- The XO template is validated by the engine's schema and its scripts resolve through the compiler, but the live
  chipnet invitation was not executed here: `Engine.create()` does not return in this sandbox (it opens a SQLite
  store and an Electrum application and never resolves). The exact remaining calls are in `xo/README.md`.

## 7. Run it

```bash
npm install
npm test                 # 16 covenant tests, real BCH VM
node server.mjs          # the app + API on :4173
```

Then click **Run the whole job live**: fund → 3 chunks → refused theft → refused early reclaim → close, all on
chipnet, all with explorer links.

```bash
node scripts/demo.mjs          # reproduce the recorded run (writes web/data.json)
node scripts/batch-run.mjs     # reproduce the batching numbers (writes web/batch.json)
cd solidcash && node --version # needs Node 22+
node tests/ChunkPod.scash.test.mjs    # 12/12 on the SolidCash VM
cd ../xo && node verify.mjs           # the XO template through the engine schema
```

## 8. Bounty answers

**Build with XO** — `xo/foreman.pod.template.json`, built on the engine's own template shape and validated with
`parseTemplate` (`templateIdentifier 6bc7202420bc83f5c491b4f74026baeecf760679832dc95c0b97ad72ab296063`). Roles:
client and provider. Variables: chunk price, window, expiry height, two keys. Three transactions: fund, pull a chunk,
refund. Development feedback (the bounty explicitly requires this to be written by the submitter, so it is left
blank here on purpose): *[the builder writes ~500 words on real friction — `Engine.create()` never resolving in
this environment, `parseTemplate` rejecting the released `p2pkhTemplate` because the bundled template copy is a
newer schema than the parser, `generateCashAssemblyBytecode`'s `evaluation.matchAll is not a function` when
variables aren't bound, and the missing invitation walkthrough in the getting-started guide — with reproductions.]*

**Best SolidCash Application** — `solidcash/contracts/ChunkPod.scash`, compiled with `solidc 0.51.1`, 12 tests on the
SolidCash VM covering delivery, refund, over-window, partial chunk, wrong signer, redirected payment,
short-changed remainder, overdraw, early refund, provider self-refund and wrong refund destination.

## 9. Banner (required elements)

- Slides: `/docs/presentation.html` (in the running app; also in the repo)
- Economics: `/docs/economics.html`
- API: `/docs/api.html`
- Repository: this folder
- EMBER2026 CashTokens address: `bitcoincash:zqcj6f9nx5ce6q3e469nge8hmlsu3uv2gshqpqxjg9`
- WizardConnect: `@wizardconnect/core` + `@wizardconnect/dapp` installed, the relay handshake verified here
  (`wiz://` URI issued, relay connected), and the page ships a **Fund this pod from my wallet** button that builds the
  transaction, has the paired wallet sign it over the relay, re-verifies the returned bytes and only then broadcasts.
  The proven signing run is headless (`tools/wallet-e2e.mjs`, txid `c47e0d6e…`); pairing against a physical phone
  is the one step not yet evidenced. See §6.
