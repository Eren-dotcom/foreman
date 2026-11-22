# BCH BLAZE 2026 — competitor survey and what we changed because of it

**Read this before the deadline.** It is written to be useful in a hurry, and it is honest about what
could and could not be checked.

## First, the limitation

DoraHacks reports **91 builds**. I could not read 91.

- The list endpoint is behind a human-verification wall (`405`, no API).
- The list is paginated in a way that returns the same 15 rows for every sort/filter/page
  combination I tried (`sort=updated`, `?page=2`, `tracks=Mainnet+Track` all returned an identical set).
- So: **15 build titles are confirmed** from the listing, and **6 submissions were read in full**
  (GigPact 51404, blaze 49470, Allpaid 51410, ClaimForge 51358, MileVault 51401, BCH Mind AI 51378).
  Every claim below is sourced to one of those. Anything about the other 76 is inference from titles,
  and is labelled as such.

If you want better coverage before submitting, the cheapest way is the hackathon Telegram — people
post their entries there, and it is not rate-limited.

---

## 1. The field, clustered

| Cluster | Entries seen | What they get right | What they leave open |
|---|---|---|---|
| **AI pay-per-use** | BCH Mind AI, Foreman | rides the year's loudest narrative; obvious business | Money is taken **before** the work and sits in a wallet: no ceiling, no refund, no dispute |
| **Escrow / milestones** | MileVault, GigPact, Sankofa, Kameti.Cash | proper covenants, real lockups, good story | Built for *human* milestones; none of them settle per delivered unit of work |
| **Split / waterfall payments** | Allpaid, ClaimForge | covenant does the arithmetic; genuinely novel shapes | Payer-side only — no notion of work being delivered over time |
| **Identity / Nostr binding** | CashLink DID, XO Identity, TwinKey, Countersign, BCH×Nostr Link | cheap to build, easy to demo | **Five entries doing nearly the same thing** — the most saturated lane in the hackathon |
| **Media track** | Penny Fiction, Sunday 5 AM, Gig Score, 2027 logo | judged separately, cheap to enter | not our competition |
| **Skeletons / infra** | blaze (49470) | excellent engineering discipline | no product, no covenant |

**The gap Foreman occupies is real and nobody else is in it:** a *bounded, refundable, per-delivery*
budget for a machine payer. Not escrow-for-humans, not pay-first-then-hope.

---

## 2. The three submissions worth learning from

### Allpaid (51410) — the strongest entry in the batch

What it does better than us, concretely:

- **`?demo` mode.** One URL, "press nothing", a visible cursor drives a play-money jar through the
  covenant with two refused theft attempts, each labelled with the contract line. A judge with 90
  seconds gets the whole product. **We copied this pattern.**
- **The contract has no owner for the spend.** `distribute()` needs no signature at all — the output
  set is fixed by the contract, so anyone can send it. That is a genuinely clever trust property.
- **Business model with numbers**: ~$0.002 per split, $9/venue/month hosted keeper, versus $50+ for
  tip-pooling software. It also says nobody has agreed to pay yet. Honest and specific.
- **Two-level nesting** — a member can be another jar, so payments waterfall. Real composition.

Where it is weaker than us: WizardConnect mainnet pairing "still pending", first mainnet run pending,
no per-delivery semantics.

**⚠️ One thing for you to check personally:** Allpaid's EMBER2026 address is
`bitcoincash:zqcj6f9nx5ce6q3e469nge8hmlsu3uv2gshqpqxjg9` — **byte-identical to ours.** Nothing on
bchblaze.cash publishes a universal address, so either a template circulated the same address, or one
of the two was copied from the other. A shared address splits community votes between two entries. Worth
confirming in the Telegram before submission, and worth saying publicly if it turns out to be a template.

### GigPact (51404) — the best evidence discipline

- **Evidence split by proof level**: 8 paths with a real wallet, 6 scripted, 2 regtest-only, and it
  names the blocks. We already had a version of this; it made ours sharper.
- **A declaration file** asserting first commit date and no prior repo. **We copied this** (`DECLARATION.md`).
- WizardConnect tested against **named real wallets** (Paytaca, Selene). Our test is a headless bot —
  honest, but weaker. If you have a phone and 20 minutes, this is the single highest-value thing left.

### blaze (49470) — the best engineering discipline

- Six stages, each an independently testable module with injected dependencies, 80/80 tests.
- **Documented pitfalls with regression assertions** (sighash flags, DER encoding, null third arg).
  **We did the equivalent**: our wallet bugs are now pinned by tests rather than fixed by memory.
- Network switch is "config-only, grep-verified single location". We did the same for mainnet and can
  now point at `net(job)`.

---

## 3. What we changed because of this survey

| Change | Inspired by | Where |
|---|---|---|
| **Judge path button** — one click, 60s, drives fund → 3 chunks → 2 refusals → close itself | Allpaid's `?demo` | `web/index.html` (`btn-autorun`) |
| **State machine rendered from the compiled artifact** — Mermaid + SVG, fails to build if the contract gains an undocumented spend path | Allpaid's "line 32 caught it" labelling, done one better | `scripts/phases.mjs` → `web/phases.svg`, `web/phases.json`, `GET /api/phases` |
| **Economics model** — fleet cost across three architectures, with the case where the pod is *worse* printed explicitly | Allpaid's business section | `scripts/simulate.mjs` → `web/simulate.json` |
| **Per-chain honesty** — mainnet pods return a 400 on the demo-key path with a pointer to the wallet path, instead of failing obscurely | GigPact's evidence levels | `server.mjs` |
| **`GET /api/run.json`** — the whole recorded run in one GET, for verification without a browser | ClaimForge's "a third party can check without the app" | `server.mjs` |
| **`DECLARATION.md`** — pre-existing vs new, credited dependencies | GigPact | root |

### Second survey — three other DoraHacks fields (Nov 2026)

Build listings read in full: **Agents Onchain** (190 builds), **Event Contracts** (230 builds),
**PortalDot Hacker House 2026** (112 builds). Four builds were then read in detail rather than skimmed,
and only the ones whose thesis survived contact with Foreman are listed:

| Build | Field | What it argues | What Foreman took | What Foreman rejected |
|---|---|---|---|---|
| **Intent Firewall** (47771) | Agents Onchain | A policy layer should refuse an intent *before* the downstream service is ever contacted; deny with a stable reason code, simulate first, make idempotency operation-scoped | The stance ("a denial costs nothing"; a refusal is a result, not an error), stable rule ids that mirror the enforcement layer, pre-execution simulation | Its architecture: an EIP-191-signed treasury policy over ERC-20 allowances. Foreman needs no allowance check because the money is already inside a covenant |
| **An agent with its own balance sheet** (47764) | Agents Onchain | Price from *measured* cost, stop selling at a ceiling, and never display a number you did not measure (show a dash, not zero) | `effect: null` instead of a fabricated balance preview when state is unknown; `skipped` rule outcomes instead of charitable guesses; recording restraint, not just actions | Its commercial framing — Foreman has no pricing to derive, only a budget to bound |
| **Payout Replay** (50949) | PortalDot | Reconstruct payouts from finalized chain state; separate live exposure from redemption history | The reconciliation habit: rebuild from transactions, then make the books answer to the chain | Substrate-specific tooling |
| **DreamDEX-Reclaim** (48555) | Event Contracts | Read-only settlement recovery: unclaimed positions, oracle evidence, provable vs remembered | Same, and the discipline of naming the individual transaction rather than reporting an aggregate gap | Its oracle/event-market domain |

What the second survey changed, and where:

| Change | Inspired by | Where |
|---|---|---|
| **Pre-execution guard + preceipt** — 9 rules, stable codes, `pass / deny / needs-review`, hashed decision record, `200` on deny | Intent Firewall | `guard.mjs`, `tests/Guard.test.mjs` (17), `POST /api/pods/:id/intent` |
| **Idempotent retries** — the same intent id returns the same preceipt (`duplicate: true`), never a second decision | Intent Firewall's operation-scoped idempotency | `server.mjs` (`preceiptByIntent`) |
| **Reconciliation** — rebuild settlement from the chain, check `funded = paid + fees + refunded + elsewhere + held`, name every unbooked transaction | Payout Replay, DreamDEX-Reclaim | `lib.mjs` (`reconcilePod`, `compareToLedger`), `scripts/reconcile.mjs`, `GET /api/reconcile`, `tests/Reconcile.test.mjs` (8) |
| **Measured receipts** — a receipt records what the transaction actually paid, read back off chain | balance-sheet's "never invent an unmeasured number" | `lib.mjs` (`measurePayout`), used by `/deliver` and `/close` |

The reconciliation found a live bug in Foreman within its first hour: `close()` pays a final chunk *and*
returns the remainder, but the app booked only a `close` event, so the ledger under-reported settlement by
20,000 sat on a chain that was correct. That is the argument for the whole feature — the covenant was never
wrong, the paperwork was, and only a tool willing to fail against its own authors finds that.

Not changed, deliberately: we did not add a Nostr identity binding. Five entries already did, it is the
most crowded lane, and bolting it on would make Foreman a worse version of five other projects.

---

## 4. What we still cannot claim

- **No mainnet transaction.** Mainnet pods compile and read the mainnet tip (verified: `job_c01b1f2c`),
  but the demo holds chipnet coins only. Two entries do have mainnet txs; that is their advantage.
- **No pairing against a real phone wallet.** The connector is exercised end to end with a headless
  wallet over the real relay (`tools/wallet-e2e.mjs`), which proves the protocol, not the phone.
- **No user, no revenue, no commitment.** Allpaid at least reports a pipeline of venues.
- The refund path is still blocked on public chipnet relays by their locktime policy.

## 5. What I would do with the remaining time, in order

0. ~~Land the guard and reconciliation~~ — done; see the second-survey tables above. The two features are
   in `npm test` (49 offline assertions) and both have a UI surface a judge can click.

1. **Pair one real wallet** (Paytaca or Selene) and screenshot the paired state. Closes the biggest
   evidence gap and takes minutes. GigPact's evidence is stronger than ours purely because of this.
2. **Send a few thousand sats to your own address on mainnet and run one `deliver()`.** One txid moves
   us into the same evidence class as GigPact and beats two-thirds of the field on proof.
3. **Resolve the shared EMBER2026 address** before voting opens.
4. Write the XO bounty feedback yourself — still blank in `SUBMISSION.md`, and the bounty requires it.
