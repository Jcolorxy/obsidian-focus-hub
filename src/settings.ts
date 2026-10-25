import { App, PluginSettingTab, SecretComponent, SettingDefinitionItem } from "obsidian";
import { NotePickerModal, PromptModal, bindDate } from "./modals";
import { basename, formatDate, formatDateTime } from "./types";
import type TaskHubPlugin from "./main";

/**
 * Declared rather than drawn, so every setting shows up in Obsidian's settings search.
 * Plain controls read and write `data.settings` through getControlValue/setControlValue;
 * rows that need more (the Keychain picker, dates, buttons, the type and note lists)
 * render themselves and call update() when what they show has changed.
 */
export class TaskHubSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TaskHubPlugin) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return (this.plugin.data.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown) {
		await this.plugin.setSettings({ [key]: value });
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const data = this.plugin.data;
		const settings = data.settings;
		const count = (pred: (t: { type: string | null; note: string | null }) => boolean) => data.tasks.filter(pred).length;
		const refresh = () => this.update();
		const last = data.today.suggestion;
		const notes = [...data.notes].sort((a, b) => basename(a).localeCompare(basename(b)));

		return [
			{
				type: "group",
				items: [
					{
						name: "Prompt for close-out comment",
						desc: "When work is moved to Closed in Focus Hub, Today or a timeline, ask for its result, your contribution and optional impact/evidence. Saved as a close-out comment; skipping keeps the task closed.",
						control: { type: "toggle", key: "closeOutPrompt" },
					},
					{
						name: "Add linked tasks to their note",
						desc: "When a task is linked to a note, write it there as a checkbox line and keep it in sync (title, closed, on hold). Ticking the box in the note closes the task.",
						control: { type: "toggle", key: "mirrorToNote" },
					},
					{
						name: "Add comments under the task in the note",
						desc: "Each comment is written as a bullet beneath the task's line, and kept in sync when you edit or delete it.",
						control: { type: "toggle", key: "mirrorComments" },
					},
					{
						name: "Heading for mirrored tasks",
						desc: "Lines are added under this heading (created at the end of the note if missing). Leave empty to append at the end.",
						control: { type: "text", key: "noteHeading", placeholder: "Tasks" },
					},
				],
			},
			{
				type: "group",
				heading: "Today",
				items: [
					{ name: "Open Today on startup", control: { type: "toggle", key: "openTodayOnStartup" } },
					{
						name: "Focus limit",
						desc: "The most tasks you can put in a day's focus. Fewer is the point.",
						control: { type: "slider", key: "focusLimit", min: 1, max: 10, step: 1 },
					},
					{
						name: "Gone quiet after",
						desc: "Open tasks untouched for this many days are listed as gone quiet.",
						control: { type: "slider", key: "staleDays", min: 3, max: 60, step: 1, displayFormat: (v) => `${v} days` },
					},
					{
						name: "Meetings note",
						desc: "A note holding a calendar snapshot, shown as a meetings card in Today. Leave empty to hide the card.",
						control: { type: "file", key: "meetingsNotePath", placeholder: "Work/Outlook calendar.md", filter: (f) => f.extension === "md" },
					},
				],
			},
			{
				type: "group",
				heading: "Morning suggestion",
				items: [
					{
						name: "Suggest my focus each day",
						desc: "Claude picks the few open tasks most worth doing today. The first device to open Obsidian each day asks; the rest receive it through Sync.",
						control: { type: "toggle", key: "briefEnabled" },
					},
					{
						name: "Anthropic API key",
						desc: "Chosen from Obsidian's Keychain, so the key stays on this device and is never written into the synced plugin data. Set it once per device that should be able to ask.",
						render: (setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el)
									.setValue(settings.briefKeychainId)
									.onChange((v) => void this.plugin.setSettings({ briefKeychainId: v })),
							);
						},
					},
					{
						name: "Paused until",
						desc: settings.briefPausedUntil
							? `No suggestions before ${formatDate(settings.briefPausedUntil)}, on any device.`
							: "Pause suggestions while you're on leave. Applies to every device.",
						render: (setting) => {
							setting.addText((t) => bindDate(t.inputEl, settings.briefPausedUntil, async (v) => {
								await this.plugin.setSettings({ briefPausedUntil: v });
								refresh();
							}));
							if (settings.briefPausedUntil) {
								setting.addExtraButton((b) =>
									b.setIcon("x").setTooltip("Resume now").onClick(() => void this.plugin.setSettings({ briefPausedUntil: null }).then(refresh)),
								);
							}
						},
					},
					{
						name: "Suggest now",
						desc: last ? `Last: ${formatDateTime(last.generatedAt)} · ${last.model}${last.source ? ` via ${last.source}` : ""}` : "No suggestion yet.",
						render: (setting) => {
							setting.addButton((b) => b.setButtonText("Suggest now").onClick(() => void this.plugin.maybeSuggest(true).then(refresh)));
						},
					},
				],
			},
			{
				type: "group",
				heading: "Timeline",
				items: [
					{
						name: "Schedule on working days",
						desc: "Durations skip weekends and the holidays below, so a 5-day task booked on a Thursday finishes the next Wednesday.",
						control: { type: "toggle", key: "workingDaysOnly" },
					},
					{
						name: "Holidays",
						desc: "Non-working dates as YYYY-MM-DD, separated by commas or new lines.",
						render: (setting) => {
							setting.addTextArea((t) => {
								t.inputEl.rows = 3;
								t.setPlaceholder("2026-12-25, 2026-12-26").setValue((settings.holidays ?? []).join(", "));
								// saved when you leave the box, so a half-typed date isn't dropped
								t.inputEl.addEventListener("blur", () => {
									const dates = t.getValue().split(/[\s,]+/).map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
									void this.plugin.setSettings({ holidays: Array.from(new Set(dates)).sort() });
								});
							});
						},
					},
				],
			},
			{
				type: "group",
				heading: "Backups",
				items: [
					{
						name: "Daily backups",
						desc: "A copy of the task data is kept in the plugin's backups folder once per day (last 7 kept). Use the \"Restore task data from a backup\" command to roll back.",
						render: (setting) => {
							setting.addButton((b) => b.setButtonText("Back up now").onClick(() => void this.plugin.writeBackup(true)));
						},
					},
				],
			},
			{
				type: "list",
				heading: "Types",
				emptyState: "No types yet. A type is a category such as Work, Personal or Errand.",
				addItem: {
					name: "Add type",
					action: () => new PromptModal(this.app, "New type", "", async (v) => { if (await this.plugin.addType(v)) refresh(); }).open(),
				},
				// removing a type leaves its tasks uncategorised
				onDelete: (i) => void this.plugin.removeType(data.types[i]).then(refresh),
				items: data.types.map((type) => ({
					name: type,
					desc: `${count((t) => t.type === type)} task(s)`,
					render: (setting) => {
						setting.addExtraButton((b) =>
							b.setIcon("pencil").setTooltip("Rename").onClick(() =>
								new PromptModal(this.app, "Rename type", type, async (v) => { await this.plugin.renameType(type, v); refresh(); }).open(),
							),
						);
					},
				})),
			},
			{
				type: "list",
				heading: "Note pages",
				emptyState: "No note pages yet. Notes are added here automatically when a task links to them.",
				addItem: {
					name: "Add note page",
					action: () => new NotePickerModal(this.app, this.plugin, async (f) => { await this.plugin.addNote(f.path); refresh(); }).open(),
				},
				// removing a note from the list unlinks its tasks
				onDelete: (i) => void this.plugin.removeNote(notes[i]).then(refresh),
				items: notes.map((note) => ({
					name: basename(note),
					desc: `${note} · ${count((t) => t.note === note)} task(s)`,
					render: (setting) => {
						setting.addExtraButton((b) => b.setIcon("file-text").setTooltip("Open note").onClick(() => this.plugin.openPath(note)));
					},
				})),
			},
		];
	}
}
