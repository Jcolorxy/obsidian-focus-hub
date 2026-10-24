import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
export const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
export const { document } = dom.window;
globalThis.document = document;
Object.assign(dom.window.HTMLElement.prototype, {
  empty() { this.replaceChildren(); },
  addClass(...names) { this.classList.add(...names); },
  createEl(tag, opts = {}) {
    const el = document.createElement(tag);
    if (opts.cls) el.className = opts.cls;
    if (opts.text !== undefined) el.textContent = opts.text;
    if (opts.type) el.setAttribute('type', opts.type);
    for (const [k, v] of Object.entries(opts.attr ?? {})) el.setAttribute(k, v);
    this.append(el); return el;
  },
  createDiv(opts) { return this.createEl('div', opts); },
  createSpan(opts) { return this.createEl('span', opts); },
});
export async function loadUI(entry) {
  const bundle = await build({entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{name: 'obsidian-boundary', setup(b) {
      b.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'stub'}));
      b.onLoad({filter: /.*/, namespace: 'stub'}, () => ({contents: `
        export class ItemView { constructor(leaf) { Object.assign(this, leaf); } }
        export class Modal { constructor(app) { this.app = app; this.contentEl = document.body.createDiv(); this.modalEl = this.contentEl; } open() { this.onOpen(); globalThis.lastModal = this; } close() { this.onClose(); } }
        export class Plugin {} export class SecretComponent {} export class PluginSettingTab {} export class FuzzySuggestModal extends Modal {}
        export class Notice {} export class TFile {} export class TFolder {} export class Menu {}
        export function setIcon() {} export function normalizePath(p) { return p; }
        export class Setting { constructor(el) { this.el = el; } addButton(fn) { const el = this.el.createEl('button'); const b = {setButtonText(v) {el.textContent=v;return b;},setCta(){return b;},onClick(f){el.addEventListener('click',f);return b;}}; fn(b); return this; } }
      `}));
    }}]});
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
