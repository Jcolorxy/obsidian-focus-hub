import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
// pin the zone the dates are bucketed in, so results don't depend on the host
globalThis.TASK_HUB_TZ = 'Australia/Sydney';
const bundle = await build({ entryPoints: ['src/history.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { historyModel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
test('inclusive year/date/note filters intersect; undated work stays separate from date matches', () => {
  const tasks = [task('oct', {closedAt: Date.parse('2026-09-30T15:00Z'), note: 'Projects/A.md'}), task('sep', {closedAt: Date.parse('2026-09-30T12:00Z'), note: 'Projects/A.md'}), task('other', {closedAt: Date.parse('2026-10-01T02:00Z'), note: 'Projects/B.md'}), task('unknown', {note: 'Projects/A.md'}), task('unlinked')];
  const model = historyModel(tasks, {year: '2026', from: '2026-10-01', to: '2026-10-01', note: 'Projects/A.md'});
  assert.deepEqual(model.months.flatMap(m => m.tasks.map(t => t.id)), ['oct']);
  assert.deepEqual(model.undated.map(t => t.id), ['unknown']);
  assert.deepEqual(model.years, ['2026']);
  assert.deepEqual(model.notes, ['Projects/A.md', 'Projects/B.md']);
  assert.equal(historyModel(tasks, {year: '2025'}).months.length, 0);
  assert.equal(historyModel(tasks, {from: '2026-11-01', to: '2026-10-01'}).invalidRange, true);
  assert.deepEqual(historyModel(tasks, {note: null}).undated.map(t => t.id), ['unlinked']);
});
const task = (id, overrides = {}) => ({id, title: id, status: 'closed', closedAt: null, comments: [], note: null, ...overrides});
test('synthetic 95-record legacy distribution retains all 49 dated and 46 undated records and 16 close-outs', () => {
  const tasks = Array.from({length: 95}, (_, i) => task(String(i), {
    closedAt: i < 49 ? Date.parse('2026-01-01T00:00Z') + i * 86400000 : null,
    comments: i < 16 ? [{id: `comment-${i}`, time: 1000, closeOut: true, text: `Evidence ${i}`}] : [],
  }));
  const before = JSON.stringify(tasks);
  const model = historyModel(tasks);
  const dated = model.months.flatMap(m => m.tasks);
  const all = [...dated, ...model.undated];
  assert.equal(dated.length, 49);
  assert.equal(model.undated.length, 46);
  assert.equal(new Set(all.map(t => t.id)).size, 95);
  assert.equal(all.flatMap(t => t.comments).filter(c => c.closeOut).length, 16);
  assert.equal(JSON.stringify(tasks), before);
});
test('Sydney DST and year boundaries are independent of host timezone; invalid dates remain unknown', () => {
  const model = historyModel([
    task('summer', {closedAt: Date.parse('2025-12-31T13:30Z')}),
    task('winter', {closedAt: Date.parse('2026-06-30T14:30Z')}),
    task('missing', {closedAt: undefined}), task('string', {closedAt: '2026-01-01'}),
    task('overflow', {closedAt: 1e99}), task('infinity', {closedAt: Infinity}),
  ]);
  assert.deepEqual(model.months.map(m => m.month), ['2026-07', '2026-01']);
  assert.equal(model.undated.length, 4);
});
test('all closed legacy records survive; only actual completion dates form Sydney months', () => {
  const tasks = [task('utc', {closedAt: Date.parse('2026-09-30T15:00:00Z')}), task('legacy', {due: '2026-09-30', updated: Date.now(), created: 123}), task('invalid', {closedAt: NaN}), task('open', {status: 'open', closedAt: 123})];
  const before = structuredClone(tasks);
  const model = historyModel(tasks);
  assert.equal(model.total, 3);
  assert.deepEqual(model.months.map(m => [m.month, m.tasks.map(t => t.id)]), [['2026-10', ['utc']]]);
  assert.deepEqual(model.undated.map(t => t.id), ['invalid', 'legacy']);
  assert.deepEqual(tasks, before);
});
