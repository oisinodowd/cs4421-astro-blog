/**
 * Trainer session reads and writes (#95), the storage seam behind #103 and #104.
 *
 * Three rules hold throughout:
 *
 *  - Input is parsed before it is stored, and the parser mirrors the checks in
 *    `supabase/migrations/*_create_trainer_tables.sql`. The constraints are the
 *    backstop behind it, not the only guard: a rejected form has to produce a
 *    message a person can act on, and a constraint violation only produces an
 *    error code.
 *  - Nothing throws. Every function answers with a `Result`, so a page can render
 *    a degraded state for a database that is unreachable or unconfigured -- the
 *    contract `/api/health` keeps.
 *  - The client arrives as the named `client` option, so production code passes
 *    nothing and a test passes a fake. No network reaches `npm run test:unit`.
 *
 * Written without a transaction, because PostgREST has none across statements.
 * `createSession` undoes the session it just wrote when its drills fail to
 * insert, rather than leaving a session logged with none of the work that
 * measured it.
 */
import {
	classifyError,
	failure,
	isRecord,
	notConfigured,
	readCalendarDate,
	readNumber,
	readString,
	resolveClient,
	success,
	type ClientOption,
	type Result,
} from './db';

export const SESSION_FEELS = ['rough', 'ok', 'good', 'great'] as const;
export type SessionFeel = (typeof SESSION_FEELS)[number];

/**
 * `session_drills.drill_slug` is checked against this in the migration. It is the
 * same pattern the drill catalogue's filenames satisfy (#102), so a logged drill
 * can always be resolved to a file in `src/content/drills/`.
 */
export const DRILL_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TRAINEE_MAX = 40;
const NOTES_MAX = 2000;
const DURATION_MAX = 600;
const REPETITION_MAX = 10000;
const SETS_MAX = 100;
const WEIGHT_MAX = 500;
const DEFAULT_LIST_LIMIT = 200;

export interface SessionDrillInput {
	drill_slug: string;
	sets?: number | null;
	reps?: number | null;
	makes?: number | null;
	attempts?: number | null;
	weight_kg?: number | null;
}

export interface SessionInput {
	trainee: string;
	/** A calendar date, `YYYY-MM-DD`. */
	session_date: string;
	duration_min: number;
	feel: SessionFeel;
	notes?: string | null;
	drills: SessionDrillInput[];
}

export interface SessionDrill {
	id: number;
	drill_slug: string;
	sets: number | null;
	reps: number | null;
	makes: number | null;
	attempts: number | null;
	weight_kg: number | null;
}

export interface Session {
	id: string;
	trainee: string;
	session_date: string;
	duration_min: number;
	feel: SessionFeel;
	notes: string | null;
	created_at: string;
	drills: SessionDrill[];
}

export interface SessionQuery {
	/** One day, which is what the day's list asks for. */
	date?: string;
	trainee?: string;
	/** Inclusive bounds on `session_date`, for the 4- and 12-week views (#104). */
	since?: string;
	until?: string;
	limit?: number;
}

/**
 * Named columns rather than `*`: what a page receives is what this module
 * selects, so a column added later does not silently start being rendered.
 */
const SESSION_COLUMNS =
	'id, trainee, session_date, duration_min, feel, notes, created_at, ' +
	'session_drills(id, drill_slug, sets, reps, makes, attempts, weight_kg)';

// --- parsing untrusted input ------------------------------------------------

export type ParseOutcome = { ok: true; value: SessionInput } | { ok: false; problems: string[] };

/**
 * Turn whatever arrived -- a form body, a JSON payload, a test fixture -- into a
 * session, or into the list of problems that stopped it. Every problem is
 * reported, not just the first: a form with three empty fields should say so
 * once.
 */
