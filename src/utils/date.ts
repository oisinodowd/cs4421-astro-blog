export function formatDate(date: Date): string {
	return date.toLocaleDateString('en-us', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

/**
 * The calendar date (YYYY-MM-DD) at an instant, in a given IANA time zone.
 *
 * A slate belongs to a US/Eastern day: a 7pm tip-off in New York is already
 * tomorrow in UTC, and the ingest asks upstream about a calendar date rather
 * than an instant. Without this, the page would quietly ask about the wrong day
 * for the four hours either side of midnight UTC. The zone is a parameter so the
 * test can hold it still rather than depending on where the machine thinks it is.
 */
/**
 * "Oct 25, 2026" for a stored calendar date.
 *
 * Rendered in UTC on purpose: the date is a label for a day, not an instant, so
 * a machine west of Greenwich must not turn it into the day before.
 */
export function formatCalendarDate(day: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (match === null) return day;

	const [, year, month, date] = match;
	return new Date(Date.UTC(Number(year), Number(month) - 1, Number(date))).toLocaleDateString('en-us', {
		timeZone: 'UTC',
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

export function calendarDateIn(timeZone: string, at: number | Date = Date.now()): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(typeof at === 'number' ? new Date(at) : at);

	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}