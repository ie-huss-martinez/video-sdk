/**
 * The date a plan's `date` metadata names, as midnight UTC, or `undefined`
 * when it isn't a real calendar date written `YYYY-MM-DD`, the only kind a
 * container stores (ADR 0005, docs/adr/0008). An export writes the date
 * only when this gives one, and the editor says so when it doesn't.
 *
 * It's strict where `Date` isn't: `Date` rolls an impossible day over, so
 * "2025-02-31" would become 3 March, a date the user never set. Here a date
 * must come back as the same year, month and day.
 *
 * @internal
 */
export function metadataDate(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC reads years 0 to 99 as 1900 to 1999: set the year itself.
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : undefined;
}
