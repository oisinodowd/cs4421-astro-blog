import { describe, expect, it } from 'vitest';

import { calendarDateIn, formatCalendarDate, formatDate } from './date';

describe('formatDate', () => {
	it('formats a date with a short month and numeric day', () => {
		expect(formatDate(new Date(2026, 8, 21))).toBe('Sep 21, 2026');
	});

	it('formats dates at the start of a new year', () => {
		expect(formatDate(new Date(2027, 0, 1))).toBe('Jan 1, 2027');
	});
});

describe('formatCalendarDate', () => {
	it('formats a stored date without moving it a day', () => {
		expect(formatCalendarDate('2026-10-25')).toBe('Oct 25, 2026');
		expect(formatCalendarDate('2027-01-01')).toBe('Jan 1, 2027');
	});

	it('passes something that is not a calendar date through unchanged', () => {
		expect(formatCalendarDate('next tuesday')).toBe('next tuesday');
		expect(formatCalendarDate('2026-02-30')).toBe('Mar 2, 2026');
	});
});

describe('calendarDateIn', () => {
	it('answers the day in the zone asked about, not the UTC day', () => {
		const lateEvening = Date.parse('2026-10-28T03:30:00.000Z');
		expect(calendarDateIn('UTC', lateEvening)).toBe('2026-10-28');
		expect(calendarDateIn('America/New_York', lateEvening)).toBe('2026-10-27');
	});

	it('follows the zone across the days the clocks change', () => {
		// 04:30Z is 23:30 the evening before in New York in January (EST) and
		// 00:30 the same morning in July (EDT).
		expect(calendarDateIn('America/New_York', Date.parse('2026-01-15T04:30:00.000Z'))).toBe('2026-01-14');
		expect(calendarDateIn('America/New_York', Date.parse('2026-07-15T04:30:00.000Z'))).toBe('2026-07-15');
	});

	it('pads a single-digit month and day, so the result is a calendar date', () => {
		expect(calendarDateIn('UTC', Date.parse('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05');
	});

	it('accepts a Date as well as a timestamp', () => {
		expect(calendarDateIn('UTC', new Date('2026-10-27T23:59:59.000Z'))).toBe('2026-10-27');
	});

	it('can cross a day that UTC has not reached yet', () => {
		expect(calendarDateIn('Asia/Tokyo', Date.parse('2026-10-27T20:00:00.000Z'))).toBe('2026-10-28');
	});
});