# DECLARATION — what was pre-existing, what was built during BCH BLAZE 2026

Judges ask one question that decides the originality score: *was this built for this hackathon, or
re-labelled afterwards?* This file answers it plainly, in the same spirit as the pre-hackathon
declarations other entries published.

## Timeline

- **Kick-off:** 2026-10-10 (pre-registration), submission window from 2026-11-13.
- **Foreman's first commit:** 2026-11-13, inside the submission window.
- **Deadline:** 2026-11-22 14:00 UTC.
- Everything in `contracts/`, `lib.mjs`, `server.mjs`, `wallet.mjs`, `web/`, `tests/`, `tools/`,
  `solidcash/` and `xo/` was written inside that window.

There is no earlier Foreman repository, no earlier demo, and no earlier deployed contract. The
author had no prior BCH CashScript project that this reuses.

## Pre-existing work that Foreman builds on (and credits)

| Dependency | Written by | How Foreman uses it | Licence |
|---|---|---|---|
| `cashscript` 0.14 | CashScript team | compiles `ChunkPod.cash`, builds transactions, local VM evaluation | MIT |
| `@bitauth/libauth` 3 | Jason Dreyzehner / Bitauth | HD keys, sighash, address and VM primitives | MIT |
| `@wizardconnect/core` + `/dapp` + `/wallet` | Whiterun LLC | the `wiz://` relay session, hdwalletv1 sign flow | LGPL-3.0 |
| `@xo-cash/*` | XO / Cash Innovation | template schema we validate against (`xo/`) | see upstream |
| `solidc` 0.51.1 | SolidCash | compiles the ported `ChunkPod.scash` | see upstream |

**No submission from this hackathon was forked, vendored, or copied.** The covenant, the receipt
scheme, the wallet guardrail, the demo app and the XO/SolidCash ports are original to this entry.
Where another entry's *engineering pattern* influenced ours — an evidence table split by proof level,
a declaration like this one, per-stage offline tests — that is credited in the next section, because
those are conventions of good submissions, not code to copy.

## Patterns adopted from other BCH BLAZE 2026 entries (credited, not copied)

- **Evidence separated by proof level** (real wallet / scripted broadcast / VM-only / rail-blocked),
  instead of one flat list of txids. Seen in GigPact; Foreman's version is `SUBMISSION.md` §3.
- **Pre-hackathon declaration** as a file in the repo. Seen in GigPact; this file.
- **Offline unit tests per stage, independent of the network.** Seen in blaze (49470); Foreman's
  version is `tests/WalletGuard.test.mjs` — the wallet guardrail is tested with fake coins and no relay.
- **Before/after framing of the user's day.** Seen in GigPact; Foreman's version is `BEFORE-AFTER.md`.

## Patterns adopted from three other DoraHacks fields (credited, not copied)

A second survey, across *Agents Onchain* (190 builds), *Event Contracts* (230 builds) and *PortalDot
Hacker House 2026* (112 builds). In every case what was taken is a **thesis**, implemented from scratch
against Foreman's own covenant and its own data:

- **Refuse before you spend** — *Intent Firewall* (47771, Agents Onchain). Its argument is that a policy
  should stop an intent before any downstream service is contacted, and its discipline is stable reason
  codes plus a simulation step. Foreman's `guard.mjs` adopts the stance and the naming discipline, and
  rejects the architecture: there is no allowance to check, because the money is already inside a
  covenant that cannot be talked out of its rules. The guard exists for cost and latency, not authority —
  and it says so in every passing verdict.
- **Record what you refused, and never print an unmeasured number** — *An agent with its own balance
  sheet* (47764). Two of its rules became two of Foreman's: a `skipped` rule outcome instead of a
  charitable guess, and `effect: null` rather than a fabricated balance preview when chain state is
  unavailable. The same principle, applied later, produced `measurePayout()`.
- **Prove settlement against chain state, not a local record** — *Payout Replay* (50949, PortalDot) and
  *DreamDEX-Reclaim* (48555, Event Contracts). Both separate what is provable from what is merely
  remembered. `reconcile.mjs` / `reconcilePod()` is that idea pointed at a covenant: rebuild the pod's
  finances from its transactions, then make the books answer to the chain. It found a real bookkeeping bug
  in Foreman's own `close()` path within its first hour.

No submission's code, contract, or assets were copied or forked. The rubric awards "original or
significantly improved"; every adoption above is re-derived in this repo's own vocabulary, and each is
cited here by build id.

Copying their codebase was never on the table: the rubric awards "original or significantly
improved", and a fork of a competing entry would fail both.

## AI assistance

Claude (Anthropic) was used as a coding assistant for implementation, tests and documentation.
Every transaction in this repo was broadcast by the author's own process, and every claim in
`SUBMISSION.md` §3 is backed by a txid or a test that the author ran.

## What is not done

- No independent audit.
- Chipnet demo keys live in `.secrets/` (gitignored); demo amounts are small.
- The refund path is proven in the VM and blocked on publicly-reachable chipnet relays by their
  locktime policy (documented in `docs/evidence-notes.md`). No live chipnet refund txid is claimed.
- The XO bounty feedback section in `SUBMISSION.md` is intentionally left blank for the human
  submitter to write — the bounty requires it to be personally written.
