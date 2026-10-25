import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
// pin the zone the dates are bucketed in, so results don't depend on the host
process.env.TZ = 'Australia/Sydney';

const bundle = await build({ entryPoints: ['src/meetings.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { parseMeetings, localDate } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('uses Sydney date across UTC midnight and daylight saving', () => {
  assert.equal(localDate(new Date('2026-09-30T14:30:00Z')), '2026-10-01');
  assert.equal(localDate(new Date('2026-10-04T13:30:00Z')), '2026-10-05');
});

test('decodes Markdown punctuation escapes once without interpreting HTML or links', () => {
  const result = parseMeetings(String.raw`# Outlook calendar
Snapshot: a\_b
## 2026-10-01
- All day — \<img src=x onerror=alert(1)\> \[name\]\(url\) C:\\Temp \*literal\* \q
`, '2026-10-01');
  assert.equal(result.context, 'Snapshot: a_b');
  assert.deepEqual(result.rows, [String.raw`All day — <img src=x onerror=alert(1)> [name](url) C:\Temp *literal* \q`]);
});

test('rolling importer marker is excluded from snapshot context', () => {
  const result = parseMeetings('<!-- calendar-snapshot:rolling -->\n# Outlook calendar\n\nPublished-feed snapshot window: 2026-10-01 to 2026-10-07\n\nGenerated snapshot; use Open Today.\n\n## 2026-10-01\n- All day — Leave\n', '2026-10-01');
  assert.equal(result.context, 'Published-feed snapshot window: 2026-10-01 to 2026-10-07 Generated snapshot; use Open Today.');
  assert.deepEqual(result.rows, ['All day — Leave']);
});

test('selects only the requested day and retains snapshot context', () => {
  const result = parseMeetings('# Outlook calendar\n\nSnapshot window: 2026-10-01 to 2026-10-07\n\n## 2026-10-01\n- 10:00–11:00 — Planning — Office\n- All day — Leave\n\n## 2026-10-02\n- 09:00–10:00 — Other day\n', '2026-10-01');
  assert.deepEqual(result, { context: 'Snapshot window: 2026-10-01 to 2026-10-07', found: true, rows: ['10:00–11:00 — Planning — Office', 'All day — Leave'] });
});
