// README screenshots: the plugin's real views, rendered with invented demo data.
// Nothing here reads a vault. Run `node screenshots/shoot.mjs`.
import FocusHub from "../src/main";
import { TaskHubView } from "../src/view";
import { TodayView } from "../src/todayview";
import { renderGanttBlock } from "../src/ganttview";
import { fakeApp } from "obsidian";

const DAY = 86_400_000;
const today = new Date();
today.setHours(9, 0, 0, 0);
const iso = (offset: number) => {
	const d = new Date(today.getTime() + offset * DAY);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ago = (days: number) => today.getTime() - days * DAY;

// a simple illustrative "photo" for the image strip
const photo = (a: string, b: string) =>
	"data:image/svg+xml;charset=utf-8," +
	encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="240" height="240" fill="url(#g)"/><path d="M0 190 L70 120 L120 160 L170 100 L240 170 L240 240 L0 240 Z" fill="rgba(0,0,0,.28)"/><circle cx="182" cy="62" r="22" fill="rgba(255,255,255,.55)"/></svg>`);

const NOTE = {
	kitchen: "Home/Kitchen renovation.md",
	site: "Work/Website relaunch.md",
	trip: "Travel/Lisbon trip.md",
};

let seq = 0;
function task(title: string, o: Record<string, unknown> = {}) {
	seq++;
	return {
		id: `demo-${seq}`, title, status: "open", type: null, note: null, images: [], comments: [],
		due: null, start: null, durationDays: null, deps: [], order: null, depLags: {},
		milestone: false, percent: null, phase: null, owner: null, baseline: null,
		collapsed: false, created: ago(30 - seq), updated: ago(o.quiet ? 20 : 1), closedAt: null,
		...o,
	};
}
const comment = (text: string, daysAgo: number, closeOut = false) => ({ id: `c-${++seq}`, text, time: ago(daysAgo), closeOut });

// ---- a website relaunch timeline ----
const brief = task("Agree scope and success measures", { type: "Work", note: NOTE.site, phase: "Discovery", owner: "Sam", start: iso(-12), durationDays: 3, status: "closed", closedAt: ago(9) });
const audit = task("Content audit", { type: "Work", note: NOTE.site, phase: "Discovery", owner: "Ana", durationDays: 4, deps: [brief.id], percent: 100, status: "closed", closedAt: ago(3) });
const wires = task("Wireframes for key pages", { type: "Work", note: NOTE.site, phase: "Design", owner: "Ana", durationDays: 5, deps: [audit.id], percent: 60 });
const sign = task("Design sign-off", { type: "Work", note: NOTE.site, phase: "Design", milestone: true, deps: [wires.id] });
const build = task("Build page templates", { type: "Work", note: NOTE.site, phase: "Build", owner: "Ravi", durationDays: 8, deps: [sign.id], depLags: { [sign.id]: 1 } });
const copy = task("Write launch copy", { type: "Work", note: NOTE.site, phase: "Build", owner: "Sam", durationDays: 4, deps: [audit.id], percent: 25 });
const qa = task("Accessibility and QA pass", { type: "Work", note: NOTE.site, phase: "Launch", owner: "Ravi", durationDays: 3, deps: [build.id, copy.id], due: iso(12) });
const launch = task("Launch", { type: "Work", note: NOTE.site, phase: "Launch", milestone: true, deps: [qa.id] });

// rows arranged by hand, as you would with the drag handles: phase by phase
[brief, audit, wires, sign, copy, build, qa, launch].forEach((t, i) => ((t as { order: number }).order = i));

// ---- everything else ----
const samples = task("Pick benchtop and splashback samples", { type: "Home", note: NOTE.kitchen, due: iso(2), images: ["samples-1.svg", "samples-2.svg"],
	comments: [comment("Showroom has the oak and the terrazzo in stock — bring the cabinet door.", 1)] });
const tasks = [
	brief, audit, wires, sign, build, copy, qa, launch,
	samples,

	task("Get second quote from electrician", { type: "Home", note: NOTE.kitchen, status: "hold",
		comments: [comment("Waiting on them to come back after the long weekend.", 4)] }),
	task("Book Lisbon accommodation", { type: "Personal", note: NOTE.trip, due: iso(5) }),
	task("Renew passport", { type: "Personal", due: iso(-1) }),
	task("Sort out the garage shelving", { type: "Home", quiet: true }),
	task("Cancel unused streaming subscription", { type: "Personal" }),
	task("Return library books", { type: "Personal", status: "closed", closedAt: ago(1),
		comments: [comment("Dropped them off on the way to the shops.", 1, true)] }),
];

const files: Record<string, string> = {
	[NOTE.kitchen]: "", [NOTE.site]: "", [NOTE.trip]: "",
	"samples-1.svg": photo("#c9a27a", "#6b4a2f"),
	"samples-2.svg": photo("#d9dde3", "#8b929c"),
};

async function plugin(view: "tasks" | "today" | "timeline") {
	const app = fakeApp(files);
	const p = new FocusHub(app as never, { id: "focus-hub", dir: ".obsidian/plugins/focus-hub", version: "0.3.1" } as never) as any;
	const data = {
		version: 2,
		types: ["Work", "Home", "Personal"],
		notes: Object.values(NOTE),
		tasks,
		filter: { kind: view === "tasks" ? "all" : "all", value: "", status: "open" },
		settings: { closeOutPrompt: true, mirrorToNote: true, noteHeading: "Tasks", mirrorComments: true, workingDaysOnly: true,
			holidays: [], staleDays: 14, focusLimit: 5, openTodayOnStartup: false, briefEnabled: false, briefKeychainId: "",
			briefPausedUntil: null, meetingsNotePath: "" },
		deleted: {},
		today: {
			date: iso(0), focus: [wires.id, samples.id], carried: [wires.id], reviewed: null,
			suggestion: {
				date: iso(0), model: "claude-opus-5", source: "Obsidian", generatedAt: Date.now(),
				summary: "A design-heavy day: the wireframes gate the sign-off, and the benchtop samples are due the day after tomorrow.",
				items: [
					{ id: wires.id, reason: "Underway and 60% done; blocks design sign-off and the build." },
					{ id: samples.id, reason: "Due in two days; the showroom has both samples in stock." },
					{ id: copy.id, reason: "Only 25% done and needed before the QA pass." },
				],
			},
		},
	};
	p.setStored(data);
	await p.reload();
	p.timelineNotes = new Set([NOTE.site]);
	return p;
}

export async function render(scene: string) {
	const host = document.getElementById("app")!;
	if (scene === "tasks") {
		const p = await plugin("tasks");
		const view = new TaskHubView({ app: p.app, host } as never, p);
		// let the plugin find the view, so clicks and edits redraw it as they would in Obsidian
		p.app.workspace.getLeavesOfType = () => [{ view }];
		await view.onOpen();
	} else if (scene === "today") {
		const p = await plugin("today");
		const view = new TodayView({ app: p.app, host } as never, p);
		// let the plugin find the view, so clicks and edits redraw it as they would in Obsidian
		p.app.workspace.getLeavesOfType = () => [{ view }];
		await view.onOpen();
	} else if (scene === "timeline") {
		const p = await plugin("timeline");
		const page = host.createDiv({ cls: "markdown-preview-view" }).createDiv({ cls: "markdown-preview-sizer" });
		page.createEl("h1", { text: "Website relaunch — Timeline" });
		renderGanttBlock(p, page.createDiv(), "zoom: day\ncritical: true\ngroup: phase", NOTE.site);
	}
	document.body.dataset.ready = "1";
}

(window as any).renderScene = render;
