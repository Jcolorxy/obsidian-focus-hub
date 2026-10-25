// Records docs/planning.gif: the two features that show best in motion — planning the
// day in Today, and rescheduling a timeline by dragging. Demo data only.
// Usage: node screenshots/showreel-planning.mjs (needs Chromium and ffmpeg).
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startReel } from "./reel.mjs";

const here = dirname(fileURLToPath(import.meta.url));
execFileSync("node", [join(here, "shoot.mjs")], { stdio: "ignore" });
const scene = (name) => `file://${join(here, "out", `${name}.html`)}`;

const reel = await startReel({ width: 1440, height: 860, workDir: join(here, "out", "reel-planning") });
const { page } = reel;

/** Centre of the first element matching `selector` whose text includes `text`. */
async function byText(selector, text, nth = 0) {
	const p = await page.evaluate((sel, t, n) => {
		const el = [...document.querySelectorAll(sel)].filter((e) => e.textContent.includes(t))[n];
		if (!el) return null;
		el.scrollIntoView({ block: "nearest" });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, selector, text, nth);
	if (!p) throw new Error(`no ${selector} containing "${text}"`);
	return p;
}

/** The bar (or its resize handle) on the timeline row for `title`. */
async function barOf(title, part = ".th-gantt-bar") {
	const p = await page.evaluate((t, sel) => {
		const row = [...document.querySelectorAll(".th-gantt-row")].find((r) => r.textContent.includes(t));
		const b = row?.querySelector(sel)?.getBoundingClientRect();
		return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
	}, title, part);
	if (!p) throw new Error(`no ${part} for "${title}"`);
	return p;
}

// ---- Today ----
await reel.open(scene("today-fresh"));
await reel.caption("Each morning, Claude suggests the few tasks most worth doing");
await reel.hold(1500);
await reel.moveTo(...Object.values(await byText(".th-today-accept", "Accept")), { ms: 900 });
await reel.hold(1300);
await reel.caption("Accept the suggestion as today's focus");
await reel.click(await byText(".th-today-accept", "Accept"), { after: 1800 });
await reel.caption("Put the most important first");
await reel.click(await byText(".th-today-rowbtn[aria-label='Move up']", "", 0), { after: 1500 });
await reel.caption("Tick things off as you go");
await reel.click(".th-today-check", { after: 900 });
await reel.click(await byText(".th-today-check", "", 1), { after: 1800 });

// ---- the timeline ----
await reel.open(scene("timeline"));
await reel.caption("Every task on a project's timeline, with dependencies and the critical path");
await reel.click(await byText(".th-gantt-zoom button", "Fit"), { after: 1600 });
await reel.caption("Drag a bar to reschedule — everything that depends on it follows");
const wires = await barOf("Wireframes for key pages");
await reel.drag(wires, { x: wires.x + 75, y: wires.y }, { ms: 1400 });
await reel.hold(400);
await reel.moveTo(wires.x + 75, wires.y + 300, { ms: 500 });
await reel.hold(1800);
await reel.caption("Drag the end of a bar to change how long it takes");
const build = await barOf("Build page templates", ".th-gantt-handle");
await reel.drag(build, { x: build.x + 60, y: build.y }, { ms: 1200 });
await reel.hold(400);
await reel.moveTo(build.x - 200, build.y + 160, { ms: 500 });
await reel.caption("Working days, holidays and the critical path are recalculated as you go");
await reel.hold(2600);

const out = join(here, "..", "docs", "planning.gif");
const { frames, seconds } = await reel.finish(out, { scale: 1000 });
console.log(`docs/planning.gif — ${frames} frames, ${seconds}s, ${(statSync(out).size / 1e6).toFixed(1)} MB`);
