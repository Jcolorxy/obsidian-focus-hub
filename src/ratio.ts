import { MarkdownPostProcessorContext } from "obsidian";

/**
 * A ```ratio code block: a live proportion calculator.
 *
 * ```ratio
 * title: Cold brew
 * coffee: 82 g
 * water: 946 ml
 * ```
 *
 * Every ingredient line becomes an input. Typing a new amount in any one of them
 * rescales the rest, keeping the ratio fixed.
 */
interface Part {
	label: string;
	base: number;
	unit: string;
}

interface Spec {
	title: string;
	parts: Part[];
	scales: number[];
}

const SCALE_DEFAULT = [0.5, 1, 2, 3];

export function parseRatio(source: string): Spec {
	const spec: Spec = { title: "", parts: [], scales: SCALE_DEFAULT };
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const at = line.indexOf(":");
		if (at < 0) continue;
		const key = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		if (key.toLowerCase() === "title") { spec.title = value; continue; }
		if (key.toLowerCase() === "scales") {
			const nums = value.split(/[,\s]+/).map((v) => Number(v.replace(/x$/i, ""))).filter((n) => n > 0);
			if (nums.length) spec.scales = nums;
			continue;
		}
		const m = /^(-?[\d.]+)\s*(.*)$/.exec(value);
		if (!m || !isFinite(Number(m[1]))) continue;
		spec.parts.push({ label: key, base: Number(m[1]), unit: m[2].trim() });
	}
	return spec;
}

/** Amounts stay readable: more decimals only where they matter. */
export function fmt(n: number): string {
	if (!isFinite(n)) return "";
	const abs = Math.abs(n);
	const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
	return Number(n.toFixed(dp)).toString();
}

/** "1 : 11.5" — each part relative to the first. */
export function ratioLabel(parts: Part[]): string {
	const first = parts[0]?.base;
	if (!first) return "";
	return parts.map((p) => fmt(p.base / first)).join(" : ");
}

export function renderRatio(source: string, el: HTMLElement, _ctx?: MarkdownPostProcessorContext) {
	const spec = parseRatio(source);
	const root = el.createDiv({ cls: "task-hub-ratio" });
	// In Live Preview the block is a CodeMirror widget: without this, CM takes the
	// pointer and key events and the inputs never see them.
	for (const type of ["mousedown", "mouseup", "click", "keydown", "keyup", "keypress", "beforeinput", "input", "touchstart"]) {
		root.addEventListener(type, (e) => e.stopPropagation());
	}
	root.setAttr("contenteditable", "false");
	if (!spec.parts.length) {
		root.createDiv({ cls: "task-hub-ratio-error", text: 'No ingredients found. Use lines like "coffee: 82 g".' });
		return;
	}
	const head = root.createDiv({ cls: "task-hub-ratio-head" });
	if (spec.title) head.createSpan({ cls: "task-hub-ratio-title", text: spec.title });
	// the fixed ratio, so an accidental edit of the block's numbers is visible
	head.createSpan({ cls: "task-hub-ratio-parts", text: ratioLabel(spec.parts) });

	const inputs: HTMLInputElement[] = [];
	const apply = (factor: number, except = -1) => {
		spec.parts.forEach((p, i) => {
			if (i === except) return;
			inputs[i].value = fmt(p.base * factor);
		});
		root.dataset.factor = String(factor);
		scaleBtns.forEach((b, i) => b.toggleClass("is-active", Math.abs(spec.scales[i] - factor) < 1e-9));
	};

	const grid = root.createDiv({ cls: "task-hub-ratio-grid" });
	spec.parts.forEach((part, i) => {
		const row = grid.createDiv({ cls: "task-hub-ratio-row" });
		row.createSpan({ cls: "task-hub-ratio-label", text: part.label });
		const input = row.createEl("input", {
			cls: "task-hub-ratio-input",
			type: "number",
			attr: { step: "any", min: "0", inputmode: "decimal" },
		});
		input.value = fmt(part.base);
		const recalc = () => {
			const v = Number(input.value);
			if (!input.value || !isFinite(v) || v <= 0) return;
			apply(v / part.base, i);
		};
		// "input" covers typing and the spinners; the others are belt-and-braces for
		// the embedded-widget case, where some events are delivered oddly.
		for (const type of ["input", "change", "keyup"]) input.addEventListener(type, recalc);
		input.addEventListener("focus", () => input.select());
		row.createSpan({ cls: "task-hub-ratio-unit", text: part.unit });
		inputs.push(input);
	});

	const bar = root.createDiv({ cls: "task-hub-ratio-scales" });
	const scaleBtns = spec.scales.map((s) => {
		const b = bar.createEl("button", { cls: "task-hub-ratio-scale", text: `${fmt(s)}×` });
		b.addEventListener("click", () => apply(s));
		return b;
	});
	const reset = bar.createEl("button", { cls: "task-hub-ratio-reset", text: "Reset" });
	reset.addEventListener("click", () => apply(1));

	apply(1);
}
