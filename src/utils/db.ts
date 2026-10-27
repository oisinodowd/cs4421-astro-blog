/**
 * The one place the application builds a database client (#95).
 *
 * Every query the site runs goes through the modules beside this one, so a route
 * handler holds no client and builds no query. Two things follow from that: the
 * shape a page receives is decided here rather than in a template, and the tests
 * fake this seam instead of reaching a network -- which is what keeps
 * `npm run test:unit` passing offline, in CI, with no credentials.
 *
 * Nothing in here throws. A missing credential, an unreachable database and a
 * refused statement all arrive as a `Result`, because the container is allowed to
 * run with no credentials at all (#94): the site still has to render.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { readSupabaseConfig, type Env } from './dependencies';

/**
 * A closed set of reasons, so a caller can decide what is worth retrying and
 * what is worth showing a visitor.
 */
export type DbErrorCode =
	/** No credentials in the environment: a supported state, not a fault. */
	| 'not-configured'
	| 'not-found'
	/** The request reached PostgREST and the role was refused (SQLSTATE 42501). */
	| 'denied'
	/** No answer at all: the request never got as far as the database. */
	| 'unavailable'
	| 'error';

export interface DbError {
	code: DbErrorCode;
	/**
	 * For logs and operators, never for a visitor. PostgREST errors quote SQL
	 * objects and the value that failed a constraint, which can be session
	 * content; the service-role key travels in a header and is not quoted.
	 * Callers should render their own wording and keep this for the log line.
	 */
	message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DbError };

export function success<T>(value: T): Result<T> {
	return { ok: true, value };
}

export function failure(code: DbErrorCode, message: string): { ok: false; error: DbError } {
	return { ok: false, error: { code, message } };
}

/** The state a container without credentials is in. */
export function notConfigured(): { ok: false; error: DbError } {
	return failure(
		'not-configured',
		'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both set in this environment',
	);
}

/** Long enough to be useful in a log, short enough that nothing can flood it. */
const MAX_MESSAGE_LENGTH = 200;

/**
 * Classify a PostgREST failure the way `dependencies.ts` classifies a probe
 * failure: by what can be acted on, not by the text.
 *
 * A response with no `code` never reached PostgREST -- supabase-js surfaces a
 * transport failure with a message and no code -- so it is `unavailable` and
 * worth retrying. A SQLSTATE or `PGRST` code means the database answered.
 */
export function classifyError(error: { message?: unknown; code?: unknown } | null | undefined): DbError {
	const raw = typeof error?.message === 'string' ? error.message : '';
	const message = raw === '' ? 'the database returned an error' : raw.slice(0, MAX_MESSAGE_LENGTH);
	const code = typeof error?.code === 'string' ? error.code : '';

	if (code === '') return { code: 'unavailable', message };
	// 42501 is a permission failure: row level security with no policy, or a role
	// that was never granted the table. Worth telling apart from a broken query.
	if (code === '42501') return { code: 'denied', message };
	// `.single()` reports "not exactly one row" as PGRST116, which is how an
	// update against an unknown id comes back.
	if (code === 'PGRST116') return { code: 'not-found', message };
	return { code: 'error', message };
}

/**
 * A client for the given environment, or null when the credentials are absent.
 *
 * `auth` is off deliberately: this is a server process holding the service-role
 * key, so there is no user session to persist or refresh, and a container has no
 * browser storage to keep one in.
 */
export function createSupabaseClient(env: Env = process.env): SupabaseClient | null {
	const config = readSupabaseConfig(env);
	if (config === null) return null;
	return createClient(config.url, config.serviceRoleKey, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

let built = false;
let processClient: SupabaseClient | null = null;

/**
 * The process's client, built once and cached. A container's environment does not
 * change while it runs, and every request goes through the same two tasks, so
 * building a client per request would only add a client to garbage collect.
 */
export function supabaseClient(): SupabaseClient | null {
	if (!built) {
		processClient = createSupabaseClient(process.env);
		built = true;
	}
	return processClient;
}

/**
 * The client seam, as a named option rather than a positional argument: the data
 * functions take data, and this is the one thing a caller injects. Production
 * passes nothing and gets the process client; a test passes a fake.
 */
export interface ClientOption {
	client?: SupabaseClient | null;
}

/** An explicit `null` means "pretend there is no client", which a test needs. */
export function resolveClient(options: ClientOption): SupabaseClient | null {
	return options.client === undefined ? supabaseClient() : options.client;
}

// The readers for values that came from JSON live in `json.ts`, so the upstream
// client can use them without importing the database client. Re-exported here
// because every store beside this module reads its rows through them.
export { isRecord, readCalendarDate, readMessage, readNumber, readString } from './json';
