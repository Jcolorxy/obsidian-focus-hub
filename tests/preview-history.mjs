// Synthetic-only visual fixture rendered by the real view and modal. No vault access.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { document, dom, loadUI } from './ui-harness.mjs';
const { HistoryView } = await loadUI('src/historyview.ts');
const { CompletionModal } = await loadUI('src/completion.ts');
const css = readFileSync('styles.css', 'utf8');
const base = `:root { color-scheme: dark; --background-primary:#202125; --background-secondary:#282a30; --background-modifier-border:#42444d; --interactive-accent:#9c89e9; --text-normal:#e6e6eb; --text-muted:#b0b1bb; --text-accent:#bcb0ff; --font-ui-small:14px; --font-ui-smaller:12px; --radius-m:10px; } * {box-sizing:border-box} body {margin:0;background:var(--background-primary);color:var(--text-normal);font:16px system-ui;} button,input,select,textarea {font:inherit;color:inherit;background:#202125;border:1px solid #555764;border-radius:5px;padding:8px;} button{cursor:pointer} .setting-item-description {font-size:13px;color:var(--text-muted);line-height:1.5} .mod-cta {background:#7460b6;} .synthetic-banner {padding:10px 16px;background:#383042;color:#d3c4ec;font-size:12px} .th-completion {max-width:600px;margin:auto;padding:24px}`;
function save(name) {
  mkdirSync('test-tmp', {recursive: true});
  writeFileSync(`test-tmp/${name}.html`, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Task Hub preview</title><style>${base}\n${css}</style></head><body><div class="synthetic-banner">SYNTHETIC PREVIEW — demonstration data, not observed work</div>${document.body.innerHTML}</body></html>`);
}
const task = (id, title, when, note, text) => ({id, title, status: 'closed', closedAt: when ? Date.parse(when) : null, note, comments: text ? [{closeOut: true, text}] : []});
const tasks = [
 task('1','Pump upgrade commissioned','2026-10-01T00:00Z','Projects/Pump upgrade.md','Result / what changed:\nReplacement pump commissioned.\n\nMy contribution:\nScoped the work and coordinated commissioning.\n\nMeasurable impact / evidence:\nAcceptance checklist signed; performance figures pending.'),
 task('2','Maintenance handover agreed','2026-09-23T01:00Z','Projects/Maintenance.md','Agreed ownership and documented the handover.'),
 task('3','Legacy project close-out',null,'Projects/Legacy.md',null),
];
await new HistoryView({contentEl: document.body.createDiv()}, {data: {tasks}, openPath() {}}).onOpen();
save('history-preview');
document.body.replaceChildren();
new CompletionModal({}, 'Pump upgrade commissioned', () => {}).open();
save('completion-preview');
console.log('Generated test-tmp/history-preview.html and test-tmp/completion-preview.html');
