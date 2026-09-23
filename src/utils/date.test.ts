import { describe, expect, it } from 'vitest';

import { formatDate } from './date';

describe('formatDate', () => {
	it('formats a date with a short month and numeric day', () => {
		expect(formatDate(new Date(2026, 8, 21))).toBe('Sep 21, 2026');
	});

	it('formats dates at the start of a new year', () => {
		expect(formatDate(new Date(2027, 0, 1))).toBe('Jan 1, 2027');
	});
});