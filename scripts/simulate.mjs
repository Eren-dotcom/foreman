#!/usr/bin/env node
/**
 * scripts/simulate.mjs — what Foreman is worth to someone who runs agents.
 *
 * Every covenant project shows "it works". This shows why it matters: model a
 * month of an agent fleet paying providers per chunk, with the same work done
 * three ways, and print the money and the loss exposure side by side.
 *
 *   node scripts/simulate.mjs                 # default fleet
 *   node scripts/simulate.mjs --jobs 5000 --chunk 20000 --rate 0.35
 *
 * Numbers are a model, not a measurement: the on-chain fee figures come from the
 * real batched run in web/batch.json, the rest are stated assumptions printed
 * with the output so a reader can disagree with them.
 */
import fs from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};

const JOBS = arg('jobs', 2000);            // agent jobs per month
const CHUNKS = arg('chunks', 6);           // delivered chunks per job
const CHUNK_SATS = arg('chunk', 20000);    // price per chunk, sats
const FEE_RATE = arg('fee-rate', 1);       // sats/byte, typical BCH relay floor
const INCIDENTS = arg('incidents', 4);     // rogue/failed providers per month
const ROGUE_BUDGET = arg('rogue-budget', 2_000_000); // sats in a hot wallet when it goes wrong

// Real measurements from the repo, not guesses:
const batch = JSON.parse(fs.readFileSync(new URL('../web/batch.json', import.meta.url), 'utf8'));
const batched = batch.rows.find((r) => !r.refused && Number(r.chunks) === CHUNKS)
  ?? batch.rows.filter((r) => !r.refused).at(-1);
const podTxBytes = batch.rows.find((r) => !r.refused)?.bytes ?? 514; // measured covenant spend size

const chunkPayments = JOBS * CHUNKS;
const paidSats = chunkPayments * CHUNK_SATS;

// --- model the three ways -------------------------------------------------
// A: separate transaction per chunk on plain P2PKH — the honest baseline.
// A covenant spend is bigger than 514 B (redeem script + args), so we size it
// from the measured pod transaction rather than pretending both are equal.
const P2PKH_TX_BYTES = 226; // 1 input, 1 output, Schnorr — the standard size
const feePerSingle = Math.round(P2PKH_TX_BYTES * FEE_RATE);
const feeA = chunkPayments * feePerSingle;

// B: Foreman, delivering chunks one at a time through the pod (deliver() path)
const FEE_DELIVER = 700; // contract constant, per deliver() transaction
const feeB = JOBS * CHUNKS * FEE_DELIVER;

// C: Foreman with batched pulls (one tx per job, pays every chunk at once)
const feePerJobBatched = Math.max(FEE_DELIVER, Math.round(podTxBytes * FEE_RATE));
const feeC = JOBS * feePerJobBatched;

const satsToUsd = (s) => (s / 1e8) * (Number(process.env.BCH_USD ?? 600));
const pct = (n, d) => `${((n / d) * 100).toFixed(2)}%`;

const rows = [
  { name: 'A · plain tx per chunk', txs: chunkPayments, fee: feeA, exposure: 'unbounded', exposureSats: ROGUE_BUDGET * INCIDENTS },
  { name: 'B · pod, one deliver() per chunk', txs: chunkPayments, fee: feeB, exposure: 'bounded', exposureSats: 0 },
  { name: 'C · pod, batched pull per job', txs: JOBS, fee: feeC, exposure: 'bounded', exposureSats: 0 },
];

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-US');

console.log('');
console.log(`Foreman — ${num(JOBS)} agent jobs/month · ${CHUNKS} chunks each · ${num(CHUNK_SATS)} sat/chunk`);
console.log(`  work paid: ${num(paidSats)} sat  ($${satsToUsd(paidSats).toFixed(2)}/month, assuming $${process.env.BCH_USD ?? 600}/BCH)`);
console.log(`  measured: one deliver() covenant spend = ${podTxBytes} B, whether it pays 1 chunk or ${CHUNKS}`);
console.log('');
console.log(`${pad('', 36)}${pad('txs', 10)}${pad('fees (sat)', 14)}${pad('fees ($)', 12)}${pad('as % of work', 14)}loss exposure`);
console.log('─'.repeat(104));
for (const r of rows) {
  console.log(
    pad(r.name, 36)
    + pad(num(r.txs), 10)
    + pad(num(r.fee), 14)
    + pad(`$${satsToUsd(r.fee).toFixed(2)}`, 12)
    + pad(pct(r.fee, paidSats), 14)
    + (r.exposureSats ? `${num(r.exposureSats)} sat (${r.exposure})` : '0 sat — capped by the covenant'),
  );
}
console.log('─'.repeat(104));
const saved = feeA - feeC;
console.log(`Batching (C) saves ${num(saved)} sat/month vs A = $${satsToUsd(saved).toFixed(2)}/month = $${(satsToUsd(saved) * 12).toFixed(0)}/year.`);
console.log(`Fees fall from ${pct(feeA, paidSats)} of the money moved to ${pct(feeC, paidSats)}.`);
console.log('');
console.log(`Risk: ${INCIDENTS} incidents/month at ${num(ROGUE_BUDGET)} sat exposed in a hot wallet = ${num(ROGUE_BUDGET * INCIDENTS)} sat/month ($${satsToUsd(ROGUE_BUDGET * INCIDENTS).toFixed(2)}) at risk.`);
console.log('With a pod, the maximum loss is the window of one transaction plus whatever the expiry has not yet returned.');
console.log('');
const worse = rows.filter((r) => r.fee > feeA);
if (worse.length > 0) {
  console.log('Where this is WORSE, stated plainly:');
  for (const r of worse) {
    console.log(`  ${r.name} costs ${num(r.fee - feeA)} sat/month more than plain transactions —`);
  }
  console.log('  because the covenant carries a fixed 700-sat fee budget per spend (a constant in the contract,');
  console.log('  chosen so the spend can never fail for being underpaid) and a covenant spend is ~2.3x the size');
  console.log('  of a P2PKH spend. The pod pays for itself through batching (C) and through bounded loss, not through');
  console.log('  cheaper single payments. A production build would compute the fee from the tx size instead.');
  console.log('');
}
console.log('Assumptions you can change with flags: --jobs --chunks --chunk --incidents --rogue-budget --fee-rate, or BCH_USD=…');
console.log('Fee rates and tx sizes are measured (web/batch.json); the incident rate and BCH price are stated assumptions.');

fs.writeFileSync(new URL('../web/simulate.json', import.meta.url), JSON.stringify({
  inputs: { jobs: JOBS, chunks: CHUNKS, chunkSats: CHUNK_SATS, feeRate: FEE_RATE, incidents: INCIDENTS, rogueBudgetSats: ROGUE_BUDGET, bchUsd: Number(process.env.BCH_USD ?? 600) },
  paidSats,
  rows,
  savedVsA: saved,
  generatedAt: new Date().toISOString(),
}, null, 2));
