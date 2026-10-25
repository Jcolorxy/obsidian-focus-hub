import type TaskHubPlugin from "./main";
import { Band, GanttOptions, banded, prepareRows, progressOf } from "./ganttview";
import { Scheduled, addDays, diffDays, isWorkday, parseISO } from "./schedule";
import { formatDate } from "./types";

/**
 * Draws the timeline as a standalone SVG — no stylesheet, no Obsidian — so the file
 * can be mailed, pasted into a slide or opened anywhere. Colours are the same fixed
 * light set used for printing, checked for colourblind separation against white.
 */
const C = {
	ink: "#1a1a1a",
	muted: "#555555",
	faint: "#777777",
	line: "#dddddd",
	lineStrong: "#bbbbbb",
	surface: "#ffffff",
	band: "#f2f2f2",
	nonWorking: "#f4f4f4",
	today: "#444444",
	open: "#2d6cdf",
	hold: "#c1750f",
	closed: "#1f8a70",
	critical: "#d03b3b",
	baseline: "#999999",
	summary: "#555555",
};

const ROW_H = 28;
const HEAD_H = 44;
const SIDE_W = 230;
const PAD = 14;
const SLACK = 150;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough text width at a given size; good enough for truncation. */
const textWidth = (s: string, size: number) => s.length * size * 0.56;

function truncate(s: string, size: number, max: number): string {
	if (textWidth(s, size) <= max) return s;
	let out = s;
	while (out.length > 1 && textWidth(out + "…", size, ) > max) out = out.slice(0, -1);
	return out + "…";
}

const statusColour = (r: Scheduled) => (r.task.status === "closed" ? C.closed : r.task.status === "hold" ? C.hold : C.open);

