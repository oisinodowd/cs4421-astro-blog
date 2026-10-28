/**
 * Slate ingest (#97): the only thing in the service that talks to balldontlie.
 *
 * The rules it exists to hold:
 *
 *  - **Nobody pays for a page view twice.** A refresh reads the cache first. If
 *    the day's rows were written recently enough -- a minute while a game is
 *    live, half a day once every game is final -- it spends nothing and says so.
 *    A day upstream said was empty is remembered the same way, through the
 *    `slate_days` marker, so an off-season page view costs nothing either.
 *  - **Every upstream request is recorded.** The count comes from the budget
 *    guard, not from the client's own tally: a request is only sent if the shared
 *    `upstream_budget` row allowed it, so what is spent and what is recorded
 *    cannot drift.
 *  - **A refusal is a report, not an exception.** An exhausted budget, a 5xx, a
 *    timeout and an entitlement refusal (the tier this key is on answers
 *    `Unauthorized` to `/stats`) all come back as a `degraded` report with what
 *    was written and what was skipped. The pages then render the cache with its
 *    age, which is #101's whole subject.
 *  - **Nothing here runs on a schedule.** `refreshSlate` is called by a request
 *    that is waiting for the answer. A cron that refreshed on its own would spend
 *    requests nobody asked for.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { type BalldontlieClient, createBalldontlieClient, type BudgetSpend, type UpstreamRow } from './balldontlie';
import { classifyError, failure, resolveClient, success, type ClientOption, type Result } from './db';
import { isRecord, readCalendarDate, readNumber, readString } from './json';
import { gameIdsWithStats, listGamesOn, readSlateDay, type CachedGame } from './tracker-cache';
import { consumeBudget } from './upstream-budget';

/**
 * A live slate is worth re-reading a minute later; a finished one is not. The
 * long TTL is what stops a page view on a settled day from spending a request.
 */
const LIVE_TTL_MS = 60 * 1000;
const SETTLED_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * A slate where nothing has tipped off still needs re-checking before the first
 * game starts, but not every minute: its rows cannot change until a game does.
 */
const SCHEDULED_TTL_MS = 10 * 60 * 1000;

/**
 * Conservative on purpose: the free tier's limits are not published, so the
 * budget starts low enough that a mistake costs a little rather than the day.
 * `NBA_DAILY_REQUEST_BUDGET` overrides it, and every refresh reports what the
 * day has used so the number can be adjusted from evidence.
 */
const DEFAULT_DAILY_LIMIT = 400;

/** More than this many games needing a box score in one refresh is a shape change. */
const MAX_STATS_GAMES = 20;

export interface RefreshOptions extends ClientOption {
	env?: Record<string, string | undefined>;
	fetch?: typeof globalThis.fetch;
	/** Injected so a test can move the clock under the TTL rules. */
	now?: () => number;
	liveTtlMs?: number;
	settledTtlMs?: number;
	scheduledTtlMs?: number;
}

export interface SlateRefreshReport {
	date: string;
	/** `fresh` spent nothing; `degraded` wrote what it could and stopped. */
	status: 'refreshed' | 'fresh' | 'degraded';
	requests: { games: number; stats: number; total: number };
	/** The shared ledger after the last request, or null if nothing was asked. */
	budget: BudgetSpend | null;
	games: number;
	teams: number;
	statRows: number;
	liveGames: number;
	skipped: Array<{ gameId: number; reason: string }>;
	/** Rows upstream sent that this mapper could not read. */
	problems: string[];
	notes: string[];
}

interface MappedGame {
	id: number;
	live: boolean;
	postponed: boolean;
	settled: boolean;
	row: Record<string, unknown>;
}

interface MappedSlate {
	date: string;
	games: MappedGame[];
	teams: Record<string, unknown>[];
	problems: string[];
}

// --- the pure part: upstream payload -> rows --------------------------------

