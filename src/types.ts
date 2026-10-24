export interface Comment {
	id: string;
	text: string;
	time: number;
	/** True when this comment was entered as the close-out note on completion. */
	closeOut: boolean;
}

export type Status = "open" | "hold" | "closed";
export const STATUSES: { value: Status; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "hold", label: "On Hold" },
	{ value: "closed", label: "Closed" },
];

export interface Task {
	id: string;
	title: string;
	status: Status;
	/** Category type name, or null when uncategorised. */
	type: string | null;
	/** Vault path of the linked note page, or null. */
	note: string | null;
	/** Vault paths of attached images. */
	images: string[];
	comments: Comment[];
	/** Due date as YYYY-MM-DD, or null. */
	due: string | null;
	/** Planned start as YYYY-MM-DD; when unset it is derived from prerequisites. */
	start: string | null;
	/** Planned length in days; when unset it is derived from start/due, else 1 day. */
	durationDays: number | null;
	/** Ids of tasks that must finish before this one can start. */
	deps: string[];
	/** Manual row position on a timeline; null means "not placed by hand". */
	order: number | null;
	/** Extra waiting days after each prerequisite finishes, keyed by prerequisite id. */
	depLags: Record<string, number>;
	/** A dated marker with no duration (an approval, a delivery, a gate). */
	milestone: boolean;
	/** Progress 0–100; closed tasks count as 100 regardless. */
	percent: number | null;
	/** Phase / group this task belongs to on the timeline. */
	phase: string | null;
	/** Who is doing it. */
	owner: string | null;
	/** Snapshot of an agreed plan, to compare the current dates against. */
	baseline: { start: string; end: string } | null;
	/** Whether the details area (images + comments) is collapsed. */
	collapsed: boolean;
	created: number;
	/** Last modification (any field); used to pick a winner when merging Sync conflicts. */
	updated: number;
	/** When the task was last moved to Closed. */
	closedAt: number | null;
}

export type FilterKind = "all" | "uncategorised" | "type" | "note";

export interface Filter {
	kind: FilterKind;
	value: string;
	status: Status | "all";
}

export interface HubSettings {
	/** Schedule across working days only, skipping weekends and holidays. */
	workingDaysOnly: boolean;
	/** Non-working dates as YYYY-MM-DD. */
	holidays: string[];
	/** An open task untouched for this many days is listed as stale. */
	staleDays: number;
	/** Most tasks you can put in the day's focus. */
	focusLimit: number;
	/** Open the Today view when Obsidian starts. */
	openTodayOnStartup: boolean;
	/** Note holding a calendar snapshot for the Today view's meetings card; empty hides the card. */
	meetingsNotePath: string;
	/** Ask Claude each morning for a suggested focus. */
	briefEnabled: boolean;
	/** Name of the Keychain entry holding this device's Anthropic API key (the key itself is never stored here). */
	briefKeychainId: string;
	/** No suggestions before this date (YYYY-MM-DD) — leave, holidays. */
	briefPausedUntil: string | null;
	/** Ask for a close-out comment when a task is marked complete. */
	closeOutPrompt: boolean;
	/** Mirror linked tasks as checkbox lines inside their note. */
	mirrorToNote: boolean;
	/** Heading (without #) the mirrored lines go under; empty = end of note. */
	noteHeading: string;
	/** Also mirror each task's comments as bullets under its line in the note. */
	mirrorComments: boolean;
}

/** Claude's proposed focus for a day, written into data.json by the morning job. */
export interface FocusSuggestion {
	date: string;
	items: { id: string; reason: string }[];
	summary: string;
	generatedAt: number;
	model: string;
	/** "scheduled job" (the 06:00 script) or "Obsidian" (whichever device opened first). */
	source?: string;
}

/** The Today view's state: the day's chosen focus and what carried over. */
export interface TodayState {
	/** The day this focus list belongs to (YYYY-MM-DD). */
	date: string;
	/** Task ids, in the order you want to work them. */
	focus: string[];
	/** Focus tasks brought forward unfinished from an earlier day. */
	carried: string[];
	/** Day the end-of-day review was last done. */
	reviewed: string | null;
	suggestion: FocusSuggestion | null;
}

