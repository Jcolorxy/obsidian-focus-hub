import { App, Modal } from "obsidian";

/** Structured prompts, stored as one ordinary close-out comment for old clients and note mirroring. */
export class CompletionModal extends Modal {
	private submitted = false;
	constructor(app: App, private title: string, private onSubmit: (text: string | null) => void) { super(app); }
	onOpen() {
		const el = this.contentEl;
		el.addClass("th-completion");
		el.createEl("h3", { text: "Completion reflection" });
		el.createEl("p", { cls: "th-completion-title", text: this.title });
		el.createEl("p", { cls: "setting-item-description", text: "Task stays closed if you skip or dismiss this reflection. Focus Hub uses tasks linked to project notes, so these prompts apply to tasks and project work alike." });
		const fields: [string, string][] = [
			["Result / what changed", "What was delivered, resolved or changed?"],
			["My contribution", "What did you personally do?"],
			["Measurable impact / evidence", "Optional — verified figures, observations or a reference. Leave blank if unknown; do not invent a result."],
		];
		const inputs = fields.map(([label, hint]) => {
			const wrap = el.createEl("label", { cls: "th-completion-field", text: label });
			wrap.createSpan({ cls: "setting-item-description", text: hint });
			return wrap.createEl("textarea", { attr: { rows: "3", "aria-label": label } });
		});
		const save = () => this.submit(inputs.map((input, i) => input.value.trim() ? `${fields[i][0]}:\n${input.value.trim()}` : "").filter(Boolean).join("\n\n") || null);
		el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.submit(null); }
		});
		const actions = el.createDiv({ cls: "th-completion-actions" });
		actions.createEl("button", { text: "Skip reflection" }).addEventListener("click", () => this.submit(null));
		actions.createEl("button", { text: "Save reflection", cls: "mod-cta" }).addEventListener("click", save);
		el.createEl("p", { cls: "setting-item-description", text: "All fields are optional. Ctrl/Cmd+Enter to save · Esc to skip. Saved as a close-out comment; earlier comments are kept." });
		inputs[0].focus();
	}
	private submit(text: string | null) {
		if (this.submitted) return;
		this.submitted = true;
		this.onSubmit(text);
		this.close();
	}
	onClose() {
		if (!this.submitted) { this.submitted = true; this.onSubmit(null); }
		this.contentEl.empty();
	}
}
