/**
 * The panel's element map against its markup.
 *
 * panel.js resolves every control once, at module load, with getElementById. A
 * typo or a renamed id does not throw there — it stores null, and the failure
 * surfaces later as "clicking Start does nothing", with no stack pointing at the
 * cause. These are string literals in two files that must agree, and nothing in
 * the language checks that they do.
 *
 * Parsed rather than executed: panel.js needs a DOM and chrome.* to import, and
 * standing those up would test the mocks more than the wiring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
const panelJs = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');

const markupIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const lookedUp = [...panelJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

test('every element panel.js looks up exists in panel.html', () => {
  const missing = lookedUp.filter((id) => !markupIds.has(id));
  assert.deepEqual(missing, [], `panel.js reads ids that panel.html does not define`);
});

test('panel.js looks up something at all', () => {
  // Guards the guard: a regex that silently stopped matching would make both of
  // these pass forever.
  assert.ok(lookedUp.length > 20, `only found ${lookedUp.length} lookups`);
  assert.ok(markupIds.size > 20, `only found ${markupIds.size} ids`);
});

test('ids are unique in the markup', () => {
  // getElementById returns the first match, so a duplicate is a control that
  // silently never receives its listener.
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicated = all.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(duplicated, []);
});

test('classes the stylesheet must know about are defined', () => {
  // The panel is styled entirely by class, and a class that only exists in the
  // renderer is invisible rather than obviously broken.
  const css = readFileSync(new URL('../src/panel.css', import.meta.url), 'utf8');
  for (const className of [
    'upsell',
    'route-chip',
    'progress-track',
    'progress-bar',
    'mode-note',
    'history-title',
  ]) {
    assert.match(css, new RegExp(`\\.${className}[\\s,{:.]`), `.${className} has no styles`);
  }
});
