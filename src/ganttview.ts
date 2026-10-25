import { MarkdownRenderChild, Menu, Notice, setIcon } from "obsidian";
import type TaskHubPlugin from "./main";
import { GAP_LABEL, STATUSES, Status, Task, basename, formatDate, schedulingGap, todayISO } from "./types";
import {
	Calendar, Scheduled, addDays, addWorkingDays, applyManualOrder, chartRange, computeSchedule, diffDays,
	parseISO,
} from "./schedule";
import { ScheduleModal } from "./modals";
import { ganttToSvg, svgToPng } from "./ganttsvg";
import { renderMeter, scheduleProgress } from "./progress";

export type Zoom = "day" | "week" | "month" | "fit";
const PX_PER_DAY: Record<Exclude<Zoom, "fit">, number> = { day: 26, week: 11, month: 4 };
/** Width of the label column, mirroring --th-gantt-side in the stylesheet. */
const SIDE_W = 260;

export type GroupBy = "none" | "phase" | "owner";

export interface GanttOptions {
	type: string | null;
	note: string | null;
	/** "active" = open + on hold. */
	status: Status | "all" | "active";
	zoom: Zoom;
	/** Include tasks with no dates and no prerequisites. */
	unscheduled: boolean;
	/** "manual" keeps the order you arranged; "start" always sorts by date. */
	sort: "manual" | "start";
	/** Rows banded by phase or by owner, each with a rolled-up summary bar. */
	group: GroupBy;
	/** Only show what overlaps this window (ISO dates, or relative like "+8w"). */
	from?: string;
	to?: string;
	/** Draw the agreed baseline under each bar. */
	baseline: boolean;
	/** Mark the chain that decides the finish date. */
	critical: boolean;
	/** Lane width to fit into, for charts that are not on screen (printing). */
	fitWidth?: number;
	/** "full" widens the chart past the note's readable line length; "note" keeps it in. */
	width: "full" | "note";
	title?: string;
	interactive: boolean;
	/** Collapsed group keys (held in memory, not written to the note). */
	collapsedGroups?: Set<string>;
}

export const DEFAULT_OPTIONS: GanttOptions = {
	type: null, note: null, status: "all", zoom: "day", unscheduled: false, sort: "manual",
	group: "phase", baseline: true, critical: false, width: "full", interactive: true,
};

/** A task earns a place on the chart once it has any planning information. */
export const isPlanned = (t: Task) =>
	!!(t.start || t.due || t.durationDays || t.milestone || (t.deps && t.deps.length));

export function selectTasks(all: Task[], o: GanttOptions): Task[] {
	return all.filter((t) => {
		if (o.type && t.type !== o.type) return false;
		if (o.note && t.note !== o.note) return false;
		if (o.status === "active" ? t.status === "closed" : o.status !== "all" && t.status !== o.status) return false;
		if (!o.unscheduled && !isPlanned(t)) return false;
		return true;
	});
}

const fmtDay = formatDate;

