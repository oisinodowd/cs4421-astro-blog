import { describe, expect, it } from 'vitest';

import {
	createSession,
	deleteSession,
	getSession,
	listSessions,
	parseSessionInput,
	updateSession,
	type SessionInput,
} from './sessions';
import { FakeSupabase } from './testing/fake-supabase';

const SESSION_ID = '6a1f0f5e-6d2c-4d0e-9a4b-8f3f0f7c1234';

/** A row exactly as PostgREST returns it, drills embedded. */
const SESSION_ROW = {
	id: SESSION_ID,
	trainee: 'Oisin',
	session_date: '2026-10-27',
	duration_min: 45,
	feel: 'good',
	notes: null,
	created_at: '2026-10-27T18:00:00.000Z',
	session_drills: [
		{
			id: 1,
			drill_slug: 'free-throw-block',
			sets: null,
			reps: null,
			makes: 38,
			attempts: 50,
			weight_kg: null,
		},
	],
};

/** The same session as a form posts it: values as strings, an empty note. */
const FORM_PAYLOAD = {
	trainee: '  Oisin ',
	session_date: '2026-10-27',
	duration_min: '45',
	feel: 'good',
	notes: '',
	drills: [{ drill_slug: 'free-throw-block', makes: '38', attempts: '50' }],
};

// Every measure is present after parsing, null where nothing was logged, because
// that is the row shape the store writes.
const PARSED: SessionInput = {
	trainee: 'Oisin',
	session_date: '2026-10-27',
	duration_min: 45,
	feel: 'good',
	notes: null,
	drills: [
		{
			drill_slug: 'free-throw-block',
			sets: null,
			reps: null,
			makes: 38,
			attempts: 50,
			weight_kg: null,
		},
	],
};

