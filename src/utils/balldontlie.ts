/**
 * The balldontlie client (#97).
 *
 * Three things this module is responsible for, and one it refuses to do:
 *
 *  - **Spending permission.** Every request -- including a retry -- asks the
 *    shared budget first, through the `budget` guard. The guard is required
 *    rather than optional, because a client that can spend without asking is a
 *    client that overspends: the day's allowance lives in the database so that
 *    two ECS tasks cannot each believe they hold all of it.
 *  - **Bounded waiting.** One retry, on 429 or a 5xx, after a delay. A timeout
 *    (5s by default) keeps a hung upstream from holding a page request open.
 *  - **Refusing to trust the payload.** The response shape is upstream's, and it
 *    has changed between seasons. Rows come back as records of unknown fields;
 *    `slate-ingest.ts` maps the fields it recognises and keeps the whole object,
 *    so a shape change is visible in the stored evidence rather than in a crash.
 *  - It never logs, and never puts the API key anywhere but the request header:
 *    no error message in here can contain it, and the tests assert that.
 */
import { BALLDONTLIE_API_BASE, readBalldontlieConfig, type Env } from './dependencies';
import { isRecord, readCalendarDate, readMessage, readNumber } from './json';

export type UpstreamFailureCode =
	| 'not-configured'
	/** 401/403: the key is absent, wrong, or not entitled to this endpoint. */
	| 'unauthorized'
	| 'rate-limited'
	/** The shared daily allowance is spent, so nothing was sent at all. */
	| 'budget-spent'
	| 'timeout'
	| 'unreachable'
	/** The upstream answered, and refused. */
	| 'rejected'
	| 'malformed';

export interface UpstreamError {
	code: UpstreamFailureCode;
	/** Upstream's own words, truncated. Never the key. */
	message: string;
	status?: number;
}

/**
 * Not `Result` from `db.ts`: a refused HTTP request and a refused SQL statement
 * are different failures with different remedies, and collapsing them would make
 * `unauthorized` mean two unrelated things.
 */
export type UpstreamResult<T> = { ok: true; value: T } | { ok: false; error: UpstreamError };

export type UpstreamRow = Record<string, unknown>;

export interface UpstreamPage {
	rows: UpstreamRow[];
	/** How many requests this call actually cost, for the refresh report. */
	requests: number;
}

export interface BudgetSpend {
	allowed: boolean;
	requestsUsed: number;
	dailyLimit: number;
}

/** Called before every request, including a retry. */
export type BudgetGuard = () => Promise<BudgetSpend>;

export interface BalldontlieClientOptions {
	env?: Env;
	fetch?: typeof globalThis.fetch;
	budget: BudgetGuard;
	timeoutMs?: number;
	retryDelayMs?: number;
	/** A payload bigger than this many pages is a shape change, not a normal slate. */
	maxPages?: number;
}

export interface BalldontlieClient {
	listGames(date: string): Promise<UpstreamResult<UpstreamPage>>;
	listStats(gameIds: number[]): Promise<UpstreamResult<UpstreamPage>>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_PAGES = 3;
const PER_PAGE = 100;

function failure(code: UpstreamFailureCode, message: string, status?: number): { ok: false; error: UpstreamError } {
	return { ok: false, error: status === undefined ? { code, message } : { code, message, status } };
}

export function createBalldontlieClient(options: BalldontlieClientOptions): BalldontlieClient {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const budget = options.budget;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const config = readBalldontlieConfig(env);

	/** The path only: a message is read by a person, and a query string is noise. */
	function pathOf(url: string): string {
		try {
			return new URL(url).pathname;
		} catch {
			return url;
		}
	}

	async function readBody(response: Response): Promise<string> {
		try {
			return await response.text();
		} catch {
			// A body that will not read is not a reason to lose the status code.
			return '';
		}
	}

	function classifyStatus(status: number): UpstreamFailureCode {
		if (status === 401 || status === 403) return 'unauthorized';
		if (status === 429) return 'rate-limited';
		return 'rejected';
	}

	function isRetryable(status: number | undefined): boolean {
		if (status === undefined) return false;
		return status === 429 || status >= 500;
	}

	/** One request, no retry, no budget: the caller has already paid for it. */
	async function sendOnce(
		url: string,
		apiKey: string,
	): Promise<UpstreamResult<{ rows: UpstreamRow[]; nextCursor: number | null }>> {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				headers: { authorization: apiKey },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const name = (error as { name?: unknown } | null)?.name;
			if (name === 'TimeoutError' || name === 'AbortError') {
				return failure('timeout', `${pathOf(url)} did not answer within ${timeoutMs}ms`);
			}
			return failure('unreachable', `${pathOf(url)} could not be reached`);
		}

		const body = await readBody(response);
		if (!response.ok) {
			// Upstream's own words, with our key scrubbed out of them: a body that
			// echoed the credential would otherwise travel into a log line and a
			// report. Nothing here logs, but an error is returned to a caller that
			// might.
			const said = readMessage(body) || `balldontlie answered ${response.status}`;
			return failure(classifyStatus(response.status), redact(said, apiKey), response.status);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return failure('malformed', `${pathOf(url)} answered with something that is not JSON`);
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
			return failure('malformed', `${pathOf(url)} answered without a data array`);
		}
		if (!parsed.data.every(isRecord)) {
			return failure('malformed', `${pathOf(url)} returned a data array holding something that is not an object`);
		}

		const cursor = isRecord(parsed.meta) ? readNumber(parsed.meta.next_cursor) : null;
		return { ok: true, value: { rows: parsed.data as UpstreamRow[], nextCursor: cursor === null ? null : Math.trunc(cursor) } };
	}

