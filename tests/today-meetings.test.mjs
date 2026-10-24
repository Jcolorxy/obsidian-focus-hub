import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
// pin the zone the dates are bucketed in, so results don't depend on the host
globalThis.TASK_HUB_TZ = 'Australia/Sydney';

test('meeting timeline has theme-based narrow-container layout rules', () => {
  const css = readFileSync('styles.css', 'utf8');
  assert.match(css, /\.th-meeting\s*\{[^}]*grid-template-columns:\s*5rem minmax\(0, 1fr\)/);
  assert.match(css, /\.th-meeting-content\s*\{[^}]*border-inline-start:[^;]*var\(--interactive-accent\)/);
  assert.match(css, /@container th-meetings \(max-width: 420px\)/);
  assert.match(css, /\.th-meeting-fallback\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

const dom = new JSDOM('<!doctype html><body></body>');
const { document, HTMLElement } = dom.window;
Object.assign(HTMLElement.prototype, {
  empty() { this.replaceChildren(); },
  addClass(name) { this.classList.add(name); },
  createEl(tag, options = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    this.append(el); return el;
  },
  createDiv(options) { return this.createEl('div', options); },
  createSpan(options) { return this.createEl('span', options); },
});
const bundle = await build({ entryPoints: ['src/todayview.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'obsidian-test-boundary', setup(build) {
    build.onResolve({ filter: /^(obsidian|\.\/modals|\.\/ganttview|\.\/progress|\.\/today)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: {
      obsidian: 'export class ItemView { constructor(leaf) { Object.assign(this, leaf); this.events = []; } registerEvent(ref) { this.events.push(ref); } } export class Modal {} export class Menu {} export class Setting {} export class WorkspaceLeaf {} export function setIcon() {} export class TFile { constructor(path) { this.path = path; } }',
      './modals': 'export class ScheduleModal {} export class TaskPickerModal {} export class CommentModal {}',
      './ganttview': 'export function prepareRows() {} export function progressOf() {} export const DEFAULT_OPTIONS = {};',
      './progress': 'export function renderMeter() {} export function scheduleProgress() {}',
      './today': 'export function todayModel() { return {plan: [], upcoming: [], waiting: [], stale: []}; }',
    }[args.path] }));
  } }],
});
const { TodayView } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const path = 'Work/Outlook calendar.md';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const snapshot = (row = '10:00–11:00 — Planning') => `# Outlook calendar\n\nSnapshot window: ${today}\n\n## ${today}\n- ${row}\n`;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('meeting agenda separates time, title and location in accessible event cards', async () => {
  const s = setup(async () => snapshot('10:00–11:00 — Planning — Office\n- 13:30–14:00 — <img src=x> [literal]'));
  await s.view.onOpen(); await flush();
  const agenda = s.contentEl.querySelector('.th-meetings-agenda');
  assert.ok(agenda, 'agenda list is rendered');
  assert.equal(agenda.tagName, 'UL');
  const rows = [...agenda.querySelectorAll('.th-meeting')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tagName, 'LI');
  assert.equal(rows[0].querySelector('.th-meeting-start').textContent, '10:00');
  assert.equal(rows[0].querySelector('.th-meeting-end').textContent, 'to 11:00');
  assert.equal(rows[0].querySelector('.th-meeting-title').textContent, 'Planning');
  assert.equal(rows[0].querySelector('.th-meeting-location').textContent, 'Office');
  assert.equal(rows[1].querySelector('.th-meeting-title').textContent, '<img src=x> [literal]');
  assert.equal(rows[1].querySelector('.th-meeting-location'), null);
  assert.equal(agenda.querySelector('img'), null);
});
test('all-day entries show a badge without inventing a time', async () => {
  const s = setup(async () => snapshot('All day — Workshop — Training room'));
  await s.view.onOpen(); await flush();
  const row = s.contentEl.querySelector('.th-meeting');
  assert.equal(row.querySelector('.th-meeting-badge')?.textContent, 'All day');
  assert.equal(row.querySelector('.th-meeting-title')?.textContent, 'Workshop');
  assert.equal(row.querySelector('.th-meeting-location')?.textContent, 'Training room');
  assert.equal(row.querySelector('.th-meeting-start'), null);
});

test('unknown rows remain complete safe text in full-width fallback cards', async () => {
  const rows = ['Unrecognised entry — <script>bad()</script>', '25:00–26:00 — Invalid time', 'No events in this snapshot.'];
  const s = setup(async () => snapshot(rows.join('\n- ')));
  await s.view.onOpen(); await flush();
  const cards = [...s.contentEl.querySelectorAll('.th-meeting-fallback')];
  assert.equal(cards.length, rows.length);
  assert.deepEqual(cards.map(card => card.textContent), rows);
  assert.equal(s.contentEl.querySelector('.th-meetings-agenda script'), null);
  assert.equal(s.contentEl.querySelector('.th-meeting-time'), null);
});

