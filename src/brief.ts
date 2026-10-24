import Anthropic from "@anthropic-ai/sdk";
import { Calendar, computeSchedule } from "./schedule";
import { FocusSuggestion, HubData, Task, isWeekend, isWorkTask, todayISO } from "./types";

export const MODEL = "claude-opus-5";

/**
 * Same instructions as the optional scheduled job (a separate script, not part of
 * this plugin), so a suggestion reads the same whichever device made it. Keep the
 * two in step.
 */
const SYSTEM = `You help one person decide what to work on today. They keep tasks in an \
Obsidian task manager; most tasks have no due date, so the hard part is choosing.

Pick the tasks most worth doing today — between 3 and the given limit, fewer if fewer \
are genuinely worth it. Weigh, roughly in this order:
- due today or overdue, then due within a few days
- scheduled on a project timeline to be underway today, especially ones other tasks wait on
- tasks that unblock others (see "blocks")
- long-running work showing little progress, and tasks untouched for a long time
Never pick tasks that are blocked by unfinished prerequisites or on hold.
Durations are working days; use planned_start and planned_end as given rather than \
recalculating them. Only call a task overdue if its due date is before today — a task \
with no due date is never overdue, however long it has sat.
On weekdays favour Work, keeping at most one Personal task. At weekends the list holds \
personal tasks only — choose among those and frame the summary as a day off work.

For each pick give a reason of at most 15 words that names the concrete fact behind it \
(the date, what it unblocks, how long it has sat). The summary is one or two plain \
sentences on the shape of the day. Write in British English.`;

const basenameOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/, "");

/** Open tasks as compact rows for the prompt, and the ids Claude may pick from. */
export function briefContext(data: HubData, today: string, cal: Calendar) {
	const byId = new Map(data.tasks.map((t) => [t.id, t]));
	// at the weekend Claude never sees work tasks, so it cannot pick one
	const open = data.tasks.filter((t) => t.status !== "closed" && !(isWeekend(today) && isWorkTask(t)));
	// real planned dates from the timeline engine, including tasks placed by prerequisites
	const planned = computeSchedule(
		data.tasks.filter((t) => t.start || t.due || t.durationDays || t.milestone || t.deps?.length),
		today,
		cal,
	);
	const dates = new Map(planned.map((r) => [r.task.id, r]));
	const blocks = new Map<string, string[]>();
	for (const t of open) for (const d of t.deps ?? []) blocks.set(d, [...(blocks.get(d) ?? []), t.title]);

	const rows: Record<string, unknown>[] = [];
	const ids: string[] = [];
	for (const t of open) {
		const unfinished = (t.deps ?? []).map((d) => byId.get(d)).filter((d): d is Task => !!d && d.status !== "closed");
		const r = dates.get(t.id);
		const row: Record<string, unknown> = {
			id: t.id,
			title: t.title,
			type: t.type,
			project: t.note ? basenameOf(t.note) : null,
			status: t.status,
			due: t.due,
			planned_start: r?.start,
			planned_end: r?.end,
			progress_pct: t.percent,
			untouched_days: Math.floor((Date.now() - (t.updated ?? t.created)) / 86400000),
			blocked_by: unfinished.length ? unfinished.map((d) => d.title) : null,
			blocks: blocks.get(t.id) ?? null,
			latest_comment: t.comments.length ? t.comments[t.comments.length - 1].text.slice(0, 160) : null,
		};
		rows.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)));
		if (!unfinished.length && t.status !== "hold") ids.push(t.id);
	}
	return { rows, ids };
}

/** Ids restricted to real, workable tasks — the model cannot invent one or pick a blocked one. */
function schema(ids: string[]) {
	return {
		type: "object",
		properties: {
			summary: { type: "string" },
			items: {
				type: "array",
				items: {
					type: "object",
					properties: { id: { type: "string", enum: ids }, reason: { type: "string" } },
					required: ["id", "reason"],
					additionalProperties: false,
				},
			},
		},
		required: ["summary", "items"],
		additionalProperties: false,
	};
}

/** One call to Claude; throws on refusal, truncation or API errors. */
export async function generateSuggestion(data: HubData, cal: Calendar, apiKey: string): Promise<FocusSuggestion> {
	const today = todayISO();
	const { rows, ids } = briefContext(data, today, cal);
	const limit = data.settings.focusLimit;
	if (!ids.length) {
		return { date: today, items: [], summary: "Nothing open is ready to work on today.", generatedAt: Date.now(), model: MODEL, source: "Obsidian" };
	}
	const weekday = new Date(today + "T00:00").toLocaleDateString("en-GB", { weekday: "long" });

	// Obsidian runs in a web context; the key comes from this device's Keychain
	const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
	const response = await client.beta.messages.create({
		model: MODEL,
		max_tokens: 16000,
		system: SYSTEM,
		messages: [{ role: "user", content: `Today is ${weekday} ${today}. Pick at most ${limit} tasks.\n\nOpen tasks:\n${JSON.stringify(rows, null, 1)}` }],
		output_config: { effort: "medium", format: { type: "json_schema", schema: schema(ids) } },
		// if a safety classifier declines, Anthropic re-runs the request on a suitable model
		betas: ["server-side-fallback-2026-07-01"],
		fallbacks: "default",
	});
	if (response.stop_reason === "refusal") throw new Error("Claude declined to answer");
	if (response.stop_reason === "max_tokens") throw new Error("the response was cut off");

	const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
	const parsed = JSON.parse(text) as { summary: string; items: { id: string; reason: string }[] };
	const seen = new Set<string>();
	const items = parsed.items
		.filter((i) => ids.includes(i.id) && !seen.has(i.id) && seen.add(i.id))
		.map((i) => ({ id: i.id, reason: i.reason.trim() }))
		.slice(0, limit);
	return { date: today, items, summary: parsed.summary.trim(), generatedAt: Date.now(), model: response.model, source: "Obsidian" };
}