/**
 * Map a games payload onto the cache's columns. Pure, so it is tested against
 * captured payloads rather than through a query, and tolerant, so an upstream
 * shape change shows up as `problems` and a stored `raw` object rather than as a
 * thrown error mid-ingest.
 */
export function parseGames(rows: UpstreamRow[], date: string, ingestedAt: string): MappedSlate {
	const games: MappedGame[] = [];
	const teams = new Map<number, Record<string, unknown>>();
	const problems: string[] = [];

	for (const row of rows) {
		const id = readNumber(row.id);
		if (id === null || !Number.isInteger(id)) {
			problems.push('a game arrived without an id');
			continue;
		}

		const home = toTeamRow(row.home_team, ingestedAt);
		const visitor = toTeamRow(row.visitor_team, ingestedAt);
		if (home !== null) teams.set(home.id as number, home);
		if (visitor !== null) teams.set(visitor.id as number, visitor);
		if (home === null || visitor === null) {
			problems.push(`game ${id} arrived without both teams`);
		}

		const status = readString(row.status) ?? 'Unknown';
		// Upstream sends `0` for a game that has not started, not null. Zero is a
		// period number only to upstream: null is the truthful stored value, and it
		// is what makes "has a period" mean "has started" everywhere downstream.
		const period = whole(row.period);
		const started = period !== null && period > 0;
		const postponed = row.postponed === true;
		const settled = postponed || isFinal(status);

		games.push({
			id,
			live: !settled && (isInProgress(row.status_state) || started),
			postponed,
			settled,
			row: {
				id,
				game_date: date,
				status,
				period: started ? period : null,
				// Upstream calls this `time`: "4:31" while live, "Final" once it is not.
				clock: readString(row.time),
				postseason: row.postseason === true,
				home_team_id: home?.id ?? null,
				visitor_team_id: visitor?.id ?? null,
				home_score: whole(row.home_team_score),
				visitor_score: whole(row.visitor_team_score),
				home_q1: whole(row.home_q1),
				home_q2: whole(row.home_q2),
				home_q3: whole(row.home_q3),
				home_q4: whole(row.home_q4),
				visitor_q1: whole(row.visitor_q1),
				visitor_q2: whole(row.visitor_q2),
				visitor_q3: whole(row.visitor_q3),
				visitor_q4: whole(row.visitor_q4),
				// Kept as JSON because these two have changed shape upstream: one
				// season they arrived nested, another as sibling fields.
				in_bonus: pair(row.home_in_bonus, row.visitor_in_bonus),
				timeouts_remaining: pair(row.home_timeouts_remaining, row.visitor_timeouts_remaining),
				// The object as received: the evidence a shape change is diagnosed from.
				raw: row,
				ingested_at: ingestedAt,
			},
		});
	}

	return { date, games, teams: [...teams.values()], problems };
}

/**
 * Map a stats payload onto `player_stats`. The table is keyed by
 * (game_id, player_id), so re-reading a live game upserts over its own rows
 * instead of duplicating them.
 */
export function parseStats(rows: UpstreamRow[], ingestedAt: string): {
	rows: Record<string, unknown>[];
	problems: string[];
} {
	const mapped: Record<string, unknown>[] = [];
	const problems: string[] = [];

	for (const row of rows) {
		// Upstream nests the game and the player inside each stat row, and has also
		// sent a flat `game_id` in the past: both are read.
		const game = isRecord(row.game) ? row.game : null;
		const gameId = readNumber(game?.id) ?? readNumber(row.game_id);
		const player = isRecord(row.player) ? row.player : null;
		const playerId = readNumber(player?.id);
		const firstName = readString(player?.first_name);
		const lastName = readString(player?.last_name);
		const playerName =
			firstName !== null && lastName !== null
				? `${firstName} ${lastName}`
				: readString(row.player_name);

		if (gameId === null || playerId === null || playerName === null) {
			problems.push('a stat row arrived without its game, player or name');
			continue;
		}

		const team = isRecord(row.team) ? row.team : null;
		mapped.push({
			game_id: Math.trunc(gameId),
			player_id: Math.trunc(playerId),
			player_name: playerName,
			team_id: whole(team?.id),
			min: readString(row.min),
			pts: whole(row.pts),
			reb: whole(row.reb),
			ast: whole(row.ast),
			stl: whole(row.stl),
			blk: whole(row.blk),
			turnover: whole(row.turnover),
			pf: whole(row.pf),
			fgm: whole(row.fgm),
			fga: whole(row.fga),
			fg3m: whole(row.fg3m),
			fg3a: whole(row.fg3a),
			ftm: whole(row.ftm),
			fta: whole(row.fta),
			oreb: whole(row.oreb),
			dreb: whole(row.dreb),
			ingested_at: ingestedAt,
		});
	}

	return { rows: mapped, problems };
}

