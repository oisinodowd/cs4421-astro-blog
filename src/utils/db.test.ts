import { describe, expect, it } from 'vitest';

import {
	classifyError,
	createSupabaseClient,
	failure,
	isRecord,
	notConfigured,
	readNumber,
	readString,
	success,
} from './db';

// Nothing below reaches a network: `createClient` only builds an object, and no
// test issues a request through it. The suite has no credentials either.
const CONFIGURED = {
	SUPABASE_URL: 'https://example.supabase.co',
	SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

describe('createSupabaseClient', () => {
	it('returns null when neither credential is set, which is a supported state', () => {
		expect(createSupabaseClient({})).toBeNull();
	});

	it('returns null when only the URL is set', () => {
		expect(createSupabaseClient({ SUPABASE_URL: CONFIGURED.SUPABASE_URL })).toBeNull();
	});

	it('returns null when only the key is set', () => {
		expect(createSupabaseClient({ SUPABASE_SERVICE_ROLE_KEY: CONFIGURED.SUPABASE_SERVICE_ROLE_KEY })).toBeNull();
	});

	it('treats a blank value as absent', () => {
		expect(createSupabaseClient({ ...CONFIGURED, SUPABASE_SERVICE_ROLE_KEY: '   ' })).toBeNull();
	});

	it('builds a client when both credentials are present', () => {
		const client = createSupabaseClient(CONFIGURED);
		expect(client).not.toBeNull();
		expect(typeof client?.from).toBe('function');
		expect(typeof client?.rpc).toBe('function');
	});

	it('accepts a trailing slash on the URL, which the dependency probe also tolerates', () => {
		expect(createSupabaseClient({ ...CONFIGURED, SUPABASE_URL: 'https://example.supabase.co/' })).not.toBeNull();
	});
});

describe('classifyError', () => {
	it('reads a transport failure as unavailable: nothing answered', () => {
		const error = classifyError({ message: 'TypeError: fetch failed' });
		expect(error.code).toBe('unavailable');
		expect(error.message).toBe('TypeError: fetch failed');
	});

	it('reads a permission failure as denied', () => {
		expect(classifyError({ message: 'permission denied for table sessions', code: '42501' }).code).toBe(
			'denied',
		);
	});

	it('reads PGRST116 as not-found, which is how an unknown id comes back', () => {
		expect(classifyError({ message: 'multiple (or no) rows returned', code: 'PGRST116' }).code).toBe(
			'not-found',
		);
	});

	it('reads any other code as a plain error', () => {
		expect(classifyError({ message: 'duplicate key value', code: '23505' }).code).toBe('error');
	});

	it('truncates a long message so a log line cannot be flooded', () => {
		const error = classifyError({ message: 'x'.repeat(5000), code: '23505' });
		expect(error.message).toHaveLength(200);
	});

	it('invents a message when the error carries none', () => {
		expect(classifyError(null).message).toBe('the database returned an error');
		expect(classifyError(undefined).code).toBe('unavailable');
	});
});

describe('results', () => {
	it('success carries a value', () => {
		expect(success(7)).toEqual({ ok: true, value: 7 });
	});

	it('failure carries a code and a message', () => {
		expect(failure('error', 'nope')).toEqual({ ok: false, error: { code: 'error', message: 'nope' } });
	});

	it('notConfigured names the two variables a container is missing', () => {
		const result = notConfigured();
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe('not-configured');
		expect(result.error.message).toContain('SUPABASE_URL');
	});
});

describe('reading values that came out of JSON', () => {
	it('isRecord rejects arrays and null', () => {
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord('row')).toBe(false);
	});

	it('readString trims and treats an empty field as absent', () => {
		expect(readString('  Oisin ')).toBe('Oisin');
		expect(readString('')).toBeNull();
		expect(readString('   ')).toBeNull();
		expect(readString(42)).toBeNull();
	});

	it('readNumber accepts a numeric string, which is what a form posts', () => {
		expect(readNumber('45')).toBe(45);
		expect(readNumber(45)).toBe(45);
		expect(readNumber(' 45.5 ')).toBe(45.5);
	});

	it('readNumber rejects what is not a finite number', () => {
		expect(readNumber('')).toBeNull();
		expect(readNumber('forty five')).toBeNull();
		expect(readNumber(Number.NaN)).toBeNull();
		expect(readNumber(Number.POSITIVE_INFINITY)).toBeNull();
		expect(readNumber(null)).toBeNull();
	});
});