	/**
	 * One page: ask the budget, send, and retry once on a 429 or a 5xx. The retry
	 * asks the budget again, so a retry can be refused and the day's ledger still
	 * records exactly the requests that were sent.
	 */
	async function requestPage(
		url: string,
	): Promise<UpstreamResult<{ rows: UpstreamRow[]; nextCursor: number | null; requests: number }>> {
		if (config === null) {
			return failure('not-configured', 'BALLDONTLIE_API_KEY is not set in this environment');
		}

		let spent = 0;
		let last: UpstreamError | null = null;

		for (let attempt = 0; attempt < 2; attempt++) {
			const allowance = await budget();
			if (!allowance.allowed) {
				return failure(
					'budget-spent',
					`the day's upstream allowance is spent (${allowance.requestsUsed}/${allowance.dailyLimit} used)`,
				);
			}
			spent++;

			const result = await sendOnce(url, config.apiKey);
			if (result.ok) return { ok: true, value: { ...result.value, requests: spent } };

			last = result.error;
			if (!isRetryable(result.error.status) || attempt === 1) break;
			if (retryDelayMs > 0) await sleep(retryDelayMs);
		}

		return { ok: false, error: last ?? { code: 'rejected', message: `${pathOf(url)} failed with no response` } };
	}

	/** Pages until upstream stops offering a cursor, or until the bound is reached. */
	async function collect(
		urlFor: (cursor: number | null) => string,
	): Promise<UpstreamResult<UpstreamPage>> {
		const rows: UpstreamRow[] = [];
		let requests = 0;
		let cursor: number | null = null;

		for (let page = 0; page < maxPages; page++) {
			const result = await requestPage(urlFor(cursor));
			if (!result.ok) {
				// A failed page after some good ones still reports the whole cost: the
				// requests were spent whether or not the payload survived.
				return requests === 0 ? result : { ok: false, error: result.error };
			}
			rows.push(...result.value.rows);
			requests += result.value.requests;
			if (result.value.nextCursor === null) return { ok: true, value: { rows, requests } };
			cursor = result.value.nextCursor;
		}

		// Hitting the bound with a cursor still in hand is worth surfacing, but the
		// rows already paid for are still returned: discarding them would waste the
		// requests that fetched them.
		return { ok: true, value: { rows, requests } };
	}

	async function listGames(date: string): Promise<UpstreamResult<UpstreamPage>> {
		const day = readCalendarDate(date);
		if (day === null) {
			return failure('malformed', `date must be a calendar date as YYYY-MM-DD, got ${JSON.stringify(date)}`);
		}
		return collect((cursor) => {
			const suffix = cursor === null ? '' : `&cursor=${cursor}`;
			return `${BALLDONTLIE_API_BASE}/games?dates[]=${day}&per_page=${PER_PAGE}${suffix}`;
		});
	}

	async function listStats(gameIds: number[]): Promise<UpstreamResult<UpstreamPage>> {
		if (gameIds.length === 0) return failure('malformed', 'listStats needs at least one game id');
		if (!gameIds.every((id) => Number.isInteger(id))) {
			return failure('malformed', 'listStats takes whole game ids');
		}
		const query = gameIds.map((id) => `game_ids[]=${id}`).join('&');
		return collect((cursor) => {
			const suffix = cursor === null ? '' : `&cursor=${cursor}`;
			return `${BALLDONTLIE_API_BASE}/stats?${query}&per_page=${PER_PAGE}${suffix}`;
		});
	}

	return { listGames, listStats };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replace every occurrence of the key with a marker, so it cannot leak out. */
function redact(text: string, secret: string): string {
	if (secret === '') return text;
	return text.split(secret).join('[redacted]');
}
