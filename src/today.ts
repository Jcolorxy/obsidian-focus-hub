import { Calendar, Scheduled, addDays, computeSchedule } from "./schedule";
import { Task, TodayState, schedulingGap } from "./types";

/**
 * Start a new day: focus tasks still open come forward (marked as carried), closed
 * ones drop away, and yesterday's suggestion is cleared. Same day → unchanged.
 */
export function rollover(state: TodayState, tasks: Task[], today: string): TodayState {
	if (state.date === today) return state;
	const open = new Set(tasks.filter((t) => t.status !== "closed").map((t) => t.id));
	const carried = state.focus.filter((id) => open.has(id));
	return {
		date: today,
		focus: carried,
		carried,
		reviewed: state.reviewed,
		suggestion: state.suggestion?.date === today ? state.suggestion : null,
	};
}

/** Tasks a timeline says should be underway today — critical path first. */
export function onThePlan(rows: Scheduled[], today: string): Scheduled[] {
	return rows
		.filter((r) => r.task.status !== "closed" && !r.task.milestone && r.start <= today && r.end >= today && schedulingGap(r.task) !== "anchor")
		.sort((a, b) => Number(b.critical) - Number(a.critical) || a.end.localeCompare(b.end));
}

export interface UpcomingEvent {
	date: string;
	kind: "due" | "start" | "milestone";
	task: Task;
}

/** Due dates, planned starts and milestones over the next `days` days (today excluded). */
export function comingUp(tasks: Task[], rows: Scheduled[], today: string, days = 7): UpcomingEvent[] {
	const until = addDays(today, days);
	const within = (d: string) => d > today && d <= until;
	const events: UpcomingEvent[] = [];
	for (const t of tasks) {
		if (t.status === "closed") continue;
		if (t.due && within(t.due) && !t.milestone) events.push({ date: t.due, kind: "due", task: t });
	}
	for (const r of rows) {
		if (r.task.status === "closed") continue;
		if (r.task.milestone && within(r.start)) events.push({ date: r.start, kind: "milestone", task: r.task });
		// only a start the plan actually sets: one inferred from a due date just repeats the "due" entry
		else if (!r.task.milestone && within(r.start) && (r.task.start || r.task.deps?.length)) events.push({ date: r.start, kind: "start", task: r.task });
	}
	return events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

export interface Waiting {
	task: Task;
	/** Unfinished prerequisites it is waiting for. */
	blockedBy: Task[];
	onHold: boolean;
}

/** Open tasks that cannot move: unfinished prerequisites, or deliberately on hold. */
export function waitingOn(tasks: Task[]): Waiting[] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const out: Waiting[] = [];
	for (const t of tasks) {
		if (t.status === "closed") continue;
		const blockedBy = (t.deps ?? []).map((d) => byId.get(d)).filter((d): d is Task => !!d && d.status !== "closed");
		if (blockedBy.length || t.status === "hold") out.push({ task: t, blockedBy, onHold: t.status === "hold" });
	}
	return out.sort((a, b) => Number(a.onHold) - Number(b.onHold) || a.task.title.localeCompare(b.task.title));
}

/** Open tasks nobody has touched in `days` days, oldest first. */
export function stale(tasks: Task[], now: number, days: number): Task[] {
	const cutoff = now - days * 86400000;
	return tasks
		.filter((t) => t.status !== "closed" && (t.updated ?? t.created) < cutoff)
		.sort((a, b) => (a.updated ?? a.created) - (b.updated ?? b.created));
}

/** Everything the Today view needs, computed once per render. */
export function todayModel(tasks: Task[], today: string, cal: Calendar, staleDays: number) {
	const planned = tasks.filter((t) => t.start || t.due || t.durationDays || t.milestone || t.deps?.length);
	const rows = computeSchedule(planned, today, cal);
	return {
		rows,
		plan: onThePlan(rows, today),
		upcoming: comingUp(tasks, rows, today),
		waiting: waitingOn(tasks),
		stale: stale(tasks, Date.now(), staleDays),
	};
}