function toTeamRow(value: unknown, ingestedAt: string): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const id = whole(value.id);
	const abbreviation = readString(value.abbreviation);
	const city = readString(value.city);
	const name = readString(value.name);
	const fullName = readString(value.full_name);
	if (id === null || abbreviation === null || city === null || name === null || fullName === null) return null;

	return {
		id,
		abbreviation,
		city,
		name,
		full_name: fullName,
		conference: readString(value.conference),
		division: readString(value.division),
		updated_at: ingestedAt,
	};
}

/** Upstream sends scores as numbers; a string would break the column's type. */
function whole(value: unknown): number | null {
	const parsed = readNumber(value);
	return parsed === null ? null : Math.trunc(parsed);
}

/** `{ home, visitor }`, or null when upstream said nothing about either. */
function pair(home: unknown, visitor: unknown): Record<string, unknown> | null {
	const homeValue = typeof home === 'boolean' || readNumber(home) !== null ? home : null;
	const visitorValue = typeof visitor === 'boolean' || readNumber(visitor) !== null ? visitor : null;
	if (homeValue === null && visitorValue === null) return null;
	return { home: homeValue, visitor: visitorValue };
}

function isFinal(status: string): boolean {
	return /final/i.test(status);
}

function isInProgress(state: unknown): boolean {
	const text = readString(state);
	return text === 'in_progress';
}

// --- the refresh ------------------------------------------------------------

