/**
 * Calendar dates (completion months, "today's" meetings) are bucketed in the
 * device's own time zone. Tests pin it by setting `globalThis.TASK_HUB_TZ` before
 * the module loads, so they don't depend on where they run.
 */
export const LOCAL_TIMEZONE: string =
	(globalThis as { TASK_HUB_TZ?: string }).TASK_HUB_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
