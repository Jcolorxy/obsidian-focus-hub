import { Status, Task, todayISO } from "./types";

export interface Scheduled {
	task: Task;
	/** Inclusive ISO dates of the bar. A milestone has start === end. */
	start: string;
	end: string;
	/** Working days the bar covers (0 for a milestone). */
	durationDays: number;
	/** Prerequisite ids that resolved to a real task. */
	deps: string[];
	/** Prerequisites pushed the start later than the date set on the task. */
	pushed: boolean;
	/** The computed finish falls after the task's own due date. */
	lateVsDue: boolean;
	/** Task sits in a dependency cycle; its prerequisites were ignored. */
	cyclic: boolean;
	/** Working days this task can slip before the project end moves. */
	float: number;
	/** On the chain that determines the project end date. */
	critical: boolean;
	/** Working days later than the agreed baseline finish (negative = ahead). */
	baselineDrift: number | null;
}

/** Which days count as working days. */
export interface Calendar {
	workingDaysOnly: boolean;
	holidays: Set<string>;
}

export const ALL_DAYS: Calendar = { workingDaysOnly: false, holidays: new Set() };

const MS_DAY = 86400000;

export function parseISO(iso: string): Date {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toISO(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, n: number): string {
	const d = parseISO(iso);
	d.setDate(d.getDate() + n);
	return toISO(d);
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: string, b: string): number {
	return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / MS_DAY);
}

export const maxISO = (a: string, b: string) => (a > b ? a : b);

export function isWorkday(iso: string, cal: Calendar): boolean {
	if (!cal.workingDaysOnly) return true;
	const day = parseISO(iso).getDay();
	return day !== 0 && day !== 6 && !cal.holidays.has(iso);
}

/** The given day, or the next working day when it falls on a weekend or holiday. */
export function nextWorkday(iso: string, cal: Calendar): string {
	let d = iso;
	for (let guard = 0; guard < 400 && !isWorkday(d, cal); guard++) d = addDays(d, 1);
	return d;
}

export function prevWorkday(iso: string, cal: Calendar): string {
	let d = iso;
	for (let guard = 0; guard < 400 && !isWorkday(d, cal); guard++) d = addDays(d, -1);
	return d;
}

/** Move `n` working days forward (n may be 0, which just lands on a working day). */
export function addWorkingDays(iso: string, n: number, cal: Calendar): string {
	let d = nextWorkday(iso, cal);
	for (let i = 0; i < n; i++) d = nextWorkday(addDays(d, 1), cal);
	return d;
}

export function subWorkingDays(iso: string, n: number, cal: Calendar): string {
	let d = prevWorkday(iso, cal);
	for (let i = 0; i < n; i++) d = prevWorkday(addDays(d, -1), cal);
	return d;
}

/** Working days from `a` to `b` inclusive; 0 when b is before a. */
export function workingDaysBetween(a: string, b: string, cal: Calendar): number {
	if (b < a) return 0;
	let count = 0;
	for (let d = a; d <= b; d = addDays(d, 1)) if (isWorkday(d, cal)) count++;
	return count;
}

/** Last day of a task starting on `start` and lasting `duration` working days. */
export function spanEnd(start: string, duration: number, cal: Calendar): string {
	return addWorkingDays(start, Math.max(0, duration - 1), cal);
}

/**
 * Turn tasks into dated bars.
 *
 * A task starts on its own start date when it has one, otherwise after its last
 * prerequisite finishes (plus that link's lag), otherwise so that it finishes on its
 * due date, and failing all of that, today. Prerequisites always win over an explicit
 * start that would be too early — the bar is then flagged as `pushed` rather than
 * silently overlapping. Cycles are broken by ignoring the offending link.
 *
 * A backward pass then gives each task its float, and zero-float tasks form the
 * critical path — the chain that decides when the project finishes.
 */