export async function refreshSlate(
	date: string,
	options: RefreshOptions = {},
): Promise<Result<SlateRefreshReport>> {
	const client = resolveClient(options);
	if (client === null) {
		return failure('not-configured', 'no database client: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both set');
	}

	const day = readCalendarDate(date);
	if (day === null) {
		return failure('error', `date must be a calendar date as YYYY-MM-DD, got ${JSON.stringify(date)}`);
	}

	const now = options.now ?? Date.now;
	const env = options.env ?? process.env;

	// Step one: can this refresh be answered from the cache? A page arriving while
	// a game is live is worth one request a minute; a settled slate is not worth
	// one an hour.
	const cached = await listGamesOn(day, { client });
	if (!cached.ok) return cached;

	const at = now();
	const cachedGames = cached.value;

	if (cachedGames.length > 0) {
		const ttl = ttlFor(cachedGames, options);
		const age = ageOf(cachedGames, at);
		if (age !== null && age < ttl.ms) {
			return success(
				freshReport(
					day,
					cachedGames,
					`the cache for ${day} is ${Math.round(age / 1000)}s old and ${ttl.reason}, so nothing was spent`,
				),
			);
		}
	} else {
		// A day with no games has no row in `games` to carry a timestamp, so the
		// marker row says when upstream was last asked about it. With no marker -- a
		// day never checked, or a database where the migration has not been applied
		// yet -- the refresh asks upstream, which is what it did before the marker
		// existed. A marker that cannot be read is not a reason to fail a page.
		const marker = await readSlateDay(day, { client });
		// Only a marker that says there were no games may stand in for rows that are
		// not there. A marker that counted games the cache no longer holds is a
		// disagreement worth a request: the rows were lost, not never written.
		if (marker.ok && marker.value !== null && marker.value.games === 0) {
			const checked = Date.parse(marker.value.checkedAt);
			const settledTtlMs = options.settledTtlMs ?? SETTLED_TTL_MS;
			if (Number.isFinite(checked) && at - checked < settledTtlMs) {
				return success(
					freshReport(
						day,
						cachedGames,
						`upstream was asked about ${day} ${Math.round((at - checked) / 1000)}s ago and reported no games, so nothing was spent`,
					),
				);
			}
		}
	}

	const report: SlateRefreshReport = {
		date: day,
		status: 'refreshed',
		requests: { games: 0, stats: 0, total: 0 },
		budget: null,
		games: 0,
		teams: 0,
		statRows: 0,
		liveGames: 0,
		skipped: [],
		problems: [],
		notes: [],
	};

	// Step two: the budget, wired so that a request is counted only once the shared
	// ledger has allowed it. A ledger that cannot be read fails closed: spending
	// nothing is recoverable, overspending is not.
	let phase: 'games' | 'stats' = 'games';
	const upstream: BalldontlieClient = createBalldontlieClient({
		env,
		fetch: options.fetch,
		budget: async () => {
			const decision = await consumeBudget(utcDay(now()), dailyLimitFrom(env), { client });
			if (!decision.ok) {
				report.notes.push(`the budget could not be read (${decision.error.code}: ${decision.error.message})`);
				return { allowed: false, requestsUsed: 0, dailyLimit: dailyLimitFrom(env) };
			}
			if (decision.value.allowed) {
				report.requests[phase]++;
				report.requests.total++;
			}
			report.budget = decision.value;
			return decision.value;
		},
	});

	const gamesPage = await upstream.listGames(day);
	if (!gamesPage.ok) {
		report.status = 'degraded';
		report.notes.push(`the games request failed (${gamesPage.error.code}): ${gamesPage.error.message}`);
		return success(report);
	}

	const ingestedAt = new Date(at).toISOString();
	const slate = parseGames(gamesPage.value.rows, day, ingestedAt);
	report.problems.push(...slate.problems);
	report.liveGames = slate.games.filter((game) => game.live).length;

	const teamsWritten = await upsert(client, 'teams', slate.teams, 'id');
	if (!teamsWritten.ok) return teamsWritten;
	report.teams = slate.teams.length;

	const gamesWritten = await upsert(
		client,
		'games',
		slate.games.map((game) => game.row),
		'id',
	);
	if (!gamesWritten.ok) return gamesWritten;
	report.games = slate.games.length;

	// Record that upstream was asked about this day, including when the answer was
	// "no games": that row is what makes the next view of an empty slate free
	// (#98). Failing to write it must not fail a refresh whose slate did land --
	// the pages only lose the empty-day shortcut -- so it is a note, not an error.
	const marked = await upsert(
		client,
		'slate_days',
		[{ game_date: day, games: slate.games.length, checked_at: ingestedAt }],
		'game_date',
	);
	if (!marked.ok) {
		report.notes.push(`the slate-day marker could not be written (${marked.error.code})`);
	}

	// Step three: box scores. Live games are re-read every refresh; a game that has
	// just gone final is read once more for its finished numbers. A settled game
	// already in the cache is not re-read at all -- that is the difference between
	// one request per live game and one request per page view.
	const liveIds = slate.games.filter((game) => game.live).map((game) => game.id);
	const settledIds = slate.games.filter((game) => game.settled).map((game) => game.id);
	const withStats = await gameIdsWithStats([...liveIds, ...settledIds], { client });
	if (!withStats.ok) return withStats;

	const haveStats = new Set(withStats.value);
	const wanted = [...liveIds, ...settledIds.filter((id) => !haveStats.has(id))].slice(0, MAX_STATS_GAMES);

	if (wanted.length > 0) {
		phase = 'stats';
		// One request per game rather than one request for all of them: a batch that
		// is refused or fails loses every game's box score, and the ticket's request
		// arithmetic is per live game.
		for (const gameId of wanted) {
			const statsPage = await upstream.listStats([gameId]);
			if (!statsPage.ok) {
				report.status = 'degraded';
				report.skipped.push({ gameId, reason: statsPage.error.code });
				report.notes.push(`the box score for game ${gameId} was not fetched (${statsPage.error.code}): ${statsPage.error.message}`);
				// A refusal that will not change for the next game either -- spent
				// allowance, an entitlement refusal -- stops the loop rather than
				// repeating the same failure for the rest of the slate.
				if (statsPage.error.code === 'budget-spent' || statsPage.error.code === 'unauthorized') break;
				continue;
			}

			const stats = parseStats(statsPage.value.rows, ingestedAt);
			report.problems.push(...stats.problems);
			if (stats.rows.length > 0) {
				const written = await upsert(client, 'player_stats', stats.rows, 'game_id,player_id');
				if (!written.ok) return written;
				report.statRows += stats.rows.length;
			}
		}
	}

	if (report.status === 'degraded') {
		report.notes.push('the cache was written as far as the upstream allowance and the upstream answers allowed');
	}

	return success(report);
}

