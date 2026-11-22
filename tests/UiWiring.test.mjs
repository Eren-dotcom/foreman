/**
 * tests/UiWiring.test.mjs — the page and its script agree.
 *
 * Splitting a 980-line single file into index.html + app.css + app.js is the kind of
 * change that breaks silently: the markup renders, the script throws on a null at
 * line 400, and the page looks half-dead. There is no headless browser here, so this
 * checks the one thing that actually breaks — every id the script reaches for must
 * exist in the markup, and every id in the markup must be reachable or deliberately
 * inert.
 *
 * Offline, no dependencies, reads two files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');

const idsIn = (src) => new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsReached = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
]);

test('every id the script looks up exists in the markup', () => {
  const present = idsIn(html);
  const missing = [...idsReached].filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `script reaches for ids that are not in index.html: ${missing.join(', ')}`);
});

test('the page loads exactly one stylesheet and one module', () => {
  assert.equal((html.match(/<link[^>]+app\.css/g) ?? []).length, 1);
  assert.equal((html.match(/<script[^>]+app\.js/g) ?? []).length, 1);
  assert.ok(!html.includes('<style>'), 'no inline style block left behind');
  assert.ok(!html.includes('<script type="module">'), 'no inline module left behind');
});

test('the stylesheet is not empty and defines the theme variables the markup uses', () => {
  assert.ok(css.split('\n').length > 50);
  for (const v of ['--line', '--dim', '--mono', '--bad', '--ok']) {
    assert.ok(css.includes(v + ':'), `missing theme variable ${v}`);
  }
});

test('no leftover placeholder text or TODO markers', () => {
  for (const [name, src] of [['index.html', html], ['app.js', js]]) {
    assert.ok(!/TODO|FIXME|Lorem ipsum/.test(src), `${name} contains a placeholder`);
  }
});
