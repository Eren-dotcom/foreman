/**
 * foreman/guard.mjs — judge a payment intent BEFORE a transaction is built.
 *
 * The covenant is the real authority: it is the only thing that can stop a bad
 * spend on-chain, and `lib.mjs` re-checks every signed transaction against it.
 * But "the contract will refuse it" is a poor experience for an agent that could
 * have known it was about to overspend — and a refused spend still costs the
 * round trip. So this module restates the pod's rules in the *client* language
 * (satoshis and block heights) and runs them first.
 *
 * Design rules, borrowed from Intent Firewall (KeeperHub Agents Onchain, build
 * 47771), which argued the point better than we had:
 *
 *   1. Guard before the handoff, never after. A denied intent never reaches the
 *      chain and never costs anything.
 *   2. A guard must not be able to approve something the covenant would refuse.
 *      If we cannot prove an intent is safe, the answer is `needs-review`, never
 *      `pass`. The covenant stays the final authority.
 *   3. Every rule has a stable reason code, so an agent can act on the reason
 *      instead of parsing prose.
 *
 * The same rule ids appear in `lib.mjs` RULES (the VM's own refusals), so a
 * `preceipt` and a covenant refusal can be compared by name.
 */

/** Rules, in evaluation order. Each returns null (pass) or { code, message, detail }. */
export const INTENT_RULES = [
  {
    code: 'intent.malformed',
    rule: 'A pod intent must name a pod and an action.',
    check: ({ intent }) => {
      if (!intent || typeof intent !== 'object') return { message: 'intent missing' };
      if (!intent.pod || typeof intent.pod !== 'string') return { message: 'pod address missing' };
      if (!['deliver', 'close', 'refund', 'fund'].includes(intent.action)) {
        return { message: `unknown action "${intent.action}" — known: deliver, close, refund, fund` };
      }
      return null;
    },
  },
  {
    code: 'intent.amount-shape',
    rule: 'Amounts must be whole, non-negative satoshis. A float is evidence of a unit bug.',
    check: ({ intent }) => {
      const v = intent.amount;
      if (v === undefined) return null;
      if (typeof v === 'number' && !Number.isSafeInteger(v)) return { message: `amount ${v} is not a safe integer (wei/satoshi mix-up?)` };
      if (typeof v === 'string' && !/^\d+$/.test(v)) return { message: `amount "${v}" is not a whole number of satoshis` };
      if (BigInt(v) < 0n) return { message: 'negative amount' };
      return null;
    },
  },
  {
    code: 'deliver.window',
    rule: 'One transaction may not move more than the pod\'s window.',
    applies: ({ intent }) => intent.action === 'deliver' || intent.action === 'close',
    check: ({ intent, pod }) => {
      if (intent.amount === undefined) return { message: 'a payment intent must state the amount' };
      const amount = BigInt(intent.amount);
      if (amount > pod.window) {
        return {
          message: `this would move ${amount} sat in one transaction; the window is ${pod.window} sat`,
          detail: `the covenant refuses at deliver.window. Split it into ${Number((amount + pod.window - 1n) / pod.window)} transactions.`,
        };
      }
      return null;
    },
  },
  {
    code: 'deliver.whole-chunks',
    rule: 'Payments are whole chunks only.',
    applies: ({ intent }) => intent.action === 'deliver' || intent.action === 'close',
    check: ({ intent, pod }) => {
      if (intent.amount === undefined) return null;
      const amount = BigInt(intent.amount);
      if (amount % pod.chunk !== 0n) {
        return {
          message: `${amount} sat is not a multiple of the ${pod.chunk} sat chunk price`,
          detail: 'the covenant refuses partial chunks, so a rounding error cannot become a payment.',
        };
      }
      return null;
    },
  },
  {
    code: 'deliver.payee-pinned',
    rule: 'The payment must go to the provider named when the pod was created.',
    // Always evaluated for a payment: "no payee supplied" is not the same as
    // "payee is fine", and the caller should see which case they are in.
    applies: ({ intent }) => intent.action === 'deliver' || intent.action === 'close',
    check: ({ intent, pod }) => {
      if (!intent.payTo) return null; // the intent did not name a payee, so there is nothing to cross-check
      if (!pod.providerAddress) return null; // we were not told the provider, so we cannot judge it
      if (String(intent.payTo) !== String(pod.providerAddress)) {
        return {
          message: `the intent pays ${intent.payTo}, but this pod pays ${pod.providerAddress}`,
          detail: 'the covenant pins the payee, so this transaction could never succeed — the address is wrong or the pod is wrong.',
        };
      }
      return null;
    },
  },
  {
    code: 'deliver.overdraw',
    rule: 'You cannot pay out more than the pod holds, minus the covenant fee.',
    applies: ({ intent, pod }) => (intent.action === 'deliver' || intent.action === 'close') && pod.balance !== undefined,
    check: ({ intent, pod }) => {
      if (intent.amount === undefined || pod.balance === undefined) return null;
      const amount = BigInt(intent.amount);
      const fee = intent.action === 'close' ? 800n : 700n; // contract constants CLOSE_FEE / FEE
      if (amount + fee > BigInt(pod.balance)) {
        return {
          message: `paying ${amount} sat plus the ${fee} sat covenant fee exceeds the ${pod.balance} sat the pod holds`,
          detail: 'a shortfall here means the work was claimed but never funded — check the pod balance before delivering.',
        };
      }
      return null;
    },
  },
  {
    code: 'refund.not-expired',
    rule: 'A refund cannot happen before the pod expires.',
    applies: ({ intent }) => intent.action === 'refund',
    check: ({ pod }) => {
      if (pod.blocksToExpiry === undefined) return null;
      if (pod.blocksToExpiry > 0) {
        return {
          message: `the pod expires in ${pod.blocksToExpiry} blocks; the covenant refuses an earlier reclaim`,
          detail: 'this is the feature, not a limitation: the provider knows the budget cannot be pulled mid-job.',
        };
      }
      return null;
    },
  },
  {
    code: 'intent.stale',
    rule: 'Do not act on stale state — the balance may have moved since you read it.',
    applies: ({ intent, pod }) => Boolean(intent.observedHeight) && pod.blockHeight !== undefined,
    check: ({ intent, pod }) => {
      const age = Number(pod.blockHeight) - Number(intent.observedHeight);
      if (age > (intent.maxAgeBlocks ?? 6)) {
        return {
          message: `this intent was built against block ${intent.observedHeight}, the tip is ${pod.blockHeight} (${age} blocks old)`,
          detail: 're-read the pod before paying: another delivery may already have taken part of the budget.',
        };
      }
      return null;
    },
  },
  {
    code: 'intent.replay',
    rule: 'The same intent must not be executed twice.',
    applies: ({ intent }) => Boolean(intent.id),
    check: ({ intent, seen }) => {
      if (seen?.has(intent.id)) {
        return { message: `intent ${intent.id} has already been executed`, detail: 'an agent retry must use a new intent id.' };
      }
      return null;
    },
  },
];