test('Today Work history button opens the history view without fetching or changing tasks', async () => {
  const s = setup();
  const calls = [];
  s.view.plugin.activateView = type => calls.push(type);
  await s.view.onOpen(); await flush();
  const button = [...s.contentEl.querySelectorAll('button')].find(b => b.textContent === 'Work history');
  assert.ok(button);
  button.click();
  assert.deepEqual(calls, ['task-hub-history']);
});

function setup(read = async () => snapshot()) {
  const contentEl = document.body.createDiv();
  const file = { path };
  const handlers = {};
  const opened = [];
  const vault = {
    getAbstractFileByPath: requested => requested === path ? file : null,
    getFileByPath: requested => requested === path ? file : null,
    read, on: (event, callback) => { handlers[event] = callback; return { event }; },
  };
  const plugin = { ensureToday: async () => {}, syncGraceOver: false,
    data: { tasks: [], today: {focus: [], carried: []}, settings: {focusLimit: 3, staleDays: 7, meetingsNotePath: path} },
    briefState: {}, timelineNotes: new Set(), openPath: async p => opened.push(p),
  };
  const app = { vault, workspace: { openLinkText: async p => opened.push(p) } };
  const view = new TodayView({ app, contentEl }, plugin);
  return { view, vault, contentEl, handlers, opened, file };
}

test('registered vault events refresh only the rolling file while open', async () => {
  let reads = 0;
  const s = setup(async () => { reads++; return snapshot(); });
  await s.view.onOpen(); await flush();
  assert.deepEqual(s.view.events.map(ref => ref.event).sort(), ['create', 'delete', 'modify']);
  for (const event of ['create', 'modify', 'delete']) {
    const before = reads;
    s.handlers[event]({ path: 'Other.md' }); await flush(); assert.equal(reads, before);
    s.handlers[event](s.file); await flush(); assert.equal(reads, before + 1);
  }
  await s.view.onClose();
  const before = reads;
  s.handlers.modify(s.file); await flush(); assert.equal(reads, before);
});

test('late snapshot reads do not mutate superseded or closed view elements', async () => {
  const pending = [];
  const s = setup(() => new Promise(resolve => pending.push(resolve)));
  await s.view.onOpen();
  const old = s.contentEl.querySelector('.th-today-meetings');
  s.view.render();
  pending[1](snapshot('New snapshot')); await flush();
  pending[0](snapshot('Old snapshot')); await flush();
  assert.equal(old.textContent, 'Reading calendar snapshot…');
  assert.match(s.contentEl.textContent, /New snapshot/);
  s.view.render();
  const closing = s.contentEl.querySelector('.th-today-meetings');
  await s.view.onClose(); pending[2](snapshot('Late snapshot')); await flush();
  assert.equal(closing.textContent, 'Reading calendar snapshot…');
  assert.equal(s.contentEl.textContent, '');
});

test('missing, out-of-window and empty snapshots never imply a free calendar', async () => {
  for (const kind of ['missing', 'no-section', 'empty', 'error']) {
    const s = setup(async () => {
      if (kind === 'error') throw new Error('sensitive details');
      return kind === 'no-section' ? '# Outlook calendar\nSnapshot window: old\n## 2000-01-01\n- Old event' : `# Outlook calendar\n## ${today}\n`;
    });
    if (kind === 'missing') s.vault.getFileByPath = () => null;
    await s.view.onOpen(); await flush();
    const text = s.contentEl.querySelector('.th-today-meetings').textContent;
    assert.match(text, /unavailable|stale|no meetings listed/i);
    assert.match(text, /not confirm.*free/i);
    assert.doesNotMatch(text, /sensitive details/);
  }
});

test('Today renders snapshot as text above focus, with timezone and local-only controls', async () => {
  let reads = 0;
  const s = setup(async () => { reads++; return snapshot(String.raw`All day — \<img src=x onerror=alert(1)\> \[literal\]`); });
  await s.view.onOpen(); await flush();
  const main = s.contentEl.querySelector('.th-today-main');
  assert.equal(main.firstElementChild.querySelector('.th-today-card-title').textContent, 'Work meetings');
  assert.match(main.textContent, /Australia\/Sydney/);
  assert.match(main.textContent, /Snapshot window:/);
  assert.match(main.textContent, /<img src=x onerror=alert\(1\)> \[literal\]/);
  assert.equal(main.querySelector('img'), null);
  const buttons = [...main.querySelectorAll('button')];
  buttons.find(b => b.textContent === 'Open calendar').click(); await flush();
  assert.deepEqual(s.opened, [path]);
  const refresh = buttons.find(b => b.textContent === 'Refresh view');
  assert.match(refresh.title, /not fetch Outlook/i);
  refresh.click(); await flush(); assert.equal(reads, 2);
  assert.match(main.textContent, /Today's focus/);
});