export function parseSessionInput(raw: unknown): ParseOutcome {
	const problems: string[] = [];
	if (!isRecord(raw)) return { ok: false, problems: ['expected an object of session fields'] };

	const trainee = readString(raw.trainee);
	if (trainee === null || trainee.length > TRAINEE_MAX) {
		problems.push(`trainee must be 1 to ${TRAINEE_MAX} characters`);
	}

	const sessionDate = readCalendarDate(raw.session_date);
	if (sessionDate === null) problems.push('session_date must be a calendar date, as YYYY-MM-DD');

	const duration = readWholeNumber(raw.duration_min, 1, DURATION_MAX);
	if (duration === null) {
		problems.push(`duration_min must be a whole number of minutes between 1 and ${DURATION_MAX}`);
	}

	const feel = SESSION_FEELS.find((allowed) => allowed === readString(raw.feel));
	if (feel === undefined) problems.push(`feel must be one of ${SESSION_FEELS.join(', ')}`);

	const notes = readNotes(raw.notes);
	if (notes === undefined) problems.push(`notes must be at most ${NOTES_MAX} characters`);

	const drills = readDrills(raw.drills, problems);

	if (problems.length > 0 || trainee === null || sessionDate === null || duration === null) {
		return { ok: false, problems: problems.length > 0 ? problems : ['could not read the session fields'] };
	}

	return {
		ok: true,
		value: {
			trainee,
			session_date: sessionDate,
			duration_min: duration,
			feel: feel ?? 'ok',
			notes: notes ?? null,
			drills: drills ?? [],
		},
	};
}

function readDrills(raw: unknown, problems: string[]): SessionDrillInput[] | null {
	// A session with no drills is legitimate: the form is a session log first.
	if (raw === undefined || raw === null || raw === '') return [];
	if (!Array.isArray(raw)) {
		problems.push('drills must be a list');
		return null;
	}

	const drills: SessionDrillInput[] = [];
	raw.forEach((entry, index) => {
		const at = `drills[${index}]`;
		if (!isRecord(entry)) {
			problems.push(`${at} must be an object`);
			return;
		}

		const slug = readString(entry.drill_slug);
		if (slug === null || !DRILL_SLUG_PATTERN.test(slug)) {
			problems.push(`${at}.drill_slug must be a catalogue slug, such as free-throw-block`);
		}

		const sets = readOptional(entry.sets, 0, SETS_MAX, true, `${at}.sets`, problems);
		const reps = readOptional(entry.reps, 0, REPETITION_MAX, true, `${at}.reps`, problems);
		const makes = readOptional(entry.makes, 0, REPETITION_MAX, true, `${at}.makes`, problems);
		const attempts = readOptional(entry.attempts, 0, REPETITION_MAX, true, `${at}.attempts`, problems);
		const weight = readOptional(entry.weight_kg, 0, WEIGHT_MAX, false, `${at}.weight_kg`, problems);

		// A drill line with no numbers is a name with nothing attached: the progress
		// views (#104) can compute nothing from it, so it is refused here rather
		// than stored as an empty row.
		if (sets === null && reps === null && makes === null && attempts === null && weight === null) {
			problems.push(
				`${at} records no numbers: log at least one of sets, reps, makes, attempts or weight_kg`,
			);
		}
		if (makes !== null && attempts !== null && makes > attempts) {
			problems.push(`${at} has more makes than attempts`);
		}

		drills.push({
			drill_slug: slug ?? '',
			sets,
			reps,
			makes,
			attempts,
			weight_kg: weight,
		});
	});

	return drills;
}

/** Absent reads as null; present but unusable is a problem worth reporting. */
function readOptional(
	value: unknown,
	min: number,
	max: number,
	whole: boolean,
	field: string,
	problems: string[],
): number | null {
	if (value === undefined || value === null || value === '') return null;
	const parsed = whole ? readWholeNumber(value, min, max) : readWeight(value);
	if (parsed === null) {
		problems.push(
			whole
				? `${field} must be a whole number between ${min} and ${max}`
				: `${field} must be between ${min} and ${max} kg, to two decimal places`,
		);
	}
	return parsed;
}

function readWholeNumber(value: unknown, min: number, max: number): number | null {
	const parsed = readNumber(value);
	if (parsed === null || !Number.isInteger(parsed) || parsed < min || parsed > max) return null;
	return parsed;
}