/** "2026-10-05", or an offset from today like "+8w" / "-2w" / "+30d" / "+3m". */
export function resolveDate(value: string | undefined, today: string): string | null {
	if (!value) return null;
	const v = value.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
	const m = /^([+-])\s*(\d+)\s*([dwmy])$/i.exec(v);
	if (!m) return null;
	const sign = m[1] === "-" ? -1 : 1;
	const n = Number(m[2]) * sign;
	const d = parseISO(today);
	const unit = m[3].toLowerCase();
	if (unit === "d") d.setDate(d.getDate() + n);
	else if (unit === "w") d.setDate(d.getDate() + n * 7);
	else if (unit === "m") d.setMonth(d.getMonth() + n);
	else d.setFullYear(d.getFullYear() + n);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Progress shown on a bar: an explicit percentage, or 100 once the task is closed. */
export const progressOf = (t: Task) => (t.status === "closed" ? 100 : Math.max(0, Math.min(100, t.percent ?? 0)));

export interface Band {
	key: string;
	label: string;
	rows: Scheduled[];
}

/** Everything a chart needs: the rows in display order and the span they cover. */
export function prepareRows(plugin: TaskHubPlugin, o: GanttOptions) {
	const today = todayISO();
	const cal = plugin.calendar;
	const tasks = selectTasks(plugin.data.tasks, o);
	const needed = new Set(tasks.map((t) => t.id));
	for (const t of tasks) for (const d of t.deps ?? []) needed.add(d);
	const all = computeSchedule(plugin.data.tasks.filter((t) => needed.has(t.id)), today, cal);
	let rows = all.filter((r) => tasks.includes(r.task));
	if (o.sort === "manual") rows = applyManualOrder(rows);
	const windowFrom = resolveDate(o.from, today);
	const windowTo = resolveDate(o.to, today);
	if (windowFrom) rows = rows.filter((r) => r.end >= windowFrom);
	if (windowTo) rows = rows.filter((r) => r.start <= windowTo);
	const range = chartRange(rows, today);
	return {
		rows, all, cal, today,
		from: windowFrom ?? range.from,
		to: windowTo ?? range.to,
	};
}

/** Split rows into bands by phase or owner, keeping the incoming row order. */
export function banded(rows: Scheduled[], group: GroupBy): Band[] {
	if (group === "none") return [{ key: "", label: "", rows }];
	const key = (r: Scheduled) => (group === "phase" ? r.task.phase : r.task.owner) ?? "";
	const bands: Band[] = [];
	const byKey = new Map<string, Band>();
	for (const r of rows) {
		const k = key(r);
		let band = byKey.get(k);
		if (!band) {
			band = { key: k, label: k || (group === "phase" ? "No phase" : "Unassigned"), rows: [] };
			byKey.set(k, band);
			bands.push(band);
		}
		band.rows.push(r);
	}
	// a single nameless band means nothing is grouped: skip the header entirely
	if (bands.length === 1 && bands[0].key === "") bands[0].label = "";
	return bands;
}

/** Renders the chart into `el`. Used by the ```gantt code block. */
/**
 * The plan's % complete tile. Progress is always over the whole plan: a status filter
 * that hides closed tasks would otherwise make the project look 0% done.
 */
function renderPlanMeter(plugin: TaskHubPlugin, parent: HTMLElement, o: GanttOptions) {
	const plan = prepareRows(plugin, { ...o, status: "all", unscheduled: true, from: undefined, to: undefined });
	const p = scheduleProgress(plan.rows, plan.today, plan.cal, progressOf);
	const closed = plan.rows.filter((r) => r.task.status === "closed").length;
	if (!plan.rows.length || !p.counted) return;
	renderMeter(parent, {
		label: "Complete",
		pct: p.actual,
		detail: `${closed} of ${plan.rows.length} tasks closed` + (p.skipped ? ` · ${p.skipped} unscheduled not counted` : ""),
		expected: p.expected,
		delta: p.delta,
	});
}

export function renderGantt(plugin: TaskHubPlugin, el: HTMLElement, o: GanttOptions, onChange?: () => void) {
	const root = el.createDiv({ cls: "th-gantt" });
	if (o.title) root.createDiv({ cls: "th-gantt-title", text: o.title });

	renderPlanMeter(plugin, root, o);

	const today = todayISO();
	const cal: Calendar = plugin.calendar;
	const tasks = selectTasks(plugin.data.tasks, o);
	// prerequisites are scheduled even when filtered out of view, so bars line up
	const needed = new Set(tasks.map((t) => t.id));
	for (const t of tasks) for (const d of t.deps ?? []) needed.add(d);
	const all = computeSchedule(plugin.data.tasks.filter((t) => needed.has(t.id)), today, cal);
	let rows = all.filter((r) => tasks.includes(r.task));
	if (o.sort === "manual") rows = applyManualOrder(rows);

	// date window
	const windowFrom = resolveDate(o.from, today);
	const windowTo = resolveDate(o.to, today);
	if (windowFrom) rows = rows.filter((r) => r.end >= windowFrom);
	if (windowTo) rows = rows.filter((r) => r.start <= windowTo);

	if (!rows.length) {
		root.createDiv({
			cls: "th-gantt-empty",
			text: plugin.data.tasks.length
				? "No scheduled tasks match. Give a task a start date, duration, due date or prerequisite — or tick “Include unscheduled”."
				: "No tasks yet.",
		});
		return;
	}

	const range = chartRange(rows, today);
	const from = windowFrom ?? range.from;
	const to = windowTo ?? range.to;
	const days = Math.max(1, diffDays(from, to) + 1);

	const scroll = root.createDiv({ cls: "th-gantt-scroll" });
	// "Fit" sizes a day so the whole span lands inside the pane — which is also what
	// makes the chart printable without being sliced across pages.
	const available = o.fitWidth ?? Math.max((scroll.clientWidth || 900) - SIDE_W - 24, 240);
	const px = o.zoom === "fit" ? Math.min(Math.max(available / days, 1.5), 40) : PX_PER_DAY[o.zoom];
	const width = days * px;
	const x = (iso: string) => diffDays(from, iso) * px;
	const clampX = (iso: string) => Math.max(0, Math.min(width, x(iso)));

	root.toggleClass("is-fit", o.zoom === "fit");
	const table = scroll.createDiv({ cls: "th-gantt-table" });
	// slack on the right so a label sitting past the end of its bar is not clipped
	table.style.setProperty("--th-gantt-width", `${width + 180}px`);
	// grid, weekend shading and the today marker live here, so their x positions are
	// measured from the start of the lanes rather than from the label column
	const underlay = table.createDiv({ cls: "th-gantt-underlay" });

	// ---- header: months, then day/week ticks ----
	const head = table.createDiv({ cls: "th-gantt-head" });
	head.createDiv({ cls: "th-gantt-side th-gantt-head-side", text: `${rows.length} task${rows.length === 1 ? "" : "s"}` });
	const axis = head.createDiv({ cls: "th-gantt-axis" });
	const months = axis.createDiv({ cls: "th-gantt-months" });
	const ticks = axis.createDiv({ cls: "th-gantt-ticks" });

	let cursor = from;
	while (cursor <= to) {
		const d = parseISO(cursor);
		const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
		const endISO = monthEnd > parseISO(to) ? to : `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, "0")}-${String(monthEnd.getDate()).padStart(2, "0")}`;
		const span = months.createDiv({ cls: "th-gantt-month" });
		span.style.left = `${x(cursor)}px`;
		span.style.width = `${(diffDays(cursor, endISO) + 1) * px}px`;
		span.setText(d.toLocaleDateString(undefined, { month: "short", year: "numeric" }));
		cursor = addDays(endISO, 1);
	}

	const dense = px >= 18;
	const weekly = px >= 6;
	for (let i = 0; i < days; i++) {
		const iso = addDays(from, i);
		const d = parseISO(iso);
		const nonWorking = !isWorkingDay(iso, cal);
		const monday = d.getDay() === 1;
		const first = d.getDate() === 1;
		if (dense || (weekly && monday) || first) {
			const tick = ticks.createDiv({ cls: "th-gantt-tick" });
			tick.style.left = `${x(iso)}px`;
			tick.style.width = `${px}px`;
			tick.toggleClass("is-weekend", nonWorking && dense);
			if (weekly) tick.setText(String(d.getDate()));
		}
		// recessive grid + non-working shading, drawn behind the bars
		if (first || (monday && weekly) || (dense && !nonWorking)) {
			const line = underlay.createDiv({ cls: "th-gantt-grid" });
			line.style.left = `${x(iso)}px`;
			line.toggleClass("is-strong", first);
		}
		if (nonWorking && dense) {
			const band = underlay.createDiv({ cls: "th-gantt-weekend" });
			band.style.left = `${x(iso)}px`;
			band.style.width = `${px}px`;
		}
	}

	// ---- rows ----
	const body = table.createDiv({ cls: "th-gantt-body" });
	const laneById = new Map<string, HTMLElement>();
	const tip = root.createDiv({ cls: "th-gantt-tip" });
	tip.hide();

	const showTip = (e: MouseEvent, text: string) => {
		tip.setText(text);
		tip.show();
		const box = root.getBoundingClientRect();
		tip.style.left = `${Math.min(e.clientX - box.left + 12, Math.max(0, box.width - 280))}px`;
		tip.style.top = `${e.clientY - box.top + 14}px`;
	};

	// --- manual row ordering ---
	let dragId: string | null = null;
	const clearDropHints = () =>
		body.findAll(".th-gantt-row").forEach((el) => { el.removeClass("is-drop-before"); el.removeClass("is-drop-after"); });
	const below = (e: MouseEvent, row: HTMLElement) => e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;

	const moveTask = async (id: string, targetId: string, after: boolean) => {
		const ids = rows.map((r) => r.task.id).filter((i) => i !== id);
		const at = ids.indexOf(targetId);
		if (at < 0) return;
		ids.splice(after ? at + 1 : at, 0, id);
		await plugin.reorderTasks(ids);
		onChange?.();
	};

	const nudge = async (id: string, delta: number) => {
		const ids = rows.map((r) => r.task.id);
		const at = ids.indexOf(id);
		const to2 = at + delta;
		if (at < 0 || to2 < 0 || to2 >= ids.length) return;
		ids.splice(to2, 0, ids.splice(at, 1)[0]);
		await plugin.reorderTasks(ids);
		onChange?.();
	};

	const collapsed = (o.collapsedGroups ??= new Set<string>());

	for (const band of banded(rows, o.group)) {
		if (band.label) renderBandHeader(band);
		if (band.label && collapsed.has(band.key)) continue;
		for (const r of band.rows) renderRow(r, !!band.label);
	}

	function renderBandHeader(band: Band) {
		const row = body.createDiv({ cls: "th-gantt-row is-group" });
		const side = row.createDiv({ cls: "th-gantt-side th-gantt-label is-group" });
		const caret = side.createSpan({ cls: "th-gantt-caret" });
		setIcon(caret, collapsed.has(band.key) ? "chevron-right" : "chevron-down");
		side.createSpan({ cls: "th-gantt-label-text", text: band.label });
		side.createSpan({ cls: "th-gantt-band-count", text: String(band.rows.length) });
		side.addEventListener("click", () => {
			if (collapsed.has(band.key)) collapsed.delete(band.key);
			else collapsed.add(band.key);
			onChange?.();
		});

		const lane = row.createDiv({ cls: "th-gantt-lane" });
		const start = band.rows.reduce((acc, r) => (r.start < acc ? r.start : acc), band.rows[0].start);
		const end = band.rows.reduce((acc, r) => (r.end > acc ? r.end : acc), band.rows[0].end);
		const bar = lane.createDiv({ cls: "th-gantt-summary" });
		bar.style.left = `${clampX(start)}px`;
		bar.style.width = `${Math.max(clampX(addDays(end, 1)) - clampX(start) - 2, 6)}px`;
		const pct = Math.round(band.rows.reduce((acc, r) => acc + progressOf(r.task), 0) / band.rows.length);
		const text = `${band.label}: ${fmtDay(start)} → ${fmtDay(end)} · ${pct}% complete`;
		bar.addEventListener("mousemove", (e) => showTip(e, text));
		bar.addEventListener("mouseleave", () => tip.hide());
		lane.createDiv({ cls: "th-gantt-summary-pct", text: `${pct}%` }).style.left =
			`${clampX(addDays(end, 1)) + 6}px`;
	}

	function renderRow(r: Scheduled, indented: boolean) {
		const row = body.createDiv({ cls: "th-gantt-row" });
		row.dataset.id = r.task.id;
		row.toggleClass("is-critical", o.critical && r.critical);
		const side = row.createDiv({ cls: "th-gantt-side th-gantt-label" });
		side.toggleClass("is-indented", indented);
		if (o.interactive && o.sort === "manual") {
			const grip = side.createSpan({ cls: "th-gantt-grip", attr: { "aria-label": "Drag to reorder" } });
			setIcon(grip, "grip-vertical");
			side.setAttr("draggable", "true");
		}
		const dot = side.createSpan({ cls: `th-gantt-dot is-${r.task.status}` });
		dot.setAttr("aria-hidden", "true");
		const labelText = side.createDiv({ cls: "th-gantt-label-text" });
		labelText.createSpan({ text: r.task.title });
		const gap = schedulingGap(r.task);
		const unscheduled = gap !== null;
		row.toggleClass("is-unscheduled", unscheduled);
		const meta = [
			r.task.owner,
			gap ? GAP_LABEL[gap] : "",
			!unscheduled && o.critical && r.critical ? "critical" : "",
			!unscheduled && !r.critical && r.float > 0 ? `${r.float}d float` : "",
		]
			.filter(Boolean)
			.join(" · ");
		if (meta) labelText.createDiv({ cls: "th-gantt-label-meta", text: meta });
		side.title = r.task.title;

		if (o.interactive && o.sort === "manual") {
			side.addEventListener("dragstart", (e) => {
				dragId = r.task.id;
				row.addClass("is-dragging");
				e.dataTransfer?.setData("text/plain", r.task.id);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			});
			side.addEventListener("dragend", () => { dragId = null; clearDropHints(); row.removeClass("is-dragging"); });
			row.addEventListener("dragover", (e) => {
				if (!dragId || dragId === r.task.id) return;
				e.preventDefault();
				clearDropHints();
				row.addClass(below(e, row) ? "is-drop-after" : "is-drop-before");
			});
			row.addEventListener("drop", (e) => {
				if (!dragId || dragId === r.task.id) return;
				e.preventDefault();
				void moveTask(dragId, r.task.id, below(e, row));
			});
		}

		const lane = row.createDiv({ cls: "th-gantt-lane" });
		laneById.set(r.task.id, lane);

		// baseline ghost, drawn under the live bar
		if (o.baseline && r.task.baseline) {
			const b = lane.createDiv({ cls: "th-gantt-baseline" });
			b.style.left = `${clampX(r.task.baseline.start)}px`;
			b.style.width = `${Math.max(clampX(addDays(r.task.baseline.end, 1)) - clampX(r.task.baseline.start) - 2, 4)}px`;
		}

		const barLeft = clampX(r.start);
		const barWidth = r.task.milestone ? 0 : Math.max(clampX(addDays(r.end, 1)) - barLeft - 2, 6);
		const pct = progressOf(r.task);
		const flagIcon = r.cyclic ? "refresh-cw" : "alert-triangle";

		let bar: HTMLElement;
		if (r.task.milestone) {
			bar = lane.createDiv({ cls: `th-gantt-milestone is-${r.task.status}` });
			bar.style.left = `${barLeft}px`;
			bar.toggleClass("is-late", r.lateVsDue);
			bar.toggleClass("is-critical", o.critical && r.critical);
		} else {
			bar = lane.createDiv({ cls: `th-gantt-bar is-${r.task.status}` });
			bar.style.left = `${barLeft}px`;
			bar.style.width = `${barWidth}px`;
			bar.toggleClass("is-late", r.lateVsDue);
			// an unscheduled task only sits on today's date because nothing places it:
			// draw it hollow so it never reads as a real plan
			bar.toggleClass("is-unscheduled", unscheduled);
			bar.toggleClass("is-critical", o.critical && r.critical);
			if (pct > 0) {
				const fill = bar.createDiv({ cls: "th-gantt-progress" });
				fill.style.width = `${pct}%`;
			}
		}

		// A short bar cannot hold its own name, so the label sits just after it rather
		// than being clipped — the usual Gantt treatment for brief tasks.
		const fits = !r.task.milestone && barWidth >= 8 * r.task.title.length + (r.lateVsDue || r.cyclic ? 26 : 14);
		if (fits) {
			bar.createSpan({ cls: "th-gantt-bar-text", text: r.task.title });
			if (r.lateVsDue || r.cyclic) setIcon(bar.createSpan({ cls: "th-gantt-bar-flag" }), flagIcon);
		} else {
			const outside = lane.createDiv({ cls: `th-gantt-bar-outside is-${r.task.status}` });
			outside.style.left = `${barLeft + (r.task.milestone ? 12 : barWidth) + 6}px`;
			if (r.lateVsDue || r.cyclic) setIcon(outside.createSpan({ cls: "th-gantt-bar-flag" }), flagIcon);
			outside.createSpan({ text: r.task.title });
			if (pct > 0 && pct < 100 && !r.task.milestone) outside.createSpan({ cls: "th-gantt-pct", text: `${pct}%` });
		}

		const describe = () => {
			const lines = [r.task.title];
			lines.push(
				r.task.milestone
					? `Milestone · ${fmtDay(r.start)}`
					: `${fmtDay(r.start)} → ${fmtDay(r.end)} · ${r.durationDays} working day${r.durationDays === 1 ? "" : "s"}`,
			);
			lines.push(`Status: ${STATUSES.find((s) => s.value === r.task.status)?.label}${pct ? ` · ${pct}% complete` : ""}`);
			if (r.task.owner) lines.push(`Owner: ${r.task.owner}`);
			if (r.task.phase) lines.push(`Phase: ${r.task.phase}`);
			if (r.task.type) lines.push(`Type: ${r.task.type}`);
			if (r.task.note) lines.push(`Note: ${basename(r.task.note)}`);
			if (r.task.due) lines.push(`Due: ${fmtDay(r.task.due)}`);
			if (!r.task.start && r.deps.length) lines.push("Start: automatic, after its prerequisites");
			if (r.deps.length) {
				lines.push(
					`After: ${r.deps
						.map((d) => {
							const lag = r.task.depLags?.[d] ?? 0;
							return `${plugin.getTask(d)?.title ?? "?"}${lag ? ` + ${lag}d` : ""}`;
						})
						.join(", ")}`,
				);
			}
			if (gap === "anchor") lines.push("⚠ Not scheduled — nothing fixes it in time, so it sits on today");
			else if (gap === "length") lines.push("⚠ No duration set — shown as a single day");
			else lines.push(r.critical ? "On the critical path" : `Float: ${r.float} working day${r.float === 1 ? "" : "s"}`);
			if (r.task.baseline) {
				const drift = r.baselineDrift ?? 0;
				lines.push(
					`Baseline: ${fmtDay(r.task.baseline.start)} → ${fmtDay(r.task.baseline.end)}` +
						(drift === 0 ? " (on plan)" : drift > 0 ? ` (${drift}d late)` : ` (${-drift}d early)`),
				);
			}
			if (r.pushed) lines.push("⚠ Prerequisites pushed the start later than planned");
			if (r.lateVsDue) lines.push("⚠ Finishes after its due date");
			if (r.cyclic) lines.push("⚠ Circular prerequisites — links ignored");
			return lines.join("\n");
		};
		bar.addEventListener("mouseenter", (e) => showTip(e, describe()));
		bar.addEventListener("mousemove", (e) => showTip(e, describe()));
		bar.addEventListener("mouseleave", () => tip.hide());
		bar.setAttr("aria-label", describe());

		if (!o.interactive) return;

		// drag the bar to move it, or its right edge to change the duration
		if (!r.task.milestone) bar.createDiv({ cls: "th-gantt-handle" });
		attachDrag(bar, r);

		bar.addEventListener("click", (e) => {
			if (bar.hasClass("was-dragged")) { bar.removeClass("was-dragged"); return; }
			e.preventDefault();
			new ScheduleModal(plugin.app, plugin, r.task, onChange).open();
		});
		const menu = (e: MouseEvent) => {
			e.preventDefault();
			rowMenu(r, e);
		};
		bar.addEventListener("contextmenu", menu);
		side.addEventListener("contextmenu", menu);
	}

	/** Pointer drag: move the whole bar, or resize it from the right edge. */
	function attachDrag(bar: HTMLElement, r: Scheduled) {
		bar.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			const resizing = (e.target as HTMLElement).hasClass("th-gantt-handle");
			const startX = e.clientX;
			const originLeft = parseFloat(bar.style.left) || 0;
			const originWidth = bar.offsetWidth;
			let deltaDays = 0;
			bar.setPointerCapture(e.pointerId);
			bar.addClass("is-live");

			const move = (ev: PointerEvent) => {
				deltaDays = Math.round((ev.clientX - startX) / px);
				if (resizing) bar.style.width = `${Math.max(px, originWidth + deltaDays * px)}px`;
				else bar.style.left = `${originLeft + deltaDays * px}px`;
				showTip(ev, resizing
					? `Duration ${Math.max(1, r.durationDays + deltaDays)} working days`
					: `Start ${fmtDay(addWorkingDays(r.start, Math.abs(deltaDays), cal))}`.replace("Start", deltaDays < 0 ? "Start ←" : "Start"));
			};
			const finish = async () => {
				bar.removeEventListener("pointermove", move);
				bar.removeEventListener("pointerup", up);
				bar.removeClass("is-live");
				tip.hide();
				if (!deltaDays) return;
				bar.addClass("was-dragged"); // stop the click handler opening the editor
				if (resizing) {
					await plugin.setSchedule(r.task.id, { durationDays: Math.max(1, r.durationDays + deltaDays) });
				} else {
					// dragging sets an explicit start, even if the date came from a prerequisite
					const shifted = shiftWorkingDays(r.start, deltaDays, cal);
					await plugin.setSchedule(r.task.id, { start: shifted });
				}
				onChange?.();
			};
			const up = () => void finish();
			bar.addEventListener("pointermove", move);
			bar.addEventListener("pointerup", up);
		});
	}

	function rowMenu(r: Scheduled, e: MouseEvent) {
		const m = new Menu();
		m.addItem((it) => it.setTitle("Schedule & prerequisites…").setIcon("calendar-range").onClick(() => new ScheduleModal(plugin.app, plugin, r.task, onChange).open()));
		if (o.sort === "manual") {
			m.addItem((it) => it.setTitle("Move up").setIcon("arrow-up").onClick(() => void nudge(r.task.id, -1)));
			m.addItem((it) => it.setTitle("Move down").setIcon("arrow-down").onClick(() => void nudge(r.task.id, 1)));
		}
		m.addSeparator();
		m.addItem((it) => it.setTitle("Progress").setIsLabel(true));
		for (const pct of [0, 25, 50, 75, 100]) {
			m.addItem((it) =>
				it.setTitle(`${pct}%`).setChecked(progressOf(r.task) === pct).onClick(async () => {
					await plugin.updateTask(r.task.id, { percent: pct });
					onChange?.();
				}),
			);
		}
		m.addSeparator();
		m.addItem((it) =>
			it.setTitle(r.task.milestone ? "Turn into a task" : "Turn into a milestone").setIcon("diamond").onClick(async () => {
				await plugin.updateTask(r.task.id, { milestone: !r.task.milestone });
				onChange?.();
			}),
		);
		m.addItem((it) =>
			it.setTitle(r.task.baseline ? "Reset baseline to these dates" : "Set baseline from these dates").setIcon("bookmark").onClick(async () => {
				await plugin.setBaseline([{ id: r.task.id, start: r.start, end: r.end }]);
				onChange?.();
			}),
		);
		if (r.task.baseline) {
			m.addItem((it) => it.setTitle("Clear baseline").setIcon("bookmark-x").onClick(async () => { await plugin.clearBaseline([r.task.id]); onChange?.(); }));
		}
		if (r.task.note) m.addItem((it) => it.setTitle("Open note").setIcon("file-text").onClick(() => void plugin.openPath(r.task.note!)));
		m.addSeparator();
		for (const st of STATUSES) {
			m.addItem((it) => it.setTitle(st.label).setChecked(r.task.status === st.value).onClick(async () => { await plugin.setStatus(r.task.id, st.value); onChange?.(); }));
		}
		m.showAtMouseEvent(e);
	}

	// ---- dependency arrows ----
	// Rows grow to fit wrapped labels, so the vertical positions are measured from the
	// laid-out lanes rather than calculated from a fixed row height.
	const svg = body.createSvg("svg", { cls: "th-gantt-links" });

	const drawLinks = () => {
		if (!body.isConnected) return;
		svg.empty();
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(body.offsetHeight));
		svg.createSvg("defs")
			.createSvg("marker", { attr: { id: "th-gantt-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" } })
			.createSvg("path", { attr: { d: "M0,0 L8,4 L0,8 z", fill: "currentColor" } });
		const midY = (lane: HTMLElement) => lane.offsetTop + lane.offsetHeight / 2;
		const byId = new Map(all.map((r) => [r.task.id, r]));
		for (const r of rows) {
			const toLane = laneById.get(r.task.id);
			if (!toLane) continue; // row is inside a collapsed group
			for (const depId of r.deps) {
				const fromLane = laneById.get(depId);
				const dep = byId.get(depId);
				if (!fromLane || !dep) continue;
				const x1 = clampX(addDays(dep.end, 1)) - 1;
				const y1 = midY(fromLane);
				const x2 = clampX(r.start);
				const y2 = midY(toLane);
				const yMid = (y1 + y2) / 2;
				const path = svg.createSvg("path");
				path.setAttribute("d", `M ${x1} ${y1} H ${x1 + 8} V ${yMid} H ${x2 - 8} V ${y2} H ${x2 - 2}`);
				path.setAttribute("class", "th-gantt-link");
				if (o.critical && r.critical && dep.critical) path.setAttribute("data-critical", "true");
				path.setAttribute("marker-end", "url(#th-gantt-arrow)");
			}
		}
	};
	window.requestAnimationFrame(drawLinks);
	// labels rewrap when the pane is resized, which moves every row
	const observer = new ResizeObserver(() => drawLinks());
	observer.observe(body);

	// ---- legend ----
	const legend = root.createDiv({ cls: "th-gantt-legend" });
	for (const st of STATUSES) {
		const item = legend.createSpan({ cls: "th-gantt-legend-item" });
		item.createSpan({ cls: `th-gantt-dot is-${st.value}` });
		item.createSpan({ text: st.label });
	}
	if (rows.some((r) => schedulingGap(r.task) !== null)) {
		const un = legend.createSpan({ cls: "th-gantt-legend-item" });
		un.createSpan({ cls: "th-gantt-legend-unscheduled" });
		un.createSpan({ text: "Not scheduled" });
	}
	const ms = legend.createSpan({ cls: "th-gantt-legend-item" });
	ms.createSpan({ cls: "th-gantt-legend-diamond" });
	ms.createSpan({ text: "Milestone" });
	if (o.critical) {
		const crit = legend.createSpan({ cls: "th-gantt-legend-item" });
		crit.createSpan({ cls: "th-gantt-legend-crit" });
		crit.createSpan({ text: "Critical path" });
	}
	if (o.baseline && rows.some((r) => r.task.baseline)) {
		const base = legend.createSpan({ cls: "th-gantt-legend-item" });
		base.createSpan({ cls: "th-gantt-legend-base" });
		base.createSpan({ text: "Baseline" });
	}
	const warn = legend.createSpan({ cls: "th-gantt-legend-item" });
	setIcon(warn.createSpan({ cls: "th-gantt-legend-icon" }), "alert-triangle");
	warn.createSpan({ text: "Finishes after its due date" });

	// today marker, drawn last so it sits above the bars
	if (today >= from && today <= to) {
		const line = underlay.createDiv({ cls: "th-gantt-today" });
		line.style.left = `${x(today) + px / 2}px`;
		line.setAttr("aria-label", "Today");
		line.title = "Today";
	}

	// open the chart near today rather than at the far left
	if (o.zoom !== "fit") {
		window.setTimeout(() => {
			const target = x(today) - scroll.clientWidth / 3;
			if (target > 0) scroll.scrollLeft = target;
		}, 0);
	}
}

