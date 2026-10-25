/**
 * Calendar dates (completion months, "today's" meetings) are bucketed in the
 * device's own time zone. Tests pin it with `process.env.TZ` before the module
 * loads, so they don't depend on where they run.
 */
export const LOCAL_TIMEZONE: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
