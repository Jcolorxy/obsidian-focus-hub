import assert from 'node:assert/strict';
import { test } from 'node:test';
import { document, dom, loadUI } from './ui-harness.mjs';
const { CompletionModal } = await loadUI('src/completion.ts');
function setup() {
  const saved = [];
  const modal = new CompletionModal({}, '<img src=x> Task / project', text => saved.push(text));
  modal.open(); return {modal, saved, el: modal.contentEl};
}
test('completion reflection persists labelled plain text through one existing comment callback', () => {
  const {el, saved, modal} = setup();
  assert.equal(el.querySelector('img'), null);
  assert.match(el.textContent, /Task stays closed/);
  const inputs = [...el.querySelectorAll('textarea')];
  assert.equal(inputs.length, 3);
  inputs.forEach((input, i) => {
    assert.ok(input.closest('label'));
    input.value = ['  Replaced pump  ', 'I scoped and commissioned it', '<script>evidence</script>'][i];
    input.dispatchEvent(new dom.window.Event('input'));
  });
  inputs[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true}));
  assert.deepEqual(saved, ['Result / what changed:\nReplaced pump\n\nMy contribution:\nI scoped and commissioned it\n\nMeasurable impact / evidence:\n<script>evidence</script>']);
  modal.onClose(); assert.equal(saved.length, 1);
});
test('blank impact is optional; Escape, Skip and window close discard drafts without reopening task', () => {
  for (const action of ['escape', 'skip', 'close', 'blank', 'partial']) {
    const {el, saved, modal} = setup();
    const input = el.querySelector('textarea');
    input.value = action === 'blank' ? '  ' : 'Observed result';
    input.dispatchEvent(new dom.window.Event('input'));
    if (action === 'escape') input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    else if (action === 'close') modal.close();
    else [...el.querySelectorAll('button')].find(b => b.textContent === (action === 'skip' ? 'Skip reflection' : 'Save reflection')).click();
    assert.deepEqual(saved, [action === 'partial' ? 'Result / what changed:\nObserved result' : null]);
  }
});