const isWorkingDay = (iso: string, cal: Calendar) => {
	if (!cal.workingDaysOnly) return true;
	const day = parseISO(iso).getDay();
	return day !== 0 && day !== 6 && !cal.holidays.has(iso);
};

/** Move a date by whole working days in either direction. */
function shiftWorkingDays(iso: string, delta: number, cal: Calendar): string {
	if (delta === 0) return iso;
	if (delta > 0) return addWorkingDays(iso, delta, cal);
	let d = iso;
	for (let i = 0; i < -delta; i++) {
		d = addDays(d, -1);
		while (!isWorkingDay(d, cal)) d = addDays(d, -1);
	}
	return d;
}

/**
 * ```gantt code block: a timeline for one note's tasks.
 *
 * With no options it charts the tasks linked to the note it is written in, which is
 * the normal case — a timeline belongs to a project, not to the whole vault.
 * `note: <path>` charts a different note, and `note: *` drops the note filter.
 */
export function parseGanttBlock(source: string, sourcePath: string): GanttOptions {
	const o: GanttOptions = { ...DEFAULT_OPTIONS, note: sourcePath, collapsedGroups: new Set() };
	const bool = (v: string) => /^(true|yes|1|on)$/i.test(v);
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		const at = line.indexOf(":");
		if (!line || at < 0) continue;
		const key = line.slice(0, at).trim().toLowerCase();
		const value = line.slice(at + 1).trim();
		if (key === "type") o.type = value || null;
		else if (key === "note") o.note = value === "*" ? null : value || sourcePath;
		else if (key === "title") o.title = value;
		else if (key === "zoom" && ["day", "week", "month", "fit"].includes(value)) o.zoom = value as Zoom;
		else if (key === "status") o.status = value as GanttOptions["status"];
		else if (key === "sort" && ["manual", "start"].includes(value)) o.sort = value as GanttOptions["sort"];
		else if (key === "group" && ["none", "phase", "owner"].includes(value)) o.group = value as GroupBy;
		else if (key === "from") o.from = value;
		else if (key === "to") o.to = value;
		else if (key === "baseline") o.baseline = bool(value);
		else if (key === "critical") o.critical = bool(value);
		else if (key === "width" && ["full", "note"].includes(value)) o.width = value as GanttOptions["width"];
		else if (key === "unscheduled") o.unscheduled = bool(value);
		else if (key === "interactive") o.interactive = bool(value);
	}
	return o;
}

/** The full block: a toolbar plus the chart, redrawn in place when a control changes. */
export function renderGanttBlock(plugin: TaskHubPlugin, el: HTMLElement, source: string, sourcePath: string, ctx?: { addChild(child: MarkdownRenderChild): void }) {
	const options = parseGanttBlock(source, sourcePath);
	let lastWidth = 0;
	let observer: ResizeObserver | null = null;
	let unmarkWide: (() => void) | null = null;
	const draw = () => {
		el.empty();
		observer?.disconnect();
		observer = null;
		const wrap = el.createDiv({ cls: "th-gantt-wrap is-embedded" });
		wrap.toggleClass("is-fullwidth", options.width === "full");
		const bar = wrap.createDiv({ cls: "th-gantt-toolbar" });

		const zooms = bar.createDiv({ cls: "th-gantt-zoom" });
		for (const z of ["day", "week", "month", "fit"] as Zoom[]) {
			const b = zooms.createEl("button", { text: z[0].toUpperCase() + z.slice(1) });
			b.toggleClass("is-active", options.zoom === z);
			b.addEventListener("click", () => { options.zoom = z; draw(); });
		}

		const status = bar.createEl("select", { cls: "dropdown" });
		status.createEl("option", { value: "active", text: "Open + On Hold" });
		for (const st of STATUSES) status.createEl("option", { value: st.value, text: st.label });
		status.createEl("option", { value: "all", text: "All statuses" });
		status.value = options.status;
		status.addEventListener("change", () => { options.status = status.value as GanttOptions["status"]; draw(); });

		const group = bar.createEl("select", { cls: "dropdown" });
		group.createEl("option", { value: "phase", text: "Group: phase" });
		group.createEl("option", { value: "owner", text: "Group: owner" });
		group.createEl("option", { value: "none", text: "No grouping" });
		group.value = options.group;
		group.addEventListener("change", () => { options.group = group.value as GroupBy; draw(); });

		const sort = bar.createEl("select", { cls: "dropdown" });
		sort.createEl("option", { value: "manual", text: "My order" });
		sort.createEl("option", { value: "start", text: "By start date" });
		sort.value = options.sort;
		sort.addEventListener("change", () => { options.sort = sort.value as GanttOptions["sort"]; draw(); });

		const toggle = (label: string, value: boolean, set: (v: boolean) => void) => {
			const wrapLabel = bar.createEl("label", { cls: "th-gantt-check" });
			const cb = wrapLabel.createEl("input", { type: "checkbox" });
			cb.checked = value;
			cb.addEventListener("change", () => { set(cb.checked); draw(); });
			wrapLabel.createSpan({ text: label });
		};
		toggle("Critical path", options.critical, (v) => (options.critical = v));
		toggle("Unscheduled", options.unscheduled, (v) => (options.unscheduled = v));

		// how many tasks in this note still have nothing placing them on the chart
		const missing = selectTasks(plugin.data.tasks, { ...options, unscheduled: true }).filter((t) => schedulingGap(t) !== null);
		if (missing.length) {
			const chip = bar.createEl("button", { cls: "th-gantt-missing" });
			setIcon(chip.createSpan({ cls: "th-gantt-icon" }), "calendar-off");
			chip.createSpan({ text: `${missing.length} not scheduled` });
			chip.title = "Tasks with no start date or no duration — their bars are only a guess";
			chip.addEventListener("click", () => { options.unscheduled = true; draw(); });
		}

		const actions = bar.createDiv({ cls: "th-gantt-actions" });
		const baselineBtn = actions.createEl("button", { text: "Set baseline" });
		baselineBtn.title = "Snapshot today's dates as the agreed plan for every task shown";
		baselineBtn.addEventListener("click", () => void (async () => {
			const tasks = selectTasks(plugin.data.tasks, options);
			const rows = computeSchedule(tasks, todayISO(), plugin.calendar);
			await plugin.setBaseline(rows.map((r) => ({ id: r.task.id, start: r.start, end: r.end })));
			new Notice(`Baseline set for ${rows.length} task${rows.length === 1 ? "" : "s"}`);
			draw();
		})());

		const imageBtn = actions.createEl("button", { cls: "th-gantt-export" });
		setIcon(imageBtn.createSpan({ cls: "th-gantt-export-icon" }), "image-down");
		imageBtn.createSpan({ text: "Image" });
		imageBtn.title = "Save or copy the timeline as a picture";
		imageBtn.addEventListener("click", (e) => {
			const m = new Menu();
			m.addItem((it) => it.setTitle("Save as PNG").setIcon("image").onClick(() => void saveImage(plugin, options, sourcePath, "png")));
			m.addItem((it) => it.setTitle("Save as SVG").setIcon("file-code").onClick(() => void saveImage(plugin, options, sourcePath, "svg")));
			m.addItem((it) => it.setTitle("Copy PNG to clipboard").setIcon("clipboard-copy").onClick(() => void copyImage(plugin, options)));
			m.showAtMouseEvent(e);
		});

		const exportBtn = actions.createEl("button", { cls: "th-gantt-export" });
		setIcon(exportBtn.createSpan({ cls: "th-gantt-export-icon" }), "file-down");
		exportBtn.createSpan({ text: "PDF" });
		exportBtn.title = "Export to PDF — every task, whatever is filtered on screen (choose landscape)";
		exportBtn.addEventListener("click", () => exportToPdf(plugin));

		renderGantt(plugin, wrap, options, draw);

		// the pane can be resized or the sidebars collapsed; follow it
		const pane = scrollParent(el);
		if (pane && options.width === "full") {
			lastWidth = pane.clientWidth;
			observer = new ResizeObserver(() => {
				if (Math.abs(pane.clientWidth - lastWidth) < 24) return;
				lastWidth = pane.clientWidth;
				draw();
			});
			observer.observe(pane);
		}
		unmarkWide?.();
		unmarkWide = options.width === "full" ? markWide(wrap) : null;

		// A copy that only exists on paper: every task in this note, whatever the screen
		// is filtered to, as the same light-palette image the image export makes, so the
		// PDF needs no print overrides of the theme's colours.
		const svg = ganttToSvg(plugin, { ...options, status: "all", unscheduled: true, zoom: "fit", interactive: false, collapsedGroups: new Set() }, 1000);
		if (svg) {
			const paper = wrap.createDiv({ cls: "th-gantt-print-only" });
			renderPlanMeter(plugin, paper, options);
			paper.createEl("img", {
				attr: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, alt: "Timeline" },
			});
		}
	};
	draw();

	if (ctx) {
		const child = new MarkdownRenderChild(el);
		child.register(() => {
			observer?.disconnect();
			unmarkWide?.();
		});
		ctx.addChild(child);
	}
}