describe('parseSessionInput', () => {
	it('accepts a form-shaped payload and types it', () => {
		const result = parseSessionInput(FORM_PAYLOAD);
		expect(result).toEqual({ ok: true, value: PARSED });
	});

	it('accepts a payload that is already typed, not only strings', () => {
		const result = parseSessionInput({ ...PARSED, notes: 'legs heavy' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.duration_min).toBe(45);
		expect(result.value.notes).toBe('legs heavy');
	});

	it('accepts a session with no drills logged', () => {
		const result = parseSessionInput({ ...FORM_PAYLOAD, drills: [] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.drills).toEqual([]);
	});

	it('reports every problem at once rather than the first', () => {
		const result = parseSessionInput({ trainee: '', session_date: 'nope', duration_min: '0', feel: 'wiped' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems).toHaveLength(4);
	});

	it('refuses a trainee name that is empty or too long', () => {
		for (const trainee of ['', '   ', 'x'.repeat(41)]) {
			expect(parseSessionInput({ ...FORM_PAYLOAD, trainee }).ok, `trainee ${JSON.stringify(trainee)}`).toBe(
				false,
			);
		}
		expect(parseSessionInput({ ...FORM_PAYLOAD, trainee: 'x'.repeat(40) }).ok).toBe(true);
	});

	it('refuses a date that is not a real calendar date', () => {
		for (const session_date of ['2026-02-30', '2026-13-01', '27-10-2026', '2026-10-27T00:00:00Z', '']) {
			expect(parseSessionInput({ ...FORM_PAYLOAD, session_date }).ok, session_date).toBe(false);
		}
		expect(parseSessionInput({ ...FORM_PAYLOAD, session_date: '2024-02-29' }).ok).toBe(true);
	});

	it('refuses a duration outside the table check, and a fractional one', () => {
		for (const duration_min of [0, 601, 45.5, -3, 'forty']) {
			expect(parseSessionInput({ ...FORM_PAYLOAD, duration_min }).ok, String(duration_min)).toBe(false);
		}
		expect(parseSessionInput({ ...FORM_PAYLOAD, duration_min: 600 }).ok).toBe(true);
	});

	it('refuses a feel that is not one of the four', () => {
		expect(parseSessionInput({ ...FORM_PAYLOAD, feel: 'exhausted' }).ok).toBe(false);
	});

	it('refuses notes longer than the column allows', () => {
		expect(parseSessionInput({ ...FORM_PAYLOAD, notes: 'x'.repeat(2001) }).ok).toBe(false);
		expect(parseSessionInput({ ...FORM_PAYLOAD, notes: 'x'.repeat(2000) }).ok).toBe(true);
	});

	it('refuses a drill slug that could never match a catalogue file', () => {
		for (const drill_slug of ['Free Throw Block', 'free_throw', 'free-throw-', '-free-throw', '']) {
			const payload = { ...FORM_PAYLOAD, drills: [{ drill_slug, makes: 1, attempts: 2 }] };
			expect(parseSessionInput(payload).ok, drill_slug).toBe(false);
		}
	});

	it('refuses a drill line with no numbers attached to it', () => {
		const payload = { ...FORM_PAYLOAD, drills: [{ drill_slug: 'mikan-finishing' }] };
		const result = parseSessionInput(payload);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems[0]).toContain('records no numbers');
	});

	it('refuses more makes than attempts, which the table also checks', () => {
		const payload = { ...FORM_PAYLOAD, drills: [{ drill_slug: 'free-throw-block', makes: 51, attempts: 50 }] };
		const result = parseSessionInput(payload);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems[0]).toContain('more makes than attempts');
	});

	it('refuses a weight the numeric(5, 2) column would have to round', () => {
		const payload = { ...FORM_PAYLOAD, drills: [{ drill_slug: 'goblet-squat-strength', weight_kg: '80.555' }] };
		expect(parseSessionInput(payload).ok).toBe(false);
		const rounded = {
			...FORM_PAYLOAD,
			drills: [{ drill_slug: 'goblet-squat-strength', weight_kg: '80.55' }],
		};
		expect(parseSessionInput(rounded).ok).toBe(true);
	});

	it('refuses a negative number where the table has a floor', () => {
		const payload = { ...FORM_PAYLOAD, drills: [{ drill_slug: 'mikan-finishing', reps: -1 }] };
		expect(parseSessionInput(payload).ok).toBe(false);
	});

	it('refuses a drills field that is not a list', () => {
		expect(parseSessionInput({ ...FORM_PAYLOAD, drills: 'free-throw-block' }).ok).toBe(false);
	});

	it('refuses a body that is not an object at all', () => {
		expect(parseSessionInput(null).ok).toBe(false);
		expect(parseSessionInput('trainee=Oisin').ok).toBe(false);
	});
});

describe('listSessions', () => {
	it('answers not-configured when there is no client', async () => {
		const result = await listSessions({}, { client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});

	it('maps rows and their embedded drills', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [SESSION_ROW] } } } });
		const result = await listSessions({}, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual([
			{
				id: SESSION_ID,
				trainee: 'Oisin',
				session_date: '2026-10-27',
				duration_min: 45,
				feel: 'good',
				notes: null,
				created_at: '2026-10-27T18:00:00.000Z',
				drills: [
					{
						id: 1,
						drill_slug: 'free-throw-block',
						sets: null,
						reps: null,
						makes: 38,
						attempts: 50,
						weight_kg: null,
					},
				],
			},
		]);
	});

	it('reads a numeric column that arrives as a string', async () => {
		const row = {
			...SESSION_ROW,
			session_drills: [{ ...SESSION_ROW.session_drills[0], weight_kg: '80.50' }],
		};
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [row] } } } });
		const result = await listSessions({}, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value[0]?.drills[0]?.weight_kg).toBe(80.5);
	});

	it('selects named columns rather than every column', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [] } } } });
		await listSessions({}, { client: fake.asClient() });

		const columns = fake.recorded('sessions', 'select')?.columns ?? '';
		expect(columns).not.toContain('*');
		expect(columns).toContain('session_drills(');
	});

	it('orders newest first and caps the list', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [] } } } });
		await listSessions({}, { client: fake.asClient() });

		const call = fake.recorded('sessions', 'select');
		expect(call?.order).toEqual([
			{ column: 'session_date', ascending: false },
			{ column: 'created_at', ascending: false },
		]);
		expect(call?.limit).toBe(200);
	});

	it('turns a query into filters, including an inclusive date range', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [] } } } });
		await listSessions(
			{ trainee: 'Oisin', since: '2026-08-01', until: '2026-10-27', limit: 25 },
			{ client: fake.asClient() },
		);

		const call = fake.recorded('sessions', 'select');
		expect(call?.filters).toEqual([
			{ column: 'trainee', operator: 'eq', value: 'Oisin' },
			{ column: 'session_date', operator: 'gte', value: '2026-08-01' },
			{ column: 'session_date', operator: 'lte', value: '2026-10-27' },
		]);
		expect(call?.limit).toBe(25);
	});

	it('filters one day when the day list asks for it', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [] } } } });
		await listSessions({ date: '2026-10-27' }, { client: fake.asClient() });

		expect(fake.recorded('sessions', 'select')?.filters).toEqual([
			{ column: 'session_date', operator: 'eq', value: '2026-10-27' },
		]);
	});

	it('classifies a database failure', async () => {
		const fake = new FakeSupabase({
			tables: { sessions: { select: { data: null, error: { message: 'relation does not exist', code: '42P01' } } } },
		});
		const result = await listSessions({}, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('error');
		expect(result.error.message).toBe('relation does not exist');
	});

	it('reports a row it cannot map instead of rendering half of it', async () => {
		const fake = new FakeSupabase({
			tables: { sessions: { select: { data: [{ ...SESSION_ROW, duration_min: null }] } } },
		});
		const result = await listSessions({}, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('missing a field');
	});

	it('reports a payload that is not a list of rows', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: null } } } });
		const result = await listSessions({}, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('list of session rows');
	});
});

