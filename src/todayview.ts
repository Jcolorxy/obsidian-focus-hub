import { ItemView, Menu, Modal, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import type TaskHubPlugin from "./main";
import { ScheduleModal, TaskPickerModal } from "./modals";
import { Task, basename, formatDate, isWeekend, isWorkTask, tasksForDay, todayISO } from "./types";
import { HISTORY_VIEW_TYPE } from "./historyview";
import { todayModel } from "./today";
import { MEETINGS_TIMEZONE, localDate, parseMeetings, meetingDetails } from "./meetings";
import { renderMeter, scheduleProgress } from "./progress";
import { prepareRows, progressOf, DEFAULT_OPTIONS } from "./ganttview";

export const TODAY_VIEW_TYPE = "task-hub-today";

const weekday = (iso: string) => new Date(iso + "T00:00").toLocaleDateString(undefined, { weekday: "long" });

/**
 * The daily command centre. Most open tasks have no due date, so this is built to
 * help choose what to work on — a short focus list, fed by the plan, the calendar,
 * and a morning suggestion — rather than to list deadlines.
 */
export class TodayView extends ItemView {
	private meetingsOpen = false;
	constructor(leaf: WorkspaceLeaf, private plugin: TaskHubPlugin) {
		super(leaf);
		const refreshMeetings = (file: { path: string }) => {
			if (this.meetingsOpen && file.path === this.plugin.data.settings.meetingsNotePath) this.render();
		};
		this.registerEvent(this.app.vault.on("modify", refreshMeetings));
		this.registerEvent(this.app.vault.on("create", refreshMeetings));
		this.registerEvent(this.app.vault.on("delete", refreshMeetings));
	}

	getViewType() { return TODAY_VIEW_TYPE; }
	getDisplayText() { return "Today"; }
	getIcon() { return "sun"; }

	async onOpen() {
		await this.plugin.ensureToday();
		this.meetingsOpen = true;
		this.render();
		// opening Today later in the day still gets a suggestion if none arrived
		if (this.plugin.syncGraceOver) void this.plugin.maybeSuggest();
	}

	async onClose() {
		this.meetingsOpen = false;
		this.contentEl.empty();
	}

	render() {
		const el = this.contentEl;
		el.empty();
		const root = el.createDiv({ cls: "th-today" });
		const today = todayISO();
		const { today: state, settings } = this.plugin.data;
		// at the weekend everything below is built from personal tasks only
		const weekend = isWeekend(today);
		const tasks = tasksForDay(this.plugin.data.tasks, today);
		const model = todayModel(tasks, today, this.plugin.calendar, settings.staleDays);
		const byId = new Map(tasks.map((t) => [t.id, t]));
		const allById = new Map(this.plugin.data.tasks.map((t) => [t.id, t]));

		// ---- header ----
		const head = root.createDiv({ cls: "th-today-head" });
		const title = head.createDiv({ cls: "th-today-title" });
		title.createDiv({ cls: "th-today-day", text: weekday(today) });
		title.createDiv({ cls: "th-today-date", text: formatDate(today) + (weekend ? " · weekend — personal only" : "") });
		const actions = head.createDiv({ cls: "th-today-actions" });
		actions.createEl("button", { text: "Work history" }).addEventListener("click", () => void this.plugin.activateView(HISTORY_VIEW_TYPE));
		const review = actions.createEl("button", { cls: state.reviewed === today ? "" : "mod-cta" });
		setIcon(review.createSpan({ cls: "th-today-icon" }), "moon");
		review.createSpan({ text: state.reviewed === today ? "Reviewed" : "End of day" });
		review.addEventListener("click", () => new ReviewModal(this.app, this.plugin, () => this.render()).open());

		const grid = root.createDiv({ cls: "th-today-grid" });
		const main = grid.createDiv({ cls: "th-today-main" });
		const side = grid.createDiv({ cls: "th-today-side" });
		// the meetings card reads a calendar snapshot note, if one is configured
		if (this.plugin.data.settings.meetingsNotePath) this.meetingsCard(main);

		// ---- suggestion ----
		const suggestion = state.suggestion?.date === today ? state.suggestion : null;
		const brief = this.plugin.briefState;
		if (!suggestion && brief.running) {
			const card = this.section(main, "sparkles", "Suggested focus", "");
			card.addClass("th-today-suggestion");
			card.createDiv({ cls: "th-today-empty", text: "Asking Claude for today's focus…" });
		} else if (!suggestion && brief.error) {
			const card = this.section(main, "sparkles", "Suggested focus", "");
			card.createDiv({ cls: "th-today-empty", text: `Couldn't get a suggestion: ${brief.error}.` });
			const retry = card.createEl("button", { cls: "th-today-accept", text: "Try again" });
			retry.addEventListener("click", () => void this.plugin.maybeSuggest(true));
		}
		if (suggestion) {
			const via = suggestion.source ? ` via ${suggestion.source}` : "";
			const card = this.section(main, "sparkles", "Suggested focus", `${suggestion.model}${via}`);
			card.addClass("th-today-suggestion");
			if (suggestion.summary) card.createDiv({ cls: "th-today-summary", text: suggestion.summary });
			const pending = suggestion.items.filter((i) => byId.has(i.id) && byId.get(i.id)!.status !== "closed");
			for (const item of pending) {
				const task = byId.get(item.id)!;
				const row = this.taskRow(card, task, { reason: item.reason });
				if (!state.focus.includes(task.id)) {
					this.rowButton(row, "plus", "Add to focus", async () => { await this.plugin.addToFocus(task.id); this.render(); });
				} else {
					row.addClass("is-picked");
				}
			}
			const head = card.querySelector<HTMLElement>(".th-today-card-head") ?? card;
			const again = head.createEl("button", { cls: "clickable-icon th-today-again", attr: { "aria-label": "Suggest again" } });
			setIcon(again, "refresh-cw");
			again.addEventListener("click", () => void this.plugin.maybeSuggest(true));
			const unpicked = pending.filter((i) => !state.focus.includes(i.id));
			if (unpicked.length) {
				const accept = card.createEl("button", { cls: "th-today-accept", text: `Accept ${unpicked.length === pending.length ? "all" : "the rest"}` });
				accept.addEventListener("click", () => void (async () => {
					for (const i of unpicked) if (!(await this.plugin.addToFocus(i.id))) break;
					this.render();
				})());
			}
		}

		// ---- focus ----
		// count what is actually shown: ids of deleted tasks, or work set aside at the weekend, don't count
		const focus = state.focus.map((id) => byId.get(id)).filter((t): t is Task => !!t);
		const focusCard = this.section(main, "target", "Today's focus", `${focus.length} of ${settings.focusLimit}`);
		focusCard.addClass("th-today-focus");
		const setAside = weekend ? state.focus.map((id) => allById.get(id)).filter((t): t is Task => !!t && isWorkTask(t) && t.status !== "closed") : [];
		if (!focus.length) {
			focusCard.createDiv({
				cls: "th-today-empty",
				text: suggestion ? "Pick from the suggestion above, or add your own." : "Nothing chosen yet — add the few things that would make today a good day.",
			});
		}
		focus.forEach((task, i) => {
			const row = this.taskRow(focusCard, task, { carried: state.carried.includes(task.id), check: true });
			if (i > 0) this.rowButton(row, "arrow-up", "Move up", async () => { await this.plugin.moveFocus(task.id, -1); this.render(); });
			this.rowButton(row, "x", "Remove from focus", async () => { await this.plugin.removeFromFocus(task.id); this.render(); });
		});
		if (setAside.length) {
			focusCard.createDiv({
				cls: "th-today-more",
				text: `${setAside.length} work task${setAside.length === 1 ? "" : "s"} set aside until Monday`,
			});
		}
		if (focus.length < settings.focusLimit) {
			const add = focusCard.createEl("button", { cls: "th-today-add" });
			setIcon(add.createSpan({ cls: "th-today-icon" }), "plus");
			add.createSpan({ text: "Add a task" });
			add.addEventListener("click", () => {
				const choices = tasks.filter((t) => t.status !== "closed" && !state.focus.includes(t.id));
				new TaskPickerModal(this.app, choices, async (t) => { await this.plugin.addToFocus(t.id); this.render(); }, "Add to today's focus…").open();
			});
		}

		// ---- on the plan ----
		const planCard = this.section(main, "gantt-chart", "On the plan today", model.plan.length ? String(model.plan.length) : "");
		if (!model.plan.length) planCard.createDiv({ cls: "th-today-empty", text: "No timeline has work scheduled for today." });
		for (const r of model.plan) {
			const row = this.taskRow(planCard, r.task, {
				meta: `${formatDate(r.start)} → ${formatDate(r.end)}${r.critical ? " · critical" : ""}`,
				critical: r.critical,
			});
			this.addFocusButton(row, r.task);
		}

		// ---- coming up ----
		const upCard = this.section(main, "calendar-clock", "Coming up", "next 7 days");
		if (!model.upcoming.length) upCard.createDiv({ cls: "th-today-empty", text: "Nothing due, starting or landing this week." });
		let lastDate = "";
		for (const ev of model.upcoming) {
			if (ev.date !== lastDate) {
				upCard.createDiv({ cls: "th-today-daylabel", text: `${weekday(ev.date)} ${formatDate(ev.date)}` });
				lastDate = ev.date;
			}
			const label = ev.kind === "due" ? "due" : ev.kind === "milestone" ? "milestone" : "starts";
			const row = this.taskRow(upCard, ev.task, { tag: label });
			this.addFocusButton(row, ev.task);
		}

		// ---- project pulse (side) ----
		const timelineNotes = [...this.plugin.timelineNotes].filter((n) => n !== "*" && !(weekend && isWorkTask({ type: null, note: n })));
		if (timelineNotes.length) {
			const pulse = this.section(side, "activity", "Projects", "");
			for (const note of timelineNotes) {
				const plan = prepareRows(this.plugin, { ...DEFAULT_OPTIONS, note, status: "all", unscheduled: true });
				const p = scheduleProgress(plan.rows, plan.today, plan.cal, progressOf);
				if (!plan.rows.length || !p.counted) continue;
				const closed = plan.rows.filter((r) => r.task.status === "closed").length;
				const tile = renderMeter(pulse, {
					label: basename(note),
					pct: p.actual,
					detail: `${closed}/${plan.rows.length} closed`,
					expected: p.expected,
					delta: p.delta,
				});
				tile.addClass("is-compact");
				tile.addEventListener("click", () => void this.plugin.openPath(note));
			}
		}

		// ---- waiting on (side) ----
		const waitCard = this.section(side, "hourglass", "Waiting on", model.waiting.length ? String(model.waiting.length) : "");
		if (!model.waiting.length) waitCard.createDiv({ cls: "th-today-empty", text: "Nothing blocked." });
		for (const w of model.waiting) {
			const meta = w.onHold ? "on hold" : `waiting for ${w.blockedBy.map((b) => b.title).join(", ")}`;
			this.taskRow(waitCard, w.task, { meta });
		}

		// ---- stale (side) ----
		const staleCard = this.section(side, "clock-alert", "Gone quiet", `${settings.staleDays}+ days`);
		if (!model.stale.length) staleCard.createDiv({ cls: "th-today-empty", text: "Everything open has been touched recently." });
		for (const t of model.stale.slice(0, 8)) {
			const days = Math.floor((Date.now() - (t.updated ?? t.created)) / 86400000);
			const row = this.taskRow(staleCard, t, { meta: `${days} days` });
			this.addFocusButton(row, t);
		}
		if (model.stale.length > 8) staleCard.createDiv({ cls: "th-today-more", text: `+ ${model.stale.length - 8} more` });
	}

	private meetingsCard(parent: HTMLElement) {
		const date = localDate();
		const card = this.section(parent, "calendar-clock", "Work meetings", `${date} · ${MEETINGS_TIMEZONE}`);
		card.addClass("th-meetings-card");
		const controls = card.createDiv({ cls: "th-today-actions th-meetings-controls" });
		const open = controls.createEl("button", { text: "Open calendar" });
		open.addEventListener("click", () => void this.plugin.openPath(this.plugin.data.settings.meetingsNotePath));
		const refresh = controls.createEl("button", { text: "Refresh view" });
		refresh.title = "Reread the saved snapshot; does not fetch Outlook";
		refresh.addEventListener("click", () => this.render());
		card.createDiv({ cls: "th-today-row-meta", text: "Saved snapshot only — Refresh view does not fetch Outlook." });
		const body = card.createDiv({ cls: "th-today-meetings" });
		body.createDiv({ cls: "th-today-empty", text: "Reading calendar snapshot…" });
		void this.readMeetings(body, date);
	}

	private async readMeetings(body: HTMLElement, date: string) {
		let snapshot: ReturnType<typeof parseMeetings> | null = null;
		try {
			const file = this.app.vault.getFileByPath(this.plugin.data.settings.meetingsNotePath);
			if (file) snapshot = parseMeetings(await this.app.vault.read(file), date);
		} catch { /* Missing/unreadable snapshots get the same non-sensitive message. */ }
		// A task update, refresh or close may have replaced the card during read().
		if (!this.contentEl.contains(body)) return;
		body.empty();
		body.createDiv({ cls: "th-today-row-meta", text: snapshot?.context || "Snapshot context unavailable." });
		if (!snapshot?.found || !snapshot.rows.length) {
			const message = !snapshot ? "Calendar snapshot unavailable."
				: !snapshot.found ? "Calendar snapshot stale or unavailable for today."
				: "No meetings listed in this saved snapshot.";
			body.createDiv({ cls: "th-today-empty", text: `${message} This does not confirm that your calendar is free.` });
		}
		if (snapshot?.rows.length) {
			const agenda = body.createEl("ul", { cls: "th-meetings-agenda", attr: { "aria-label": "Saved work meetings" } });
			for (const row of snapshot.rows) {
				const event = agenda.createEl("li", { cls: "th-meeting" });
				const details = meetingDetails(row);
				if (!details) {
					event.addClass("th-meeting-fallback");
					event.createDiv({ cls: "th-meeting-content", text: row });
					continue;
				}
				const time = event.createDiv({ cls: "th-meeting-time" });
				if (details.allDay) {
					event.addClass("is-all-day");
					time.createSpan({ cls: "th-meeting-badge", text: "All day" });
				} else {
					time.createDiv({ cls: "th-meeting-start", text: details.start });
					time.createDiv({ cls: "th-meeting-end", text: `to ${details.end}` });
				}
				const content = event.createDiv({ cls: "th-meeting-content" });
				content.createDiv({ cls: "th-meeting-title", text: details.title });
				if (details.location) content.createDiv({ cls: "th-meeting-location", text: details.location });
			}
		}
	}

	private section(parent: HTMLElement, icon: string, title: string, note: string): HTMLElement {
		const card = parent.createDiv({ cls: "th-today-card" });
		const head = card.createDiv({ cls: "th-today-card-head" });
		setIcon(head.createSpan({ cls: "th-today-icon" }), icon);
		head.createSpan({ cls: "th-today-card-title", text: title });
		if (note) head.createSpan({ cls: "th-today-card-note", text: note });
		return card;
	}

	private taskRow(
		parent: HTMLElement,
		task: Task,
		o: { reason?: string; meta?: string; tag?: string; carried?: boolean; check?: boolean; critical?: boolean } = {},
	): HTMLElement {
		const row = parent.createDiv({ cls: "th-today-row" });
		row.toggleClass("is-critical", !!o.critical);
		if (o.check) {
			const cb = row.createEl("input", { type: "checkbox", cls: "th-today-check" });
			cb.checked = task.status === "closed";
			cb.addEventListener("change", () => void (async () => {
				await this.plugin.setStatus(task.id, cb.checked ? "closed" : "open");
				this.render();
			})());
		}
		const body = row.createDiv({ cls: "th-today-row-body" });
		const line = body.createDiv({ cls: "th-today-row-title" });
		if (o.tag) line.createSpan({ cls: `th-today-tag is-${o.tag}`, text: o.tag });
		line.createSpan({ text: task.title });
		if (task.status === "closed") line.addClass("is-done");
		const meta = [
			o.carried ? "carried over" : "",
			task.type ?? "",
			task.note ? basename(task.note) : "",
			task.due ? `due ${formatDate(task.due)}` : "",
			o.meta ?? "",
		].filter(Boolean).join(" · ");
		if (meta) body.createDiv({ cls: "th-today-row-meta", text: meta });
		if (o.reason) body.createDiv({ cls: "th-today-row-reason", text: o.reason });

		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const m = new Menu();
			if (task.note) m.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => void this.plugin.openPath(task.note!)));
			m.addItem((i) => i.setTitle("Schedule & prerequisites…").setIcon("calendar-range").onClick(() => new ScheduleModal(this.app, this.plugin, task, () => this.render()).open()));
			m.showAtMouseEvent(e);
		});
		body.addEventListener("click", () => { if (task.note) void this.plugin.openPath(task.note); });
		return row;
	}

	private rowButton(row: HTMLElement, icon: string, label: string, onClick: () => void | Promise<void>) {
		const b = row.createEl("button", { cls: "clickable-icon th-today-rowbtn", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => { e.stopPropagation(); void onClick(); });
	}

	private addFocusButton(row: HTMLElement, task: Task) {
		if (this.plugin.data.today.focus.includes(task.id)) { row.addClass("is-picked"); return; }
		this.rowButton(row, "plus", "Add to focus", async () => { await this.plugin.addToFocus(task.id); this.render(); });
	}
}

