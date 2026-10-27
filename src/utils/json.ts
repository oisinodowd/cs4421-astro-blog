/**
 * Readers for values of unknown provenance (#95, #97).
 *
 * A row out of PostgREST and a payload out of balldontlie arrive the same way:
 * as JSON nobody has type-checked. Both the database stores and the upstream
 * client read them through here, which is why this is its own module rather than
 * a corner of `db.ts` -- the client should not have to import the database client
 * to read a number.
 *
 * Each reader answers `null` rather than throwing, so a caller decides whether a
 * missing field is a refusal or just an absence.
 */

/** JSON of unknown provenance: not a shape until it is read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed, non-empty string, or null. An empty form field arrives as ''. */
export function readString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/** A finite number, or null. Numeric form fields arrive as strings. */
export function readNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A `YYYY-MM-DD` string that is also a real date: 2026-02-30 is not one, and a
 * date that rolls over would be stored as a different day than it reads as.
 */
export function readCalendarDate(value: unknown): string | null {
	const text = readString(value);
	if (text === null) return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (match === null) return null;

	const [, yearText = '', monthText = '', dayText = ''] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const asDate = new Date(Date.UTC(year, month - 1, day));
	const isReal =
		asDate.getUTCFullYear() === year &&
		asDate.getUTCMonth() === month - 1 &&
		asDate.getUTCDate() === day;
	return isReal ? text : null;
}

/** Truncate a message that came from somewhere else, so a log line cannot flood. */
export function readMessage(value: unknown, limit = 200): string {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text === '') return '';
	return text.length > limit ? text.slice(0, limit) : text;
}
