# Before / After

Two ways to pay an AI or compute provider per unit of work, with Foreman in the middle.

## Before Foreman

**The agent operator.** Funds a hot wallet so the agent can pay as it goes. There is no per-provider
ceiling, so one prompt-injected tool call, one buggy loop, or one hostile provider can drain it. There
is no refund path, so "the provider delivered three of ten chunks and disappeared" is a support ticket
with no on-chain remedy. Logs prove what the agent *says* it paid; nothing proves what it *could* pay.

**The customer.** Prepaid credits at a platform, with a minimum top-up, a KYC step, and a 3–5% take
rate. A $2 top-up is not economic, so anything below a few dollars happens off-platform or not at all.

**The provider.** Invoices, waits 30–60 days, and eats the default risk.

## After Foreman

**The agent operator** opens a pod with three numbers — `chunk`, `window`, `validUntil` — and funds
it once. From that point the blast radius is fixed in the script:

- a pull larger than `window` is impossible, not merely discouraged (refused: `deliver.window`);
- a partial chunk cannot be paid, so the provider cannot round up;
- every chunk payment leaves the remainder inside the same pod, so unused budget never sits in a
  wallet an agent can reach;
- at expiry the client takes back what is left, without asking anyone.

**The customer** pays for one job, not one platform: a $0.05 refund costs a fraction of a cent, so the
refund path *is* the dispute mechanism instead of a ticket queue.

**The provider** gets paid per delivered chunk, immediately, with a receipt anyone can verify against
the chain — no invoice, no 45-day wait, no default risk on the part of the budget already delivered.

## Concrete, measured

| | Before | After |
|---|---|---|
| Max loss if the agent goes rogue | the whole funded wallet | `validUntil` + the pod's `window` per tx |
| Unused budget after the job | stranded in a hot wallet | returned by the covenant at expiry |
| Fee for 16 chunk payments | 16 transactions, 16 fees | one 514-byte tx, 700 sat total — **93.8% cheaper** |
| Cost of one dispute | a support ticket | one refund transaction, ~0.006¢ |
| What the operator holds during the job | a private key | a signature on one bounded coin |

## What stays true

Foreman enforces **money, not truth**. It cannot tell whether the delivered chunk was good work; the
payload hash in the receipt is the seam where a human or a second contract would have to arbitrate.
Pretending otherwise would be the dishonest version of this document.