/** End of day: close what got done, roll the rest to tomorrow. */
class ReviewModal extends Modal {
	constructor(app: TaskHubPlugin["app"], private plugin: TaskHubPlugin, private onDone: () => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("th-today-review");
		contentEl.createEl("h3", { text: "How did today go?" });
		const byId = new Map(this.plugin.data.tasks.map((t) => [t.id, t]));
		const focus = tasksForDay(this.plugin.data.today.focus.map((id) => byId.get(id)).filter((t): t is Task => !!t), todayISO());
		if (!focus.length) contentEl.createEl("p", { cls: "setting-item-description", text: "No focus tasks today." });

		for (const task of focus) {
			const done = task.status === "closed";
			const s = new Setting(contentEl).setName(task.title).setDesc(done ? "Done" : "Still open — it will carry over to tomorrow");
			if (!done) {
				s.addButton((b) => b.setButtonText("Done").onClick(async () => {
					await this.plugin.setStatus(task.id, "closed");
					b.setDisabled(true).setButtonText("Done");
					s.setDesc("Done");
				}));
				s.addButton((b) => b.setButtonText("Drop").setTooltip("Take it off tomorrow's list").onClick(async () => {
					await this.plugin.removeFromFocus(task.id);
					this.close();
					new ReviewModal(this.app, this.plugin, this.onDone).open();
				}));
			}
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Finish the day").setCta().onClick(async () => {
				await this.plugin.markReviewed();
				this.onDone();
				this.close();
			}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