/*
 * Obsidian caps note content at the readable line length, which squeezes a full-width
 * timeline into the middle of a wide pane. The chart marks the containers around it
 * (reading view: the sizer and the section holding the chart; Live Preview: the sizer
 * and the embed block), and the stylesheet lifts the cap only there. Marks are counted
 * so two charts in one note don't unmark each other.
 */
const wideMarks = new WeakMap<Element, number>();

function addMark(target: Element, cls: string) {
	wideMarks.set(target, (wideMarks.get(target) ?? 0) + 1);
	target.addClass(cls);
}

function dropMark(target: Element, cls: string) {
	const n = (wideMarks.get(target) ?? 1) - 1;
	wideMarks.set(target, n);
	if (n <= 0) target.removeClass(cls);
}

function markWide(wrap: HTMLElement): () => void {
	let marked: [Element, string][] = [];
	let frames = 0;
	let pending = 0;
	const mark = () => {
		pending = 0;
		// the block is rendered before Obsidian attaches it to the note
		if (!wrap.isConnected) {
			if (++frames < 120) pending = window.requestAnimationFrame(mark);
			return;
		}
		const sizer = wrap.closest(".markdown-preview-sizer, .cm-sizer");
		if (!sizer) return;
		let host: Element | null = wrap.closest(".cm-embed-block");
		if (!host) {
			host = wrap;
			while (host.parentElement && host.parentElement !== sizer) host = host.parentElement;
		}
		marked = [[sizer, "th-wide-sizer"], [host, "th-wide-host"]];
		for (const [target, cls] of marked) addMark(target, cls);
	};
	mark();
	return () => {
		if (pending) window.cancelAnimationFrame(pending);
		for (const [target, cls] of marked) dropMark(target, cls);
		marked = [];
	};
}


