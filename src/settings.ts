import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { bindDate } from "./modals";
import { formatDate, formatDateTime } from "./types";
import type TaskHubPlugin from "./main";
import { NotePickerModal, PromptModal } from "./modals";
import { basename } from "./types";

export class TaskHubSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TaskHubPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const data = this.plugin.data;
		const count = (pred: (t: { type: string | null; note: string | null }) => boolean) => data.tasks.filter(pred).length;

		new Setting(containerEl)
			.setName("Prompt for close-out comment")
			.setDesc("When work is moved to Closed in Focus Hub, Today or a timeline, ask for its result, your contribution and optional impact/evidence. Saved as a close-out comment; skipping keeps the task closed.")
			.addToggle((t) => t.setValue(data.settings.closeOutPrompt).onChange((v) => void this.plugin.setSettings({ closeOutPrompt: v })));

		new Setting(containerEl)
			.setName("Add linked tasks to their note")
			.setDesc("When a task is linked to a note, write it there as a checkbox line and keep it in sync (title, closed, on hold). Ticking the box in the note closes the task.")
			.addToggle((t) => t.setValue(data.settings.mirrorToNote).onChange((v) => void this.plugin.setSettings({ mirrorToNote: v })));
		new Setting(containerEl)
			.setName("Add comments under the task in the note")
			.setDesc("Each comment is written as a bullet beneath the task's line, and kept in sync when you edit or delete it.")
			.addToggle((t) => t.setValue(data.settings.mirrorComments).onChange((v) => void this.plugin.setSettings({ mirrorComments: v })));
		new Setting(containerEl)
			.setName("Heading for mirrored tasks")
			.setDesc("Lines are added under this heading (created at the end of the note if missing). Leave empty to append at the end.")
			.addText((t) => t.setPlaceholder("Tasks").setValue(data.settings.noteHeading).onChange((v) => void this.plugin.setSettings({ noteHeading: v })));

		// ----- Today -----
		new Setting(containerEl).setName("Today").setHeading();
		new Setting(containerEl)
			.setName("Open Today on startup")
			.addToggle((t) => t.setValue(data.settings.openTodayOnStartup).onChange((v) => void this.plugin.setSettings({ openTodayOnStartup: v })));
		new Setting(containerEl)
			.setName("Focus limit")
			.setDesc("The most tasks you can put in a day's focus. Fewer is the point.")
			.addSlider((sl) => sl.setLimits(1, 10, 1).setValue(data.settings.focusLimit).onChange((v) => void this.plugin.setSettings({ focusLimit: v })));
		new Setting(containerEl)
			.setName("Gone quiet after")
			.setDesc("Open tasks untouched for this many days are listed as gone quiet.")
			.addSlider((sl) => sl.setLimits(3, 60, 1).setValue(data.settings.staleDays).onChange((v) => void this.plugin.setSettings({ staleDays: v })));

		new Setting(containerEl)
			.setName("Meetings note")
			.setDesc("Path of a note holding a calendar snapshot, shown as a meetings card in Today. Leave empty to hide the card.")
			.addText((t) => {
				t.setPlaceholder("Work/Outlook calendar.md").setValue(data.settings.meetingsNotePath);
				t.inputEl.addEventListener("blur", () => void this.plugin.setSettings({ meetingsNotePath: t.getValue().trim() }));
			});

		// ----- Morning suggestion -----
		new Setting(containerEl).setName("Morning suggestion").setHeading();
		new Setting(containerEl)
			.setName("Suggest my focus each day")
			.setDesc("Claude picks the few open tasks most worth doing today. The first device to open Obsidian each day asks; the rest receive it through Sync.")
			.addToggle((t) => t.setValue(data.settings.briefEnabled).onChange((v) => void this.plugin.setSettings({ briefEnabled: v })));
		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Chosen from Obsidian's Keychain, so the key stays on this device and is never written into the synced plugin data. Set it once per device that should be able to ask.")
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(data.settings.briefKeychainId)
					.onChange((v) => void this.plugin.setSettings({ briefKeychainId: v })),
			);
		const pause = new Setting(containerEl)
			.setName("Paused until")
			.setDesc(data.settings.briefPausedUntil ? `No suggestions before ${formatDate(data.settings.briefPausedUntil)}, on any device.` : "Pause suggestions while you're on leave. Applies to every device.")
			.addText((t) => bindDate(t.inputEl, data.settings.briefPausedUntil, async (v) => { await this.plugin.setSettings({ briefPausedUntil: v }); this.display(); }));
		if (data.settings.briefPausedUntil) {
			pause.addExtraButton((b) => b.setIcon("x").setTooltip("Resume now").onClick(() => void this.plugin.setSettings({ briefPausedUntil: null }).then(() => this.display())));
		}
		const last = data.today.suggestion;
		new Setting(containerEl)
			.setName("Suggest now")
			.setDesc(last ? `Last: ${formatDateTime(last.generatedAt)} · ${last.model}${last.source ? ` via ${last.source}` : ""}` : "No suggestion yet.")
			.addButton((b) => b.setButtonText("Suggest now").onClick(() => void this.plugin.maybeSuggest(true)));

		// ----- Scheduling -----
		new Setting(containerEl).setName("Timeline").setHeading();
		new Setting(containerEl)
			.setName("Schedule on working days")
			.setDesc("Durations skip weekends and the holidays below, so a 5-day task booked on a Thursday finishes the next Wednesday.")
			.addToggle((t) => t.setValue(data.settings.workingDaysOnly).onChange((v) => void this.plugin.setSettings({ workingDaysOnly: v })));
		new Setting(containerEl)
			.setName("Holidays")
			.setDesc("Non-working dates as YYYY-MM-DD, separated by commas or new lines.")
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setPlaceholder("2026-12-25, 2026-12-26").setValue((data.settings.holidays ?? []).join(", "));
				t.inputEl.addEventListener("blur", () => {
					const dates = t.getValue().split(/[\s,]+/).map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
					void this.plugin.setSettings({ holidays: Array.from(new Set(dates)).sort() });
				});
			});

		// ----- Backups -----
		new Setting(containerEl).setName("Backups").setHeading();
		new Setting(containerEl)
			.setName("Daily backups")
			.setDesc("A copy of the task data is kept in the plugin's backups folder once per day (last 7 kept). Use the \"Restore task data from a backup\" command to roll back.")
			.addButton((b) => b.setButtonText("Back up now").onClick(() => void this.plugin.writeBackup(true)));

		// ----- Types -----
		new Setting(containerEl).setName("Types").setHeading();
		new Setting(containerEl)
			.setName("Add type")
			.setDesc("A category such as Work, Personal, Errand…")
			.addText((t) => {
				t.setPlaceholder("New type name");
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key !== "Enter") return;
					void this.plugin.addType(t.getValue()).then((added) => { if (added) this.display(); });
				});
			})
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					const input = containerEl.querySelector<HTMLInputElement>("input[placeholder='New type name']");
					if (input && (await this.plugin.addType(input.value))) this.display();
				}),
			);

		if (data.types.length === 0) containerEl.createEl("p", { text: "No types yet.", cls: "setting-item-description" });
		for (const type of data.types) {
			new Setting(containerEl)
				.setName(type)
				.setDesc(`${count((t) => t.type === type)} task(s)`)
				.addExtraButton((b) =>
					b.setIcon("pencil").setTooltip("Rename").onClick(() =>
						new PromptModal(this.app, "Rename type", type, async (v) => { await this.plugin.renameType(type, v); this.display(); }).open(),
					),
				)
				.addExtraButton((b) =>
					b.setIcon("trash").setTooltip("Remove (tasks become uncategorised)").onClick(async () => {
						await this.plugin.removeType(type);
						this.display();
					}),
				);
		}

		// ----- Note pages -----
		new Setting(containerEl).setName("Note pages").setHeading();
		new Setting(containerEl)
			.setName("Add note page")
			.setDesc("Notes are also added here automatically when a task links to them.")
			.addButton((b) =>
				b.setButtonText("Choose note…").onClick(() =>
					new NotePickerModal(this.app, this.plugin, async (f) => { await this.plugin.addNote(f.path); this.display(); }).open(),
				),
			);

		if (data.notes.length === 0) containerEl.createEl("p", { text: "No note pages yet.", cls: "setting-item-description" });
		for (const note of [...data.notes].sort((a, b) => basename(a).localeCompare(basename(b)))) {
			new Setting(containerEl)
				.setName(basename(note))
				.setDesc(`${note} · ${count((t) => t.note === note)} task(s)`)
				.addExtraButton((b) => b.setIcon("file-text").setTooltip("Open note").onClick(() => this.plugin.openPath(note)))
				.addExtraButton((b) =>
					b.setIcon("trash").setTooltip("Remove from list (tasks are unlinked)").onClick(async () => {
						await this.plugin.removeNote(note);
						this.display();
					}),
				);
		}
	}
}