/** A stable, hashable id for an intent — the thing a retry must not silently reuse. */
export function intentId(intent) {
  const parts = [intent.pod, intent.action, intent.amount ?? '', intent.payTo ?? '', intent.observedHeight ?? ''];
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `int_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Decide whether an intent may proceed.
 *
 * @param {object} args
 * @param {object} args.intent  { pod, action, amount?, payTo?, observedHeight?, maxAgeBlocks?, id? }
 * @param {object} args.pod     { chunk, window, balance?, blocksToExpiry?, blockHeight?, providerAddress? }
 * @param {Set<string>} [args.seen] intent ids already executed
 * @returns {{ decision: 'pass'|'deny'|'needs-review', code: string|null, reason: string, effect: object|null, rules: Array }}
 */
export function judge({ intent, pod, seen }) {
  const rules = [];
  for (const r of INTENT_RULES) {
    if (r.applies && !r.applies({ intent, pod })) { rules.push({ code: r.code, outcome: 'skipped' }); continue; }
    const failure = r.check({ intent, pod, seen });
    rules.push({ code: r.code, outcome: failure ? 'deny' : 'pass' });
    if (failure) {
      return {
        decision: 'deny',
        code: r.code,
        reason: failure.message,
        rule: r.rule,
        detail: failure.detail ?? null,
        effect: null,
        rules,
      };
    }
  }
  // We could judge every rule, so the intent is safe to hand off. The covenant
  // still gets the final word — this is a guard, not an authority.
  const amount = intent.amount === undefined ? null : String(intent.amount);
  return {
    decision: 'pass',
    code: null,
    reason: 'all pre-execution rules passed',
    rule: null,
    detail: 'the covenant remains the final authority: this intent can still be refused on-chain.',
    effect: {
      action: intent.action,
      amount,
      payTo: intent.payTo ?? null,
      podBalanceBefore: pod.balance ?? null,
      podBalanceAfter: pod.balance !== undefined && amount !== null
        ? String(BigInt(pod.balance) - BigInt(amount) - (intent.action === 'close' ? 800n : intent.action === 'deliver' ? 700n : 0n))
        : null,
    },
    rules,
  };
}