function readWeight(value: unknown): number | null {
	const parsed = readNumber(value);
	if (parsed === null || parsed < 0 || parsed > WEIGHT_MAX) return null;
	// numeric(5, 2) in the table: a third decimal place would be rounded by
	// Postgres, so it is refused rather than silently changed.
	return Math.round(parsed * 100) === parsed * 100 ? parsed : null;
}

/** Notes are optional; an empty one is stored as NULL rather than ''. */
function readNotes(value: unknown): string | null | undefined {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length > NOTES_MAX) return undefined;
	return trimmed === '' ? null : trimmed;
}

// --- mapping rows -----------------------------------------------------------

/** A row out of PostgREST, as far as this module trusts it: not at all. */
export function toSession(row: unknown): Result<Session> {
	if (!isRecord(row)) return failure('error', 'expected a session row');

	const id = readString(row.id);
	const trainee = readString(row.trainee);
	const sessionDate = readCalendarDate(row.session_date);
	const duration = readWholeNumber(row.duration_min, 1, DURATION_MAX);
	const feel = SESSION_FEELS.find((allowed) => allowed === readString(row.feel));
	const createdAt = readString(row.created_at);

	if (
		id === null ||
		trainee === null ||
		sessionDate === null ||
		duration === null ||
		feel === undefined ||
		createdAt === null
	) {
		return failure('error', 'a session row is missing a field: id, trainee, session_date, duration_min, feel, created_at');
	}

	const drills = row.session_drills === undefined ? success<SessionDrill[]>([]) : toDrills(row.session_drills);
	if (!drills.ok) return drills;

	return success({
		id,
		trainee,
		session_date: sessionDate,
		duration_min: duration,
		feel,
		notes: readString(row.notes),
		created_at: createdAt,
		drills: drills.value,
	});
}

function toDrills(rows: unknown): Result<SessionDrill[]> {
	if (!Array.isArray(rows)) return failure('error', 'expected the session drills to be a list');

	const drills: SessionDrill[] = [];
	for (const row of rows) {
		const mapped = toDrill(row);
		if (!mapped.ok) return mapped;
		drills.push(mapped.value);
	}
	return success(drills);
}

function toDrill(row: unknown): Result<SessionDrill> {
	if (!isRecord(row)) return failure('error', 'expected a session drill row');

	const id = readNumber(row.id);
	const slug = readString(row.drill_slug);
	if (id === null || !Number.isInteger(id) || slug === null) {
		return failure('error', 'a session drill row is missing its id or drill_slug');
	}

	return success({
		id,
		drill_slug: slug,
		sets: readStored(row.sets),
		reps: readStored(row.reps),
		makes: readStored(row.makes),
		attempts: readStored(row.attempts),
		weight_kg: readStored(row.weight_kg),
	});
}

/** A nullable column: absent, null and an empty string all mean "not recorded". */
function readStored(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	return readNumber(value);
}

// --- reads ------------------------------------------------------------------

export async function listSessions(
	query: SessionQuery = {},
	options: ClientOption = {},
): Promise<Result<Session[]>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();

	let request = client.from('sessions').select(SESSION_COLUMNS);
	if (query.date !== undefined) request = request.eq('session_date', query.date);
	if (query.trainee !== undefined) request = request.eq('trainee', query.trainee);
	if (query.since !== undefined) request = request.gte('session_date', query.since);
	if (query.until !== undefined) request = request.lte('session_date', query.until);

	const response = await request
		.order('session_date', { ascending: false })
		.order('created_at', { ascending: false })
		.limit(query.limit ?? DEFAULT_LIST_LIMIT);

	if (response.error) return { ok: false, error: classifyError(response.error) };
	if (!Array.isArray(response.data)) return failure('error', 'expected a list of session rows');

	const sessions: Session[] = [];
	for (const row of response.data) {
		const mapped = toSession(row);
		if (!mapped.ok) return mapped;
		sessions.push(mapped.value);
	}
	return success(sessions);
}