export function computeSchedule(tasks: Task[], today: string = todayISO(), cal: Calendar = ALL_DAYS): Scheduled[] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const done = new Map<string, Scheduled>();
	const visiting = new Set<string>();

	const durationOf = (task: Task): number => {
		if (task.milestone) return 0;
		if (task.durationDays) return Math.max(1, Math.round(task.durationDays));
		if (task.start && task.due && task.due >= task.start) return workingDaysBetween(task.start, task.due, cal);
		return 1;
	};

	const resolve = (task: Task): Scheduled => {
		const cached = done.get(task.id);
		if (cached) return cached;

		visiting.add(task.id);
		let cyclic = false;
		let afterDeps: string | null = null;
		const deps: string[] = [];
		for (const id of task.deps ?? []) {
			const dep = byId.get(id);
			if (!dep || dep.id === task.id) continue;
			if (visiting.has(id)) { cyclic = true; continue; }
			deps.push(id);
			const s = resolve(dep);
			const lag = Math.max(0, Math.round(task.depLags?.[id] ?? 0));
			const ready = addWorkingDays(s.end, 1 + lag, cal);
			afterDeps = afterDeps === null ? ready : maxISO(afterDeps, ready);
		}
		visiting.delete(task.id);

		const duration = durationOf(task);

		let start: string;
		let pushed = false;
		if (task.start) {
			start = nextWorkday(task.start, cal);
			if (afterDeps && afterDeps > start) { start = afterDeps; pushed = true; }
		} else if (afterDeps) {
			start = afterDeps;
		} else if (task.due) {
			start = task.milestone ? nextWorkday(task.due, cal) : subWorkingDays(task.due, Math.max(0, duration - 1), cal);
		} else {
			start = nextWorkday(today, cal);
		}

		let end = task.milestone ? start : spanEnd(start, duration, cal);
		// an explicit start + due pair defines the bar outright
		if (task.start && task.due && !pushed && !task.milestone && !task.durationDays && task.due >= start) end = task.due;
		if (end < start) end = start;

		const scheduled: Scheduled = {
			task, start, end,
			durationDays: task.milestone ? 0 : workingDaysBetween(start, end, cal),
			deps, pushed, cyclic,
			lateVsDue: !!task.due && end > task.due,
			float: 0,
			critical: false,
			baselineDrift: task.baseline ? workingDaysBetween(task.baseline.end, end, cal) - 1 : null,
		};
		done.set(task.id, scheduled);
		return scheduled;
	};

	const rows = tasks.map(resolve);
	addFloat(rows, cal);
	return rows.sort(byDate);
}

const byDate = (a: Scheduled, b: Scheduled) =>
	a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.task.title.localeCompare(b.task.title);

/** Backward pass: latest each task could finish without delaying the project. */
function addFloat(rows: Scheduled[], cal: Calendar) {
	if (!rows.length) return;
	const byId = new Map(rows.map((r) => [r.task.id, r]));
	const successors = new Map<string, { id: string; lag: number }[]>();
	for (const r of rows) {
		for (const depId of r.deps) {
			const list = successors.get(depId) ?? [];
			list.push({ id: r.task.id, lag: Math.max(0, Math.round(r.task.depLags?.[depId] ?? 0)) });
			successors.set(depId, list);
		}
	}
	const projectEnd = rows.reduce((acc, r) => maxISO(acc, r.end), rows[0].end);

	const lateFinishCache = new Map<string, string>();
	const walking = new Set<string>();
	const lateFinish = (r: Scheduled): string => {
		const hit = lateFinishCache.get(r.task.id);
		if (hit) return hit;
		if (walking.has(r.task.id)) return projectEnd; // broken cycle
		walking.add(r.task.id);
		const succs = successors.get(r.task.id) ?? [];
		let value = projectEnd;
		for (const { id, lag } of succs) {
			const succ = byId.get(id);
			if (!succ) continue;
			const succLateStart = subWorkingDays(lateFinish(succ), Math.max(0, succ.durationDays - (succ.task.milestone ? 0 : 1)), cal);
			const limit = subWorkingDays(succLateStart, 1 + lag, cal);
			if (limit < value) value = limit;
		}
		walking.delete(r.task.id);
		lateFinishCache.set(r.task.id, value);
		return value;
	};

	for (const r of rows) {
		const lf = lateFinish(r);
		r.float = Math.max(0, workingDaysBetween(r.end, lf, cal) - 1);
		r.critical = r.float === 0;
	}
}

/** Rows in the order the user arranged them; anything unplaced keeps its date order. */
export function applyManualOrder(rows: Scheduled[]): Scheduled[] {
	const placed = rows.filter((r) => r.task.order !== null && r.task.order !== undefined);
	if (!placed.length) return rows;
	return [...rows].sort((a, b) => {
		const ao = a.task.order ?? Number.MAX_SAFE_INTEGER;
		const bo = b.task.order ?? Number.MAX_SAFE_INTEGER;
		return ao - bo || byDate(a, b);
	});
}

/** Span covering every bar, padded so the chart does not start hard against the edge. */
export function chartRange(rows: Scheduled[], today: string = todayISO(), padDays = 2): { from: string; to: string } {
	if (!rows.length) return { from: addDays(today, -padDays), to: addDays(today, 14) };
	let from = rows[0].start;
	let to = rows[0].end;
	for (const r of rows) {
		if (r.start < from) from = r.start;
		if (r.end > to) to = r.end;
		if (r.task.baseline) {
			if (r.task.baseline.start < from) from = r.task.baseline.start;
			if (r.task.baseline.end > to) to = r.task.baseline.end;
		}
	}
	if (today < from) from = today;
	if (today > to) to = today;
	return { from: addDays(from, -padDays), to: addDays(to, padDays) };
}

export const STATUS_CLASS: Record<Status, string> = { open: "open", hold: "hold", closed: "closed" };