export function ganttToSvg(plugin: TaskHubPlugin, o: GanttOptions, targetWidth = 1400): string {
	const { rows, all, cal, today, from, to } = prepareRows(plugin, o);
	if (!rows.length) return "";

	const bands = banded(rows, o.group);
	const days = Math.max(1, diffDays(from, to) + 1);
	const chartW = Math.max(targetWidth - SIDE_W - SLACK - PAD * 2, 320);
	const px = chartW / days;
	const x = (iso: string) => SIDE_W + diffDays(from, iso) * px;

	// vertical layout: a line per band header plus one per task
	const lines: ({ kind: "band"; band: Band } | { kind: "row"; row: Scheduled })[] = [];
	for (const band of bands) {
		if (band.label) lines.push({ kind: "band", band });
		for (const row of band.rows) lines.push({ kind: "row", row });
	}
	const bodyH = lines.length * ROW_H;
	const titleH = o.title ? 26 : 0;
	const legendH = 26;
	const width = SIDE_W + chartW + SLACK;
	const height = titleH + HEAD_H + bodyH + legendH + PAD;
	const yOf = (i: number) => titleH + HEAD_H + i * ROW_H;
	const rowIndex = new Map<string, number>();
	lines.forEach((l, i) => { if (l.kind === "row") rowIndex.set(l.row.task.id, i); });

	const out: string[] = [];
	out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" font-family="${FONT}">`);
	out.push(`<rect width="100%" height="100%" fill="${C.surface}"/>`);
	out.push(`<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${C.faint}"/></marker></defs>`);

	if (o.title) out.push(`<text x="${PAD}" y="18" font-size="13" font-weight="600" fill="${C.ink}">${esc(o.title)}</text>`);

	// non-working shading and grid
	for (let i = 0; i < days; i++) {
		const iso = addDays(from, i);
		const d = parseISO(iso);
		if (!isWorkday(iso, cal)) {
			out.push(`<rect x="${x(iso).toFixed(1)}" y="${titleH + HEAD_H}" width="${px.toFixed(2)}" height="${bodyH}" fill="${C.nonWorking}"/>`);
		}
		const first = d.getDate() === 1;
		if (first || d.getDay() === 1) {
			out.push(`<line x1="${x(iso).toFixed(1)}" y1="${titleH + HEAD_H - 10}" x2="${x(iso).toFixed(1)}" y2="${titleH + HEAD_H + bodyH}" stroke="${first ? C.lineStrong : C.line}" stroke-width="1"/>`);
		}
	}

	// month band and day/week ticks
	let cursor = from;
	while (cursor <= to) {
		const d = parseISO(cursor);
		const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
		const endISO = monthEnd > parseISO(to) ? to : `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, "0")}-${String(monthEnd.getDate()).padStart(2, "0")}`;
		out.push(`<text x="${(x(cursor) + 4).toFixed(1)}" y="${titleH + 14}" font-size="11" font-weight="600" fill="${C.muted}">${esc(d.toLocaleDateString(undefined, { month: "short", year: "numeric" }))}</text>`);
		cursor = addDays(endISO, 1);
	}
	const tickEvery = px >= 16 ? 1 : px >= 5 ? 7 : 28;
	for (let i = 0; i < days; i++) {
		const iso = addDays(from, i);
		const d = parseISO(iso);
		if (tickEvery === 1 || (tickEvery === 7 && d.getDay() === 1) || (tickEvery === 28 && d.getDate() === 1)) {
			out.push(`<text x="${(x(iso) + px / 2).toFixed(1)}" y="${titleH + 32}" font-size="9" fill="${C.faint}" text-anchor="middle">${d.getDate()}</text>`);
		}
	}
	out.push(`<line x1="${SIDE_W}" y1="${titleH + HEAD_H}" x2="${SIDE_W}" y2="${titleH + HEAD_H + bodyH}" stroke="${C.lineStrong}"/>`);
	out.push(`<line x1="0" y1="${titleH + HEAD_H}" x2="${width}" y2="${titleH + HEAD_H}" stroke="${C.lineStrong}"/>`);

	// rows
	lines.forEach((line, i) => {
		const y = yOf(i);
		const mid = y + ROW_H / 2;
		if (line.kind === "band") {
			const band = line.band;
			out.push(`<rect x="0" y="${y}" width="${width}" height="${ROW_H}" fill="${C.band}"/>`);
			out.push(`<text x="${PAD}" y="${mid + 4}" font-size="11" font-weight="600" fill="${C.ink}">${esc(truncate(band.label, 11, SIDE_W - PAD * 2 - 20))}</text>`);
			const start = band.rows.reduce((acc, r) => (r.start < acc ? r.start : acc), band.rows[0].start);
			const end = band.rows.reduce((acc, r) => (r.end > acc ? r.end : acc), band.rows[0].end);
			const bx = x(start);
			const bw = Math.max(x(addDays(end, 1)) - bx - 1, 4);
			out.push(`<rect x="${bx.toFixed(1)}" y="${mid - 4}" width="${bw.toFixed(1)}" height="8" fill="${C.summary}" opacity="0.55" rx="2"/>`);
			const pct = Math.round(band.rows.reduce((acc, r) => acc + progressOf(r.task), 0) / band.rows.length);
			out.push(`<text x="${(bx + bw + 6).toFixed(1)}" y="${mid + 3}" font-size="9" fill="${C.faint}">${pct}%</text>`);
			return;
		}

		const r = line.row;
		const colour = statusColour(r);
		const indent = bands.some((b) => b.label) ? 16 : 0;
		const meta = [r.task.owner, o.critical && r.critical ? "critical" : r.float > 0 ? `${r.float}d float` : ""].filter(Boolean).join(" · ");
		const labelMax = SIDE_W - PAD * 2 - indent;
		if (meta) {
			out.push(`<text x="${PAD + indent}" y="${mid - 1}" font-size="10.5" fill="${C.ink}">${esc(truncate(r.task.title, 10.5, labelMax))}</text>`);
			out.push(`<text x="${PAD + indent}" y="${mid + 10}" font-size="8.5" fill="${C.faint}">${esc(truncate(meta, 8.5, labelMax))}</text>`);
		} else {
			out.push(`<text x="${PAD + indent}" y="${mid + 4}" font-size="10.5" fill="${C.ink}">${esc(truncate(r.task.title, 10.5, labelMax))}</text>`);
		}
		out.push(`<line x1="0" y1="${y + ROW_H}" x2="${width}" y2="${y + ROW_H}" stroke="${C.line}" stroke-width="0.5"/>`);

		if (o.baseline && r.task.baseline) {
			const bx = x(r.task.baseline.start);
			const bw = Math.max(x(addDays(r.task.baseline.end, 1)) - bx - 1, 3);
			out.push(`<rect x="${bx.toFixed(1)}" y="${mid + 6}" width="${bw.toFixed(1)}" height="3.5" fill="${C.baseline}" rx="1.5"/>`);
		}

		const bx = x(r.start);
		if (r.task.milestone) {
			const s = 6;
			out.push(`<path d="M ${bx.toFixed(1)} ${mid - s} L ${(bx + s).toFixed(1)} ${mid} L ${bx.toFixed(1)} ${mid + s} L ${(bx - s).toFixed(1)} ${mid} Z" fill="${colour}"${o.critical && r.critical ? ` stroke="${C.critical}" stroke-width="1.5"` : ""}/>`);
			out.push(`<text x="${(bx + s + 5).toFixed(1)}" y="${mid + 3.5}" font-size="10" fill="${C.ink}">${esc(r.task.title)}</text>`);
		} else {
			const bw = Math.max(x(addDays(r.end, 1)) - bx - 1, 4);
			// being past the due date is the more actionable signal, so it wins the
			// outline; membership of the critical path still shows in the arrows and label
			const outline = r.lateVsDue
				? ` stroke="${C.critical}" stroke-width="1.5" stroke-dasharray="3 2"`
				: o.critical && r.critical
					? ` stroke="${C.critical}" stroke-width="1.5"`
					: "";
			out.push(`<rect x="${bx.toFixed(1)}" y="${mid - 7}" width="${bw.toFixed(1)}" height="14" rx="3" fill="${colour}"${outline}/>`);
			const pct = progressOf(r.task);
			if (pct > 0) {
				out.push(`<rect x="${bx.toFixed(1)}" y="${mid - 7}" width="${((bw * pct) / 100).toFixed(1)}" height="14" rx="3" fill="#000000" opacity="0.28"/>`);
			}
			const label = r.task.title + (pct > 0 && pct < 100 ? ` (${pct}%)` : "");
			if (textWidth(label, 10) + 10 < bw) {
				out.push(`<text x="${(bx + 5).toFixed(1)}" y="${mid + 3.5}" font-size="10" fill="#ffffff">${esc(label)}</text>`);
			} else {
				out.push(`<text x="${(bx + bw + 5).toFixed(1)}" y="${mid + 3.5}" font-size="10" fill="${C.ink}">${esc(label)}</text>`);
			}
		}
	});

	// dependency arrows
	const byId = new Map(all.map((r) => [r.task.id, r]));
	for (const r of rows) {
		const toIdx = rowIndex.get(r.task.id);
		if (toIdx === undefined) continue;
		for (const depId of r.deps) {
			const fromIdx = rowIndex.get(depId);
			const dep = byId.get(depId);
			if (fromIdx === undefined || !dep) continue;
			const x1 = x(addDays(dep.end, 1)) - 1;
			const y1 = yOf(fromIdx) + ROW_H / 2;
			const x2 = x(r.start) - (r.task.milestone ? 7 : 0);
			const y2 = yOf(toIdx) + ROW_H / 2;
			const yMid = (y1 + y2) / 2;
			const crit = o.critical && r.critical && dep.critical;
			out.push(
				`<path d="M ${x1.toFixed(1)} ${y1} H ${(x1 + 7).toFixed(1)} V ${yMid} H ${(x2 - 7).toFixed(1)} V ${y2} H ${(x2 - 2).toFixed(1)}" fill="none" stroke="${crit ? C.critical : C.faint}" stroke-width="1.2" marker-end="url(#arrow)"/>`,
			);
		}
	}

	// today marker — named in the legend rather than inline, where the label would
	// sit on top of the date ticks
	const showToday = today >= from && today <= to;
	if (showToday) {
		const tx = x(today) + px / 2;
		out.push(`<line x1="${tx.toFixed(1)}" y1="${titleH + HEAD_H}" x2="${tx.toFixed(1)}" y2="${titleH + HEAD_H + bodyH}" stroke="${C.today}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
	}

	// legend
	const legendY = titleH + HEAD_H + bodyH + 17;
	let lx = PAD;
	const chip = (colour: string, label: string, shape: "rect" | "diamond" | "line" | "dashed" | "outline" = "rect") => {
		if (shape === "diamond") {
			out.push(`<path d="M ${lx + 5} ${legendY - 8} L ${lx + 10} ${legendY - 3.5} L ${lx + 5} ${legendY + 1} L ${lx} ${legendY - 3.5} Z" fill="${colour}"/>`);
		} else if (shape === "line") {
			out.push(`<rect x="${lx}" y="${legendY - 5}" width="12" height="3" rx="1.5" fill="${colour}"/>`);
		} else if (shape === "dashed") {
			out.push(`<line x1="${lx + 6}" y1="${legendY - 10}" x2="${lx + 6}" y2="${legendY + 2}" stroke="${colour}" stroke-width="1.5" stroke-dasharray="3 2"/>`);
		} else if (shape === "outline") {
			out.push(`<rect x="${lx}" y="${legendY - 8}" width="10" height="9" rx="2" fill="none" stroke="${colour}" stroke-width="1.5" stroke-dasharray="3 2"/>`);
		} else {
			out.push(`<rect x="${lx}" y="${legendY - 8}" width="10" height="9" rx="2" fill="${colour}"/>`);
		}
		out.push(`<text x="${lx + 15}" y="${legendY}" font-size="9.5" fill="${C.muted}">${esc(label)}</text>`);
		lx += 15 + textWidth(label, 9.5) + 18;
	};
	chip(C.open, "Open");
	chip(C.hold, "On Hold");
	chip(C.closed, "Closed");
	chip(C.summary, "Milestone", "diamond");
	if (o.critical) chip(C.critical, "Critical path", "line");
	if (o.baseline && rows.some((r) => r.task.baseline)) chip(C.baseline, "Baseline", "line");
	if (rows.some((r) => r.lateVsDue)) chip(C.critical, "Past its due date", "outline");
	if (showToday) chip(C.today, "Today", "dashed");
	const stamp = new Date();
	out.push(`<text x="${width - PAD}" y="${legendY}" font-size="9" fill="${C.faint}" text-anchor="end">${esc(formatDate(`${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`))}</text>`);

	out.push("</svg>");
	return out.join("\n");
}

/** Rasterise an SVG string to PNG bytes at `scale`× size. */
export async function svgToPng(svg: string, scale = 2): Promise<ArrayBuffer> {
	const size = /width="(\d+)" height="(\d+)"/.exec(svg);
	const w = Number(size?.[1] ?? 1400);
	const h = Number(size?.[2] ?? 600);
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	const img = new Image();
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error("could not render the chart"));
		img.src = url;
	});
	const canvas = createEl("canvas");
	canvas.width = Math.round(w * scale);
	canvas.height = Math.round(h * scale);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no canvas context");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("could not encode the PNG");
	return blob.arrayBuffer();
}