/** The pane the note scrolls in, in either reading or editing view. */
function scrollParent(el: HTMLElement): HTMLElement | null {
	return el.closest<HTMLElement>(".markdown-preview-view, .cm-scroller");
}

/** Hand off to Obsidian's own "Export to PDF", which prints the current note. */
function exportToPdf(plugin: TaskHubPlugin) {
	const commands = (plugin.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
	const ran = commands?.executeCommandById("workspace:export-pdf");
	if (!ran) {
		new Notice("Use the note menu (⋯) → Export to PDF. Choose landscape for a wide chart.", 8000);
	}
}

/** Image export always covers every task in the note, like the PDF does. */
const exportOptions = (o: GanttOptions): GanttOptions => ({
	...o,
	status: "all",
	unscheduled: true,
	interactive: false,
	title: o.title ?? "",
});

async function saveImage(plugin: TaskHubPlugin, o: GanttOptions, sourcePath: string, format: "png" | "svg") {
	try {
		const opts = exportOptions(o);
		if (!opts.title) opts.title = basename(sourcePath);
		const svg = ganttToSvg(plugin, opts);
		if (!svg) { new Notice("Nothing to export yet."); return; }
		const folder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
		const base = `${basename(sourcePath)}.${format}`;
		const path = await plugin.app.fileManager.getAvailablePathForAttachment(base, sourcePath);
		const target = folder && !path.includes("/") ? `${folder}/${path}` : path;
		const file = format === "svg"
			? await plugin.app.vault.create(target, svg)
			: await plugin.app.vault.createBinary(target, await svgToPng(svg));
		new Notice(`Saved ${file.path}`);
	} catch (e) {
		console.error("Focus Hub: image export failed", e);
		new Notice("Could not export the image — see the console.");
	}
}

async function copyImage(plugin: TaskHubPlugin, o: GanttOptions) {
	try {
		const svg = ganttToSvg(plugin, exportOptions(o));
		if (!svg) { new Notice("Nothing to export yet."); return; }
		const png = await svgToPng(svg);
		await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
		new Notice("Timeline copied — paste it into an email or slide.");
	} catch (e) {
		console.error("Focus Hub: clipboard copy failed", e);
		new Notice("Could not copy the image — see the console.");
	}
}
