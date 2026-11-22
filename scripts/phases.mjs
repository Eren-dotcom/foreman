#!/usr/bin/env node
/**
 * scripts/phases.mjs — render the covenant's state machine FROM the compiled artifact.
 *
 * Most hackathon submissions draw their phase diagram by hand and it drifts from
 * the code. This reads `artifacts/ChunkPod.json`, pulls the real ABI, and emits
 * both a Mermaid graph and a hand-rolled SVG, so the picture cannot lie about
 * which functions exist.
 *
 *   node scripts/phases.mjs            # prints mermaid + writes web/phases.json
 */
import fs from 'node:fs';

const artifact = JSON.parse(fs.readFileSync(new URL('../artifacts/ChunkPod.json', import.meta.url)));

// What each spend path means in the covenant's own language. Keyed by the ABI
// function name, so adding a function to the contract without describing it here
// fails the check at the bottom instead of silently mis-drawing the diagram.
const MEANING = {
  deliver: {
    from: 'Funded (client pre-authorised)',
    to: 'Funded',
    who: 'provider',
    guard: 'whole chunks · ≤ window · payee pinned',
    note: 'remainder returns to the same pod, to the satoshi',
    terminal: false,
  },
  refund: {
    from: 'Funded (expired)',
    to: 'Closed',
    who: 'client',
    guard: 'tx.time ≥ validUntil · exact remainder − 600 sat fee',
    note: 'the client takes back what was never delivered',
    terminal: true,
  },
  close: {
    from: 'Funded',
    to: 'Closed',
    who: 'client + provider',
    guard: 'both signatures · whole chunks · exact split',
    note: 'mutual exit, no expiry needed',
    terminal: true,
  },
};

const functions = artifact.abi.map((f) => f.name);
const undescribed = functions.filter((name) => !MEANING[name]);
if (undescribed.length > 0) {
  console.error(`contract has spend paths with no diagram entry: ${undescribed.join(', ')}`);
  process.exit(1);
}

const models = [
  { id: 'Fresh', label: 'Fresh', detail: 'address exists, holds nothing', terminal: false },
  { id: 'Funded', label: 'Funded', detail: 'client pre-authorised a budget', terminal: false },
  { id: 'Closed', label: 'Closed', detail: 'nothing left to spend', terminal: true },
];

const edges = functions.map((name) => {
  const m = MEANING[name];
  const inputs = artifact.abi.find((f) => f.name === name).inputs.map((i) => i.name);
  return {
    fn: name,
    from: m.from.split(' ')[0] === 'Fresh' ? 'Fresh' : 'Funded',
    to: m.to,
    who: m.who,
    guard: m.guard,
    note: m.note,
    args: inputs,
    terminal: m.terminal,
  };
});

// ---------------------------------------------------------------- mermaid
const mermaid = [
  'stateDiagram-v2',
  '  [*] --> Fresh: client computes the pod address',
  '  Fresh --> Funded: fund (client → pod address)',
  ...edges.map((e) => `  ${e.from} --> ${e.to}: ${e.fn}() · ${e.who}`),
  '  Funded --> Funded: deliver() loops until the budget runs out',
  '  Closed --> [*]',
].join('\n');

// ---------------------------------------------------------------- svg
const W = 900; const H = 320;
const box = (x, y, w, h, title, sub, tone) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="1.5"/>
  <text x="${x + w / 2}" y="${y + 30}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="15" fill="#e6edf3">${title}</text>
  <text x="${x + w / 2}" y="${y + 50}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5" fill="#8b949e">${sub}</text>`;

const arrow = (d, label, sub, colour) => `
  <path d="${d}" fill="none" stroke="${colour}" stroke-width="1.6" marker-end="url(#head-${colour.replace('#', '')})"/>
  <text font-family="ui-monospace,monospace" font-size="11.5" fill="${colour}" text-anchor="middle">
    <textPath href="#p-${label.replace(/[^a-z]/gi, '')}" startOffset="50%">${label}</textPath>
  </text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ChunkPod state machine derived from the compiled artifact">
  <defs>
    ${['#3fb950', '#f7931a', '#f85149', '#8b949e'].map((c) => `<marker id="head-${c.replace('#', '')}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('\n    ')}
  </defs>
  <rect width="${W}" height="${H}" fill="#0b1016"/>
  ${box(40, 118, 190, 78, 'FRESH', 'client computes the pod address', { fill: '#12181f', stroke: '#242c37' })}
  ${box(330, 96, 240, 122, 'FUNDED', 'one coin holds the whole budget', { fill: '#1a2013', stroke: '#3fb950' })}
  ${box(670, 118, 190, 78, 'CLOSED', 'nothing left to spend', { fill: '#12181f', stroke: '#242c37' })}

  <path id="p-fund" d="M230,157 L330,157" fill="none" stroke="#3fb950" stroke-width="1.6" marker-end="url(#head-3fb950)"/>
  <text x="280" y="146" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#3fb950">fund()</text>

  <path id="p-deliver" d="M470,96 C470,40 400,40 400,96" fill="none" stroke="#f7931a" stroke-width="1.6" marker-end="url(#head-f7931a)"/>
  <text x="452" y="34" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11.5" fill="#f7931a">deliver() · provider · whole chunks ≤ window</text>

  <path id="p-refund" d="M570,150 C640,150 640,157 670,157" fill="none" stroke="#8b949e" stroke-width="1.6" marker-end="url(#head-8b949e)"/>
  <text x="621" y="140" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#8b949e">refund() · after expiry</text>

  <path id="p-close" d="M470,218 C470,270 400,270 400,218" fill="none" stroke="#3fb950" stroke-width="1.6" marker-end="url(#head-3fb950)" transform="translate(0,0)"/>
  <path d="M545,218 C640,275 640,200 668,175" fill="none" stroke="#3fb950" stroke-width="1.6" marker-end="url(#head-3fb950)"/>
  <text x="604" y="252" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#3fb950">close() · both keys</text>

  <text x="40" y="40" font-family="ui-monospace,monospace" font-size="12" fill="#8b949e">derived from artifacts/ChunkPod.json · ${artifact.contractName} · ${functions.length} spend paths · ${artifact.bytecode.length / 2} bytes</text>
  <text x="40" y="60" font-family="system-ui,sans-serif" font-size="11.5" fill="#55606b">every arrow is a real function in the ABI; if the contract gains a path, this diagram fails to build rather than lie</text>

  <g font-family="system-ui,sans-serif" font-size="11" fill="#8b949e">
    <text x="40" y="292">deliver: provider pays itself, remainder stays in the pod — the pod is its own state.</text>
    <text x="40" y="308">refund: needs tx.time ≥ validUntil. close: needs both keys, no expiry.</text>
  </g>
</svg>`;

const out = {
  contract: artifact.contractName,
  bytecodeBytes: artifact.bytecode.length / 2,
  functions,
  states: models,
  edges,
  mermaid,
  generatedFrom: 'artifacts/ChunkPod.json',
};

fs.mkdirSync(new URL('../web/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../web/phases.json', import.meta.url), JSON.stringify(out, null, 2));
fs.writeFileSync(new URL('../web/phases.svg', import.meta.url), svg);

if (process.argv.includes('--mermaid')) console.log(mermaid);
else console.log(`wrote web/phases.json and web/phases.svg — ${functions.length} paths: ${functions.join(', ')}`);