// --- small helpers ----------------------------------------------------------

async function upsert(
	client: SupabaseClient,
	table: string,
	rows: Record<string, unknown>[],
	onConflict: string,
): Promise<Result<undefined>> {
	if (rows.length === 0) return success(undefined);
	const response = await client.from(table).upsert(rows, { onConflict });
	if (response.error) return { ok: false, error: classifyError(response.error) };
	return success(undefined);
}

/** The day's cached rows and nothing spent: the report a page renders from. */
function freshReport(day: string, games: CachedGame[], note: string): SlateRefreshReport {
	return {
		date: day,
		status: 'fresh',
		requests: { games: 0, stats: 0, total: 0 },
		budget: null,
		games: games.length,
		teams: 0,
		statRows: 0,
		liveGames: games.filter(isLiveRow).length,
		skipped: [],
		problems: [],
		notes: [note],
	};
}

/** The TTL that applies to a cached day, and why -- the reason goes in the report. */
function ttlFor(cached: CachedGame[], options: RefreshOptions): { ms: number; reason: string } {
	if (cached.every((game) => isSettledRow(game))) {
		return { ms: options.settledTtlMs ?? SETTLED_TTL_MS, reason: 'every game is final' };
	}
	// A pre-game slate is not a live one: nothing can change until a game tips
	// off, and asking every minute before then would spend a request per viewer.
	if (cached.some(isLiveRow)) {
		return { ms: options.liveTtlMs ?? LIVE_TTL_MS, reason: 'a game is still being played' };
	}
	return { ms: options.scheduledTtlMs ?? SCHEDULED_TTL_MS, reason: 'no game has started yet' };
}

function ageOf(cached: CachedGame[], now: number): number | null {
	const times = cached.map((game) => Date.parse(game.ingestedAt)).filter((time) => Number.isFinite(time));
	if (times.length === 0) return null;
	return now - Math.max(...times);
}

function isSettledRow(game: CachedGame): boolean {
	return isFinal(game.status) || /postponed/i.test(game.status);
}

/** A cached game that a page would still call live, judged from the columns. */
function isLiveRow(game: CachedGame): boolean {
	return !isSettledRow(game) && game.period !== null;
}

function utcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function dailyLimitFrom(env: Record<string, string | undefined>): number {
	const configured = readNumber(env.NBA_DAILY_REQUEST_BUDGET);
	if (configured === null || !Number.isInteger(configured) || configured <= 0) return DEFAULT_DAILY_LIMIT;
	return configured;
}
