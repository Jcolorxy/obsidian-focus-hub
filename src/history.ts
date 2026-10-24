import type { Task } from "./types";

import { LOCAL_TIMEZONE } from "./zone";

export const HISTORY_TIMEZONE = LOCAL_TIMEZONE;
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: HISTORY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

/** No fallback to due, updated, created or comment dates: these are not completion dates. */
export function completionDay(task: Task): string | null {
	if (typeof task.closedAt !== "number" || !Number.isFinite(task.closedAt)) return null;
	const date = new Date(task.closedAt);
	if (!Number.isFinite(date.getTime())) return null;
	const parts = dayFormatter.formatToParts(date);
	const part = (key: string) => parts.find(p => p.type === key)!.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export interface HistoryFilters {
	year?: string;
	from?: string;
	to?: string;
	/** undefined = all notes; null = unlinked. */
	note?: string | null;
}

export function historyModel(tasks: readonly Task[], filters: HistoryFilters = {}) {
	const closed = tasks.filter(t => t.status === "closed");
	const groups = new Map<string, Task[]>();
	const undated: Task[] = [];
	const years = [...new Set(closed.map(completionDay).filter((d): d is string => d !== null).map(d => d.slice(0, 4)))].sort().reverse();
	const notes = [...new Set(closed.map(t => t.note).filter((n): n is string => !!n))].sort();
	const invalidRange = !!(filters.from && filters.to && filters.from > filters.to);
	for (const task of closed) {
		if (filters.note !== undefined && (task.note ?? null) !== filters.note) continue;
		const day = completionDay(task);
		// Keep unknown dates visible, explicitly outside the dated results.
		if (!day) { undated.push(task); continue; }
		if (invalidRange || (filters.year && !day.startsWith(filters.year + "-")) ||
			(filters.from && day < filters.from) || (filters.to && day > filters.to)) continue;
		const month = day.slice(0, 7);
		if (!groups.has(month)) groups.set(month, []);
		groups.get(month)!.push(task);
	}
	return {
		total: closed.length, years, notes, invalidRange,
		months: [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([month, tasks]) => ({
			month, tasks: tasks.sort((a, b) => b.closedAt! - a.closedAt! || a.id.localeCompare(b.id)),
		})),
		undated: undated.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
	};
}