export async function getSession(id: string, options: ClientOption = {}): Promise<Result<Session>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();

	// maybeSingle rather than single: "no such session" is an answer, not an
	// error, and a page renders it as a 404 instead of catching a throw.
	const response = await client
		.from('sessions')
		.select(SESSION_COLUMNS)
		.eq('id', id)
		.maybeSingle();

	if (response.error) return { ok: false, error: classifyError(response.error) };
	if (response.data === null || response.data === undefined) {
		return failure('not-found', 'no session with that id');
	}
	return toSession(response.data);
}

// --- writes -----------------------------------------------------------------

export async function createSession(
	input: SessionInput,
	options: ClientOption = {},
): Promise<Result<Session>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();

	// Only the id is read back: the session is re-read through getSession, so a
	// logged session and a listed session are the same shape by construction.
	const created = await client
		.from('sessions')
		.insert({
			trainee: input.trainee,
			session_date: input.session_date,
			duration_min: input.duration_min,
			feel: input.feel,
			notes: input.notes ?? null,
		})
		.select('id')
		.single();

	if (created.error) return { ok: false, error: classifyError(created.error) };
	const id = isRecord(created.data) ? readString(created.data.id) : null;
	if (id === null) return failure('error', 'the database did not return an id for the new session');

	if (input.drills.length > 0) {
		const inserted = await client.from('session_drills').insert(
			input.drills.map((drill) => ({
				session_id: id,
				drill_slug: drill.drill_slug,
				sets: drill.sets ?? null,
				reps: drill.reps ?? null,
				makes: drill.makes ?? null,
				attempts: drill.attempts ?? null,
				weight_kg: drill.weight_kg ?? null,
			})),
		);

		if (inserted.error) {
			// No transaction spans the two inserts, so the session is taken back out
			// rather than left behind without the drills that measured it.
			await client.from('sessions').delete().eq('id', id);
			return { ok: false, error: classifyError(inserted.error) };
		}
	}

	return getSession(id, options);
}

export async function updateSession(
	id: string,
	input: SessionInput,
	options: ClientOption = {},
): Promise<Result<Session>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();

	// `.single()` reports an unknown id as PGRST116, which classifyError turns
	// into not-found: an edit to a deleted session is a 404, not a 500.
	const updated = await client
		.from('sessions')
		.update({
			trainee: input.trainee,
			session_date: input.session_date,
			duration_min: input.duration_min,
			feel: input.feel,
			notes: input.notes ?? null,
		})
		.eq('id', id)
		.select('id')
		.single();

	if (updated.error) return { ok: false, error: classifyError(updated.error) };

	// Drill lines are replaced wholesale: they have no identity a person edits,
	// and matching them up would be guesswork. The whole set, or none of it.
	const cleared = await client.from('session_drills').delete().eq('session_id', id);
	if (cleared.error) return { ok: false, error: classifyError(cleared.error) };

	if (input.drills.length > 0) {
		const inserted = await client.from('session_drills').insert(
			input.drills.map((drill) => ({
				session_id: id,
				drill_slug: drill.drill_slug,
				sets: drill.sets ?? null,
				reps: drill.reps ?? null,
				makes: drill.makes ?? null,
				attempts: drill.attempts ?? null,
				weight_kg: drill.weight_kg ?? null,
			})),
		);
		if (inserted.error) return { ok: false, error: classifyError(inserted.error) };
	}

	return getSession(id, options);
}

export async function deleteSession(id: string, options: ClientOption = {}): Promise<Result<undefined>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();

	const deleted = await client.from('sessions').delete().eq('id', id).select('id');
	if (deleted.error) return { ok: false, error: classifyError(deleted.error) };

	if (!Array.isArray(deleted.data) || deleted.data.length === 0) {
		return failure('not-found', 'no session with that id');
	}
	// The drill rows go with it through the foreign key's on-delete cascade.
	return { ok: true, value: undefined };
}
