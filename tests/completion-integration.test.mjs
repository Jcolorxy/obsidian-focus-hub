import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dom, loadUI } from './ui-harness.mjs';
const { default: Plugin } = await loadUI('src/main.ts');
test('Work history registers a command, ribbon and refreshable view', async () => {
  const plugin = Object.create(Plugin.prototype);
  const views = new Map(), commands = [], ribbons = [], opened = [];
  globalThis.window = {setInterval: () => 1};
  Object.assign(plugin, {app: {workspace: {onLayoutReady() {}, getLeavesOfType: () => []}, vault: {on() {}}},
    reload: async () => {}, registerInterval() {}, registerView: (id, factory) => views.set(id, factory),
    addRibbonIcon: (...args) => ribbons.push(args), addCommand: c => commands.push(c), addSettingTab() {},
    registerEditorExtension() {}, registerMarkdownCodeBlockProcessor() {}, registerEvent() {}, activateView: type => opened.push(type),
  });
  await plugin.onload();
  assert.ok(views.has('task-hub-history'));
  commands.find(c => c.id === 'open-history').callback();
  ribbons.find(r => r[1] === 'Work history')[2]();
  assert.deepEqual(opened, ['task-hub-history', 'task-hub-history']);
  const view = views.get('task-hub-history')({contentEl: document.body.createDiv()});
  let refreshes = 0; view.render = () => refreshes++;
  plugin.app.workspace.getLeavesOfType = type => type === 'task-hub-history' ? [{view}] : [];
  plugin.refreshViews(); assert.equal(refreshes, 1);
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(prompt = true) {
  const task = {id: 'task', title: 'Project work', status: 'open', closedAt: null, comments: [{id: 'old', text: 'Earlier evidence', time: 1, closeOut: true}]};
  const plugin = Object.create(Plugin.prototype);
  const saves = [], mirrors = [];
  Object.assign(plugin, {app: {}, data: {tasks: [task], settings: {closeOutPrompt: prompt}}, save: async () => saves.push(structuredClone(task)), noteSync: {update: async () => {}, syncComments: async t => mirrors.push(structuredClone(t.comments))}});
  globalThis.lastModal = null;
  return {plugin, task, saves, mirrors};
}
test('one completion prompt appends persisted close-out evidence without rewriting prior comments', async () => {
  const {plugin, task, saves, mirrors} = setup();
  await plugin.setStatus(task.id, 'closed');
  assert.equal(task.status, 'closed');
  assert.ok(task.closedAt > 0);
  assert.ok(globalThis.lastModal, 'completion modal opens on status transition');
  const modal = globalThis.lastModal;
  modal.contentEl.querySelector('textarea').value = 'Commissioned safely';
  [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === 'Save reflection').click();
  await flush();
  assert.equal(task.comments.length, 2);
  assert.deepEqual(task.comments[0], {id: 'old', text: 'Earlier evidence', time: 1, closeOut: true});
  assert.equal(task.comments[1].text, 'Result / what changed:\nCommissioned safely');
  assert.equal(task.comments[1].closeOut, true);
  assert.equal(saves.at(-1).comments.length, 2);
  assert.equal(mirrors.at(-1).length, 2);
  globalThis.lastModal = null;
  await plugin.setStatus(task.id, 'closed');
  assert.equal(globalThis.lastModal, null);
});
test('skip preserves closed status; disabled prompt and reopen do not append or prompt', async () => {
  for (const enabled of [true, false]) {
    const {plugin, task} = setup(enabled);
    await plugin.setStatus(task.id, 'closed');
    if (enabled) { assert.ok(globalThis.lastModal); globalThis.lastModal.close(); }
    else assert.equal(globalThis.lastModal, null);
    assert.equal(task.status, 'closed');
    assert.equal(task.comments.length, 1);
    globalThis.lastModal = null;
    await plugin.setStatus(task.id, 'open');
    assert.equal(task.status, 'open');
    assert.equal(globalThis.lastModal, null);
  }
});
