import { LOCAL_TIMEZONE } from "./zone";

export const MEETINGS_TIMEZONE = LOCAL_TIMEZONE;

/** Today's date (YYYY-MM-DD) in the device's time zone. */
export function localDate(now = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: MEETINGS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
	}).formatToParts(now);
	const part = (type: string) => parts.find((p) => p.type === type)!.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Presentation only: keep the snapshot parser's plain-text rows unchanged. */
export function meetingDetails(row: string) {
	const match = /^(?:(All day)|([0-2]\d:[0-5]\d)–([0-2]\d:[0-5]\d)) — (.+)$/.exec(row);
	if (!match || (!match[1] && (Number(match[2].slice(0, 2)) > 23 || Number(match[3].slice(0, 2)) > 23))) return null;
	const parts = match[4].split(" — ");
	return { allDay: !!match[1], start: match[2], end: match[3], title: parts.length === 2 ? parts[0] : match[4], location: parts.length === 2 ? parts[1] : "" };
}

/** The rolling note is a plain-text snapshot, never rendered as HTML. */
export function parseMeetings(markdown: string, date: string) {
	const context: string[] = [];
	const rows: string[] = [];
	let inHeader = true, selected = false, found = false;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^##\s/.test(line)) {
			inHeader = false;
			selected = line.trim() === `## ${date}`;
			if (selected) found = true;
		} else if (inHeader && line.trim() && !/^#\s/.test(line) && !/^\s*<!--/.test(line)) {
			context.push(line.trim());
		} else if (selected && line.startsWith("- ")) {
			rows.push(line.slice(2));
		}
	}
	// CommonMark backslash escapes apply only to ASCII punctuation.
	const plain = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
	return { context: plain(context.join(" ")), found, rows: rows.map(plain) };
}
