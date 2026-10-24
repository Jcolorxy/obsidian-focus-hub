import { setIcon } from "obsidian";
import { Calendar, Scheduled, workingDaysBetween } from "./schedule";
import { Task, schedulingGap } from "./types";

/** Share of tasks closed — the only fair measure when most tasks have no duration. */
export function countProgress(tasks: Task[]) {
	const total = tasks.length;
	const closed = tasks.filter((t) => t.status === "closed").length;
	return { total, closed, pct: total ? Math.round((closed / total) * 100) : 0 };
}

/** How far through its planned working days a bar is by `today`, 0–1. */
function elapsedFraction(r: Scheduled, today: string, cal: Calendar): number {
	if (today < r.start) return 0;
	if (today >= r.end) return 1;
	return Math.min(1, workingDaysBetween(r.start, today, cal) / Math.max(1, r.durationDays));
}

/**
 * Progress across a plan, weighted by working days so a month-long task at half
 * counts for more than a finished one-day task. Milestones carry no duration and
 * tasks with nothing anchoring them in time (their bar is a guess on today) are
 * left out of both figures rather than skewing them.
 */
export function scheduleProgress(rows: Scheduled[], today: string, cal: Calendar, progressOf: (t: Task) => number) {
	let weight = 0;
	let done = 0;
	let due = 0;
	let skipped = 0;
	for (const r of rows) {
		if (r.task.milestone) continue;
		if (schedulingGap(r.task) === "anchor") { skipped++; continue; }
		const w = Math.max(1, r.durationDays);
		weight += w;
		done += w * (progressOf(r.task) / 100);
		due += w * elapsedFraction(r, today, cal);
	}
	const actual = weight ? Math.round((done / weight) * 100) : 0;
	const expected = weight ? Math.round((due / weight) * 100) : 0;
	return { actual, expected, delta: actual - expected, skipped, counted: weight > 0 };
}

export interface MeterSpec {
	label: string;
	pct: number;
	detail: string;
	/** Where the plan says you should be by today, drawn as a tick on the track. */
	expected?: number;
	delta?: number;
}

/** Stat tile + meter: the number, a same-hue track, and an ahead/behind note. */
export function renderMeter(parent: HTMLElement, spec: MeterSpec): HTMLElement {
	const tile = parent.createDiv({ cls: "th-progress" });
	const head = tile.createDiv({ cls: "th-progress-head" });
	head.createSpan({ cls: "th-progress-label", text: spec.label });
	head.createSpan({ cls: "th-progress-value", text: `${spec.pct}%` });
	head.createSpan({ cls: "th-progress-detail", text: spec.detail });

	if (spec.delta !== undefined && spec.expected !== undefined) {
		// status colour only ever arrives with an icon and words, never on its own
		const state = Math.abs(spec.delta) <= 3 ? "on-track" : spec.delta < 0 ? "behind" : "ahead";
		const note = head.createSpan({ cls: `th-progress-delta is-${state}` });
		setIcon(note.createSpan({ cls: "th-progress-delta-icon" }), state === "behind" ? "alert-triangle" : "check-circle");
		note.createSpan({
			text: state === "on-track" ? "On track" : state === "behind" ? `${-spec.delta}% behind plan` : `${spec.delta}% ahead of plan`,
		});
		note.title = `Plan says ${spec.expected}% by today`;
	}

	const track = tile.createDiv({ cls: "th-progress-track", attr: { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(spec.pct), "aria-label": `${spec.label} ${spec.pct}%` } });
	track.createDiv({ cls: "th-progress-fill" }).style.width = `${Math.max(0, Math.min(100, spec.pct))}%`;
	if (spec.expected !== undefined) {
		const tick = track.createDiv({ cls: "th-progress-expected" });
		tick.style.left = `${Math.max(0, Math.min(100, spec.expected))}%`;
		tick.title = `Planned by today: ${spec.expected}%`;
	}
	return tile;
}