describe('getSession', () => {
	it('returns the session it found', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [SESSION_ROW] } } } });
		const result = await getSession(SESSION_ID, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.id).toBe(SESSION_ID);
	});

	it('answers not-found for an unknown id, which is a 404 rather than a throw', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { select: { data: [] } } } });
		const result = await getSession('missing', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-found');
	});

	it('classifies a refused read as denied', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: {
					select: { data: null, error: { message: 'permission denied for table sessions', code: '42501' } },
				},
			},
		});
		const result = await getSession(SESSION_ID, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('denied');
	});
});

describe('createSession', () => {
	it('writes the session, then its drills against the new id, then reads it back', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: { insert: { data: [{ id: SESSION_ID }] }, select: { data: [SESSION_ROW] } },
				session_drills: { insert: { data: [] } },
			},
		});
		const result = await createSession(PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		expect(fake.recorded('sessions', 'insert')?.payload).toEqual({
			trainee: 'Oisin',
			session_date: '2026-10-27',
			duration_min: 45,
			feel: 'good',
			notes: null,
		});
		expect(fake.recorded('session_drills', 'insert')?.payload).toEqual([
			{
				session_id: SESSION_ID,
				drill_slug: 'free-throw-block',
				sets: null,
				reps: null,
				makes: 38,
				attempts: 50,
				weight_kg: null,
			},
		]);
		// The write is followed by a read, so a created session and a listed one
		// are the same shape.
		expect(fake.recorded('sessions', 'select')?.filters).toEqual([
			{ column: 'id', operator: 'eq', value: SESSION_ID },
		]);
	});

	it('never touches the drill table when no drills were logged', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: { insert: { data: [{ id: SESSION_ID }] }, select: { data: [SESSION_ROW] } },
			},
		});
		await createSession({ ...PARSED, drills: [] }, { client: fake.asClient() });

		expect(fake.recorded('session_drills', 'insert')).toBeUndefined();
	});

	it('takes the session back out if its drills cannot be written', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: { insert: { data: [{ id: SESSION_ID }] } },
				session_drills: {
					insert: { data: null, error: { message: 'makes exceeds attempts', code: '23514' } },
				},
			},
		});
		const result = await createSession(PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe('makes exceeds attempts');
		// No transaction spans two PostgREST statements, so the orphan is removed.
		expect(fake.recorded('sessions', 'delete')?.filters).toEqual([
			{ column: 'id', operator: 'eq', value: SESSION_ID },
		]);
	});

	it('does not write drills when the session itself was refused', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: {
					insert: { data: null, error: { message: 'trainee violates check', code: '23514' } },
				},
			},
		});
		const result = await createSession(PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		expect(fake.recorded('session_drills', 'insert')).toBeUndefined();
	});

	it('reports a write that returned no id rather than inventing one', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { insert: { data: [] } } } });
		const result = await createSession(PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// `.single()` on an empty result is PGRST116, which reads as not-found.
		expect(result.error.code).toBe('not-found');
	});

	it('answers not-configured when there is no client', async () => {
		const result = await createSession(PARSED, { client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});
});

describe('updateSession', () => {
	it('replaces the drill lines wholesale and reads the session back', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: { update: { data: [{ id: SESSION_ID }] }, select: { data: [SESSION_ROW] } },
				session_drills: { delete: { data: [] }, insert: { data: [] } },
			},
		});
		const result = await updateSession(SESSION_ID, PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		expect(fake.recorded('session_drills', 'delete')?.filters).toEqual([
			{ column: 'session_id', operator: 'eq', value: SESSION_ID },
		]);
		expect(fake.recorded('session_drills', 'insert')).toBeDefined();
	});

	it('answers not-found when the id was deleted by someone else', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: {
					update: {
						data: null,
						error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
					},
				},
			},
		});
		const result = await updateSession('gone', PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-found');
		expect(fake.recorded('session_drills', 'delete')).toBeUndefined();
	});

	it('stops after clearing the drills if the replacements cannot be written', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: { update: { data: [{ id: SESSION_ID }] } },
				session_drills: {
					delete: { data: [] },
					insert: { data: null, error: { message: 'drill_slug violates check', code: '23514' } },
				},
			},
		});
		const result = await updateSession(SESSION_ID, PARSED, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe('drill_slug violates check');
	});
});

describe('deleteSession', () => {
	it('reports success when a row was removed', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { delete: { data: [{ id: SESSION_ID }] } } } });
		const result = await deleteSession(SESSION_ID, { client: fake.asClient() });

		expect(result).toEqual({ ok: true, value: undefined });
	});

	it('answers not-found when nothing matched, rather than claiming success', async () => {
		const fake = new FakeSupabase({ tables: { sessions: { delete: { data: [] } } } });
		const result = await deleteSession('missing', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-found');
	});

	it('classifies a refused delete', async () => {
		const fake = new FakeSupabase({
			tables: {
				sessions: { delete: { data: null, error: { message: 'permission denied', code: '42501' } } },
			},
		});
		const result = await deleteSession(SESSION_ID, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('denied');
	});
});
