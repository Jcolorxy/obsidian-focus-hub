import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { document, dom, loadUI } from './ui-harness.mjs';
// pin the zone the dates are bucketed in, so results don't depend on the host
process.env.TZ = 'Australia/Sydney';
test('history and completion layouts wrap on narrow panes and retain theme and keyboard focus cues', () => {
  const css = readFileSync('styles.css', 'utf8');
  assert.match(css, /\.th-history\s*\{[^}]*container:\s*th-history/);
  assert.match(css, /@container th-history \(max-width: 520px\)/);
  assert.match(css, /\.th-history-card\s*\{[^}]*border-inline-start:[^;]*var\(--interactive-accent\)/);
  assert.match(css, /\.th-completion-field textarea\s*\{[^}]*width:\s*100%/);
  assert.match(css, /:focus-visible/);
});
const { HistoryView } = await loadUI('src/historyview.ts');
const tasks = [
  {id: 'a', title: '<img src=x> Pump upgrade', status: 'closed', closedAt: Date.parse('2026-09-30T15:00Z'), note: 'Work/Projects/Pump.md', comments: [{text: 'Old close-out <script>bad()</script>', closeOut: true}, {text: 'New close-out', closeOut: true}, {text: 'Private ordinary comment', closeOut: false}]},
  {id: 'b', title: 'Legacy achievement', status: 'closed', closedAt: null, note: 'Work/Legacy.md', comments: []},
];
test('history excludes notes outside Work including unlinked and similarly named folders', async () => {
  const contentEl = document.body.createDiv();
  const notes = ['Work/Client/Project.md', 'Work/Direct.md', 'Life/Personal.md', 'Workshops/Other.md', null];
  const data = notes.map((note, i) => ({id: String(i), title: `Item ${i}`, status: 'closed', closedAt: null, note, comments: []}));
  const view = new HistoryView({contentEl}, {data: {tasks: data}});
  await view.onOpen();
  assert.equal(contentEl.querySelectorAll('.th-history-card').length, 2);
  assert.doesNotMatch(contentEl.textContent, /Life\/Personal|Workshops\/Other|Item 4/);
  assert.match(contentEl.textContent, /2 closed in total/);
  await view.onClose();
});
test('history is read-only, safely renders all evidence and undated records; filters retain keyboard focus', async () => {
  const contentEl = document.body.createDiv();
  const opened = [];
  const before = structuredClone(tasks);
  const view = new HistoryView({contentEl}, {data: {tasks}, openPath: p => opened.push(p)});
  await view.onOpen();
  assert.match(contentEl.textContent, /October 2026/);
  assert.match(contentEl.textContent, /Completion date unknown/);
  assert.match(contentEl.textContent, /Old close-out <script>bad\(\)<\/script>/);
  assert.match(contentEl.textContent, /New close-out/);
  assert.doesNotMatch(contentEl.textContent, /Private ordinary comment/);
  assert.equal(contentEl.querySelector('img, script'), null);
  assert.match(contentEl.querySelector('time').textContent, /01\/10\/2026/);
  contentEl.querySelector('.th-history-note').click();
  assert.deepEqual(opened, ['Work/Projects/Pump.md']);
  const year = contentEl.querySelector('[aria-label="Year"]');
  year.focus();
  const from = contentEl.querySelector('[aria-label="From date"]');
  from.value = '2026-11-01'; from.focus(); from.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.activeElement, from);
  assert.match(contentEl.textContent, /No dated completions match/);
  assert.match(contentEl.textContent, /Legacy achievement/);
  assert.match(contentEl.textContent, /not included in date-filtered counts/);
  assert.deepEqual(tasks, before);
  await view.onClose();
  assert.equal(contentEl.textContent, '');
});
