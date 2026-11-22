# Evidence notes

## 1. The refund path and chipnet's locktime relay (honest disclosure)

The covenant's `refund()` requires `tx.time >= validUntil`, so a reclaim transaction carries
a block-height locktime. **Every spend path in the contract is verified in the real BCH VM**
by `npm test` — 16/16, including "refund before expiry rejected" and "refund on the expiry
block accepted".

On **chipnet**, the relay rejected every non-zero-locktime transaction during this build —
including a plain P2PKH self-spend with no covenant involved:

```
tip = 340015
locktime 0       → ACCEPTED   857d0b2a6179d2c163a8b4738011b097dc141638d7c665fcb634ef1cc85de6d3
locktime 340000  → rejected: Transaction is not yet final (nLockTime not satisfied)
locktime 340014  → rejected: Transaction is not yet final (nLockTime not satisfied)
```

Reproduced against both `chipnet.bch.ninja` and `chipnet.imaginary.cash`. So this is a
test-rail limitation in this environment, not a covenant bug: the transaction evaluates
clean in the VM, and it is the same shape every time-locked contract on BCH mainnet
(10-minute blocks) broadcasts today.

| path | status |
|---|---|
| `refund()` before expiry | rejected — VM test #12 |
| `refund()` at expiry | accepted — VM test #13 |
| `refund()` broadcast on chipnet | **blocked by the testnet relay for all non-zero locktimes** (above) |
| `refund()` broadcast on mainnet | expected to work; the first thing to verify with a tiny amount |

Everything else in the recorded run is a real chipnet transaction: pod funding, three
chunk payments, the mutual close, plus two refusals evaluated in the VM (over-window pull,
early reclaim).

## 2. What was broadcast, and where

See `web/data.json` (`steps`) and `web/batch.json` (`rows`). Every `txid` in those files is
real and opens on `https://chipnet.imaginary.cash/tx/<txid>`.

## 3. Test coverage

```
npm test   →   16/16 passing
✓ deliver: one chunk · two chunks · two sequential chunks from one pod
✓ refund:  before expiry refused · on the expiry block accepted
✓ close:   provider paid + client made whole
✗ cheat:   over-window pull · partial chunk · wrong signer · redirected payment ·
           third output · overdraw · short-changed remainder · merged pods ·
           provider refunding to itself · single-signature close
```

Each rejection test runs the transaction against the real BCH VM (libauth, through
CashScript's `MockNetworkProvider`) and asserts that it throws.

## 4. Known limits (stated in the README too)

- Not audited. Demo keys are ours and live in `.secrets/` (gitignored).
- Fee budgets (`FEE`, `REFUND_FEE`, `CLOSE_FEE`) are constants because that lets the
  covenant check the remainder to the satoshi. A production version would take a fee
  policy as a parameter or use a fee-aware covenant.
- The covenant enforces money, not truth: it doesn't know whether the delivered work was
  any good. A production version adds a delivered-artifact hash commitment per chunk, so
  a dispute over substance is visible on chain rather than off it.