export const SCHEMA_VERSION = 2;

export interface HubData {
	version: number;
	types: string[];
	notes: string[];
	tasks: Task[];
	filter: Filter;
	settings: HubSettings;
	/** Tombstones: task id -> deletion time. Stops a Sync merge resurrecting deleted tasks. */
	deleted: Record<string, number>;
	today: TodayState;
}

export const DEFAULT_DATA: HubData = {
	version: SCHEMA_VERSION,
	types: ["Personal", "Work"],
	notes: [],
	tasks: [],
	filter: { kind: "all", value: "", status: "open" },
	settings: {
		closeOutPrompt: true, mirrorToNote: true, noteHeading: "Tasks", mirrorComments: true,
		workingDaysOnly: true, holidays: [],
		staleDays: 14, focusLimit: 5, openTodayOnStartup: false,
		briefEnabled: true, briefKeychainId: "", briefPausedUntil: null, meetingsNotePath: "",
	},
	deleted: {},
	today: { date: "", focus: [], carried: [], reviewed: null, suggestion: null },
};

export function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

export function isImagePath(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EXTS.includes(ext);
}

export function basename(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.md$/, "");
}

export function todayISO(offsetDays = 0): string {
	const d = new Date();
	d.setDate(d.getDate() + offsetDays);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Days from today to the given ISO date (negative = overdue). */
export function daysUntil(iso: string): number {
	const [y, m, d] = iso.split("-").map(Number);
	const target = new Date(y, m - 1, d).getTime();
	const now = new Date(); now.setHours(0, 0, 0, 0);
	return Math.round((target - now.getTime()) / 86400000);
}

export function dueLabel(iso: string): string {
	const n = daysUntil(iso);
	if (n === 0) return "Today";
	if (n === 1) return "Tomorrow";
	if (n === -1) return "Yesterday";
	if (n < 0) return `${-n}d overdue`;
	if (n < 7) return new Date(iso + "T00:00").toLocaleDateString(undefined, { weekday: "short" });
	return formatDate(iso);
}

/**
 * Dates shown to the user read dd/mm/yy. Dates written into notes stay ISO — the
 * ✅/📅 markers are parsed back by this plugin and by the Tasks plugin.
 */
export function formatDate(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	if (!m) return iso;
	return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

export function formatDateTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What stops a task being properly placed on a timeline.
 *  - "anchor": nothing fixes it in time (no start, no due date, no prerequisite), so
 *    its bar simply lands on today.
 *  - "length": it is anchored but has no duration, so the bar is a one-day guess.
 * Closed tasks are never flagged; there is nothing left to plan.
 */
export function schedulingGap(t: Task): "anchor" | "length" | null {
	if (t.status === "closed") return null;
	const anchored = !!(t.start || t.due || t.deps?.length);
	if (!anchored) return "anchor";
	if (t.milestone) return null;
	return t.durationDays || (t.start && t.due) ? null : "length";
}

export const GAP_LABEL: Record<"anchor" | "length", string> = {
	anchor: "no start date",
	length: "no duration",
};

/** Work is anything typed "Work…" or filed under the vault's Work folder. */
export function isWorkTask(t: Pick<Task, "type" | "note">): boolean {
	return /^work\b/i.test(t.type ?? "") || (t.note ?? "").startsWith("Work/");
}

/** Saturday or Sunday — the Today view and the morning suggestion drop work. */
export function isWeekend(iso: string): boolean {
	const day = new Date(iso + "T00:00").getDay();
	return day === 0 || day === 6;
}

/** The tasks that belong on a given day: everything on weekdays, no work at weekends. */
export function tasksForDay<T extends Pick<Task, "type" | "note">>(tasks: T[], iso: string): T[] {
	return isWeekend(iso) ? tasks.filter((t) => !isWorkTask(t)) : tasks;
}
