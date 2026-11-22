/**
 * verify.mjs — validates foreman.pod.template.json with the XO engine's own schema
 * and resolves its scripts through the compiler.
 *
 *   node verify.mjs        (needs Node 22+)
 */
import fs from 'node:fs';
import { parseTemplate, generateTemplateIdentifier, scriptsForLibauthCompiler } from '@xo-cash/engine';

const tpl = parseTemplate(JSON.parse(fs.readFileSync(new URL('./foreman.pod.template.json', import.meta.url), 'utf8')));
// control: the shipped template only needs to *exist* for comparison; the engine's
// bundled template copy may be a newer schema than the one the engine parses, so we
// do not require it to validate here.
const result = {
  at: new Date().toISOString(),
  templateIdentifier: generateTemplateIdentifier(tpl),
  scripts: Object.keys(scriptsForLibauthCompiler(tpl)),
  roles: Object.keys(tpl.roles ?? {}),
  variables: Object.keys(tpl.variables ?? {}),
  transactions: Object.keys(tpl.transactions ?? {}),
};
console.log('✓ parsed by the XO engine schema');
console.log('  templateIdentifier:', result.templateIdentifier);
console.log('  transactions:', result.transactions.join(', '));
console.log('  scripts:', result.scripts.join(', '));
console.log('  roles:', result.roles.join(', '));
fs.writeFileSync(new URL('./verify.json', import.meta.url), JSON.stringify(result, null, 2));
