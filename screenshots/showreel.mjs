// Records docs/showreel.gif: the plugin's real views, driven with a mouse and keyboard,
// on the same invented demo data as the screenshots. Usage: node screenshots/showreel.mjs
// (runs shoot.mjs first to build the scene pages; needs Chromium and ffmpeg).
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startReel } from "./reel.mjs";

const here = dirname(fileURLToPath(import.meta.url));
execFileSync("node", [join(here, "shoot.mjs")], { stdio: "ignore" });
const scene = (name) => `file://${join(here, "out", `${name}.html`)}`;

const reel = await startReel({ width: 1280, height: 760, workDir: join(here, "out", "reel-frames") });
const { page } = reel;

/** Centre of the first element matching `selector` whose text includes `text`. */
async function byText(selector, text) {
	const p = await page.evaluate((sel, t) => {
		const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t));
		if (!el) return null;
		el.scrollIntoView({ block: "nearest" });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, selector, text);
	if (!p) throw new Error(`no ${selector} containing "${text}"`);
	return p;
}

// ---- 1. the task list ----
console.error("tasks");
await reel.open(scene("tasks"));
await reel.caption("Tasks with statuses, types, linked notes, comments and images");
await reel.hold(1800);
await reel.caption("Search across titles, notes and comments");
await reel.click(".task-hub-search", { after: 200 });
await reel.type("lisbon");
await reel.hold(1300);
console.error("searched", reel.frameCount);
await page.keyboard.down("Control");
await page.keyboard.press("a");
await page.keyboard.up("Control");
await reel.key("Backspace", 500);
await reel.caption("Open, On Hold, Closed — or everything at once");
await reel.click(await byText(".task-hub-tab", "On Hold"), { after: 900 });
await reel.click(await byText(".task-hub-tab", "Closed"), { after: 900 });
await reel.click(await byText(".task-hub-tab", "All"), { after: 900 });
await reel.click(await byText(".task-hub-tab", "Open"), { after: 500 });
await reel.caption("Add a task in one line");
await reel.click(".task-hub-new-title", { after: 200 });
await reel.type("Order splashback tiles");
await reel.key("Enter", 1800);
console.error("added", reel.frameCount);

// ---- 2. Today ----
console.error("today");
await reel.open(scene("today"));
await reel.caption("Today: a short focus list, with an optional suggestion from Claude");
await reel.hold(2200);
await reel.click(await byText(".th-today-accept", "Accept"), { after: 1200 });
await reel.caption("Tick things off as you go");
const check = await reel.box(".th-today-check");
await reel.click(check, { after: 1600 });
console.error("ticked", reel.frameCount);

// ---- 3. a timeline ----
console.error("timeline");
await reel.open(scene("timeline"));
await reel.caption("Gantt timelines for a note: dependencies, milestones, critical path");
await reel.hold(2000);
await reel.click(await byText(".th-gantt-zoom button", "Week"), { after: 900 });
await reel.click(await byText(".th-gantt-zoom button", "Fit"), { after: 900 });
await reel.caption("Drag a bar to reschedule — everything after it follows");
const bar = await page.evaluate((title) => {
	const row = [...document.querySelectorAll(".th-gantt-row")].find((r) => r.textContent.includes(title));
	const b = row?.querySelector(".th-gantt-bar")?.getBoundingClientRect();
	return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, "Wireframes for key pages");
if (!bar) throw new Error("no bar for the wireframes task");
await reel.drag(bar, { x: bar.x + 90, y: bar.y }, { ms: 1200 });
// move off the bar so its tooltip closes
await reel.moveTo(bar.x + 90, bar.y + 260, { ms: 400 });
await reel.hold(1600);
console.error("dragged", reel.frameCount);
await reel.caption("Export to PDF, PNG or SVG");
await reel.moveTo(...Object.values(await byText(".th-gantt-toolbar button", "PDF")), { ms: 700 });
await reel.hold(1600);

const out = join(here, "..", "docs", "showreel.gif");
const { frames, seconds } = await reel.finish(out, { scale: 960 });
console.log(`docs/showreel.gif — ${frames} frames, ${seconds}s, ${(statSync(out).size / 1e6).toFixed(1)} MB`);
