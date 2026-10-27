import { describe, expect, it } from 'vitest';

import { parseGames, parseStats, refreshSlate, type SlateRefreshReport } from './slate-ingest';
import { FakeSupabase, type FakeCall, type FakeResponse } from './testing/fake-supabase';

const KEY = 'test-key-do-not-log';
const ENV = { BALLDONTLIE_API_KEY: KEY, NBA_DAILY_REQUEST_BUDGET: '400' };
const FIXED_NOW = Date.parse('2026-10-27T21:00:00.000Z');
const DAY = '2026-10-27';

const BOSTON = {
	id: 1,
	abbreviation: 'BOS',
	city: 'Boston',
	name: 'Celtics',
	full_name: 'Boston Celtics',
	conference: 'East',
	division: 'Atlantic',
};
const LAKERS = { ...BOSTON, id: 2, abbreviation: 'LAL', city: 'Los Angeles', name: 'Lakers', full_name: 'Los Angeles Lakers', conference: 'West', division: 'Pacific' };

/** Trimmed copies of what the live endpoint actually returns. */
const LIVE_GAME = {
	id: 5001,
	date: DAY,
	season: 2026,
	status: '2nd Qtr',
	status_state: 'in_progress',
	period: 2,
	time: '4:31',
	postseason: false,
	postponed: false,
	home_team_score: 51,
	visitor_team_score: 48,
	home_q1: 28,
	home_q2: 23,
	home_q3: null,
	home_q4: null,
	visitor_q1: 25,
	visitor_q2: 23,
	visitor_q3: null,
	visitor_q4: null,
	home_in_bonus: true,
	visitor_in_bonus: false,
	home_timeouts_remaining: 4,
	visitor_timeouts_remaining: 5,
	home_team: BOSTON,
	visitor_team: LAKERS,
};

const FINAL_GAME = {
	...LIVE_GAME,
	id: 5002,
	status: 'Final',
	status_state: 'final',
	period: 4,
	time: 'Final',
	home_team_score: 108,
	visitor_team_score: 101,
	home_q3: 30,
	home_q4: 27,
	home_in_bonus: null,
	visitor_in_bonus: null,
	home_timeouts_remaining: null,
	visitor_timeouts_remaining: null,
};

const STAT_ROW = {
	id: 9001,
	min: '34:12',
	pts: 27,
	reb: 9,
	ast: 5,
	stl: 1,
	blk: 0,
	turnover: 3,
	pf: 2,
	fgm: 10,
	fga: 20,
	fg3m: 3,
	fg3a: 8,
	ftm: 4,
	fta: 4,
	oreb: 1,
	dreb: 8,
	player: { id: 900, first_name: 'Jayson', last_name: 'Tatum' },
	team: { id: 1, abbreviation: 'BOS' },
	game: { id: 5001 },
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A cached game row as PostgREST returns one. */
function cachedGame(over: Record<string, unknown> = {}) {
	return {
		id: 5001,
		game_date: DAY,
		status: '2nd Qtr',
		period: 2,
		clock: '4:31',
		postseason: false,
		home_team_id: 1,
		visitor_team_id: 2,
		home_score: 51,
		visitor_score: 48,
		home_q1: 28,
		home_q2: 23,
		home_q3: null,
		home_q4: null,
		visitor_q1: 25,
		visitor_q2: 23,
		visitor_q3: null,
		visitor_q4: null,
		ingested_at: new Date(FIXED_NOW - 30_000).toISOString(),
		...over,
	};
}

/** The shared ledger, as the RPC behaves: atomic, and it refuses when spent. */
function budget({ limit, alreadyUsed = 0 }: { limit: number; alreadyUsed?: number }) {
	const state = { used: alreadyUsed };
	const responder = (call: FakeCall) => {
		const args = (call.payload ?? {}) as Record<string, unknown>;
		const cost = Number(args.p_cost ?? 1);
		const allowed = state.used + cost <= limit;
		if (allowed) state.used += cost;
		return { data: [{ allowed, requests_used: state.used, daily_limit: limit }] };
	};
	return { responder, used: () => state.used };
}

function upstream(games: unknown, stats?: (url: string) => Response | object) {
	const calls: string[] = [];
	const fetchImpl = (async (input: unknown) => {
		const url = String(input);
		calls.push(url);
		if (url.includes('/v1/games')) return json(games);
		if (stats !== undefined) {
			const answer = stats(url);
			return answer instanceof Response ? answer : json(answer);
		}
		return json({ data: [] });
	}) as unknown as typeof globalThis.fetch;
	return { fetchImpl, calls };
}

interface Setup {
	cached?: unknown[];
	/** A queue of select responses, for a test that reads the cache twice. */
	cachedQueue?: FakeResponse[];
	withStats?: number[];
	budget: ReturnType<typeof budget>;
	teamsUpsert?: { data?: unknown; error?: { message: string; code?: string } };
	gamesUpsert?: { data?: unknown; error?: { message: string; code?: string } };
	statsUpsert?: { data?: unknown; error?: { message: string; code?: string } };
	statsSelect?: { data?: unknown; error?: { message: string; code?: string } };
}

function makeFake(setup: Setup) {
	const gamesSelect = setup.cachedQueue ?? [{ data: setup.cached ?? [] }];
	return new FakeSupabase({
		tables: {
			games: {
				select: gamesSelect,
				upsert: setup.gamesUpsert ?? { data: [] },
			},
			teams: { upsert: setup.teamsUpsert ?? { data: [] } },
			player_stats: {
				select: setup.statsSelect ?? { data: (setup.withStats ?? []).map((game_id) => ({ game_id })) },
				upsert: setup.statsUpsert ?? { data: [] },
			},
		},
		rpc: { consume_upstream_budget: setup.budget.responder },
	});
}

function options(fake: FakeSupabase, fetchImpl: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
	return {
		client: fake.asClient(),
		env: ENV,
		fetch: fetchImpl,
		now: () => FIXED_NOW,
		...over,
	};
}

async function refresh(setup: Setup, games: unknown, stats?: (url: string) => Response | object, over: Record<string, unknown> = {}) {
	const fake = makeFake(setup);
	const api = upstream(games, stats);
	return { result: await refreshSlate(DAY, options(fake, api.fetchImpl, over)), fake, api };
}

function reportOf(result: Awaited<ReturnType<typeof refreshSlate>>): SlateRefreshReport {
	if (!result.ok) throw new Error(`expected a report, got ${JSON.stringify(result.error)}`);
	return result.value;
}

describe('the cache answers a refresh when it can', () => {
	it('spends nothing while a live one is a minute fresh', async () => {
		const { result, api, fake } = await refresh({ cached: [cachedGame()], budget: budget({ limit: 400 }) }, { data: [] });

		const report = reportOf(result);
		expect(report.status).toBe('fresh');
		expect(report.requests.total).toBe(0);
		expect(api.calls).toEqual([]);
		expect(fake.rpcCalls).toEqual([]);
		expect(report.notes[0]).toContain('a game is still being played');
	});

	it('spends nothing on a settled slate for half a day', async () => {
		const cached = [cachedGame({ status: 'Final', period: 4, ingested_at: new Date(FIXED_NOW - 60 * 60 * 1000).toISOString() })];
		const { result, api } = await refresh({ cached, budget: budget({ limit: 400 }) }, { data: [] });

		const report = reportOf(result);
		expect(report.status).toBe('fresh');
		expect(api.calls).toEqual([]);
		expect(report.notes[0]).toContain('every game is final');
	});

	it('refreshes once the live window expires', async () => {
		const cached = [cachedGame({ ingested_at: new Date(FIXED_NOW - 2 * 60 * 1000).toISOString() })];
		const { result, api } = await refresh(
			{ cached, budget: budget({ limit: 400 }), withStats: [5001] },
			{ data: [LIVE_GAME] },
		);

		expect(reportOf(result).status).toBe('refreshed');
		expect(api.calls[0]).toContain('/v1/games?dates[]=2026-10-27');
	});

	it('refreshes a day with nothing cached at all', async () => {
		const { result, api } = await refresh({ budget: budget({ limit: 400 }) }, { data: [] });

		expect(reportOf(result).status).toBe('refreshed');
		expect(api.calls).toHaveLength(1);
	});

	it('spends nothing on the second refresh inside the window', async () => {
		// Two cache reads: empty, then the day as the first refresh left it.
		const { result, api } = await refresh(
			{
				cachedQueue: [{ data: [] }, { data: [cachedGame({ ingested_at: new Date(FIXED_NOW).toISOString() })] }],
				budget: budget({ limit: 400 }),
			},
			{ data: [LIVE_GAME] },
			() => ({ data: [STAT_ROW] }),
		);

		expect(reportOf(result).status).toBe('refreshed');
		expect(api.calls).toHaveLength(2);

		// Second time through, with the same clock: the cache is fresh, so nothing
		// upstream and nothing from the ledger.
		const fake = makeFake({ cachedQueue: [{ data: [cachedGame({ ingested_at: new Date(FIXED_NOW).toISOString() })] }], budget: budget({ limit: 400 }) });
		const again = reportOf(await refreshSlate(DAY, options(fake, api.fetchImpl)));
		expect(again.status).toBe('fresh');
		expect(again.requests.total).toBe(0);
		expect(api.calls).toHaveLength(2);
	});
});

describe('a refresh records exactly what it spent', () => {
	it('costs one games request and one stats request per live game', async () => {
		const second = { ...LIVE_GAME, id: 5003 };
		const ledger = budget({ limit: 400 });
		const { result, api } = await refresh(
			{ budget: ledger },
			{ data: [LIVE_GAME, second] },
			() => ({ data: [STAT_ROW] }),
		);

		const report = reportOf(result);
		expect(report.requests).toEqual({ games: 1, stats: 2, total: 3 });
		expect(ledger.used()).toBe(3);
		expect(report.budget?.requestsUsed).toBe(3);
		expect(api.calls.filter((url) => url.includes('/v1/stats'))).toHaveLength(2);
		// One game per stats request, so a refusal loses one box score rather than all.
		expect(api.calls[1]).toContain('game_ids[]=5001');
		expect(api.calls[2]).toContain('game_ids[]=5003');
	});

	it('re-reads a game that has just gone final, once', async () => {
		const ledger = budget({ limit: 400 });
		const { result } = await refresh({ budget: ledger, withStats: [] }, { data: [FINAL_GAME] }, () => ({ data: [STAT_ROW] }));

		const report = reportOf(result);
		expect(report.requests.stats).toBe(1);
		expect(report.statRows).toBe(1);
	});

	it('does not re-read a settled game whose box score is already stored', async () => {
		const ledger = budget({ limit: 400 });
		const { result, api } = await refresh({ budget: ledger, withStats: [5002] }, { data: [FINAL_GAME] }, () => ({ data: [STAT_ROW] }));

		const report = reportOf(result);
		expect(report.requests).toEqual({ games: 1, stats: 0, total: 1 });
		expect(api.calls).toHaveLength(1);
	});
});

describe('writes', () => {
	it('upserts teams and games on their upstream ids', async () => {
		const { result, fake } = await refresh({ budget: budget({ limit: 400 }), withStats: [5001] }, { data: [LIVE_GAME] });
		expect(reportOf(result).status).toBe('refreshed');

		const teams = fake.recorded('teams', 'upsert');
		expect(teams?.onConflict).toBe('id');
		expect((teams?.payload as Array<Record<string, unknown>>).map((row) => row.abbreviation)).toEqual(['BOS', 'LAL']);

		const games = fake.recorded('games', 'upsert');
		expect(games?.onConflict).toBe('id');
		const [game] = games?.payload as Array<Record<string, unknown>>;
		expect(game).toMatchObject({
			id: 5001,
			game_date: DAY,
			status: '2nd Qtr',
			period: 2,
			clock: '4:31',
			postseason: false,
			home_team_id: 1,
			visitor_team_id: 2,
			home_score: 51,
			visitor_score: 48,
			home_q1: 28,
			home_q2: 23,
			home_q3: null,
			home_q4: null,
			visitor_q1: 25,
			ingested_at: new Date(FIXED_NOW).toISOString(),
			in_bonus: { home: true, visitor: false },
			timeouts_remaining: { home: 4, visitor: 5 },
		});
		// The object as received, kept so a shape change is diagnosable later.
		expect(game?.raw).toEqual(LIVE_GAME);
	});

	it('keeps an absent bonus or clock pair null rather than inventing false', async () => {
		const { fake } = await refresh({ budget: budget({ limit: 400 }), withStats: [] }, { data: [FINAL_GAME] }, () => ({ data: [] }));

		const [game] = fake.recorded('games', 'upsert')?.payload as Array<Record<string, unknown>>;
		expect(game?.in_bonus).toBeNull();
		expect(game?.timeouts_remaining).toBeNull();
	});

	it('writes box score rows keyed by the pair the table keys them on', async () => {
		const { fake } = await refresh({ budget: budget({ limit: 400 }) }, { data: [LIVE_GAME] }, () => ({ data: [STAT_ROW] }));

		const stats = fake.recorded('player_stats', 'upsert');
		expect(stats?.onConflict).toBe('game_id,player_id');
		const [row] = stats?.payload as Array<Record<string, unknown>>;
		expect(row).toMatchObject({
			game_id: 5001,
			player_id: 900,
			player_name: 'Jayson Tatum',
			team_id: 1,
			min: '34:12',
			pts: 27,
			fg3a: 8,
		});
	});

	it('reports a refused write rather than reporting success', async () => {
		const { result } = await refresh(
			{ budget: budget({ limit: 400 }), gamesUpsert: { data: null, error: { message: 'permission denied', code: '42501' } } },
			{ data: [LIVE_GAME] },
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('denied');
	});
});

describe('degradation', () => {
	it('does not send the games request when the allowance is already spent', async () => {
		const { result, api } = await refresh({ budget: budget({ limit: 400, alreadyUsed: 400 }) }, { data: [LIVE_GAME] });

		const report = reportOf(result);
		expect(report.status).toBe('degraded');
		expect(report.requests.total).toBe(0);
		expect(api.calls).toEqual([]);
		expect(report.notes.join(' ')).toContain('budget-spent');
	});

	it('writes the slate and stops when the allowance runs out before the box scores', async () => {
		const { result, api } = await refresh({ budget: budget({ limit: 1 }) }, { data: [LIVE_GAME] }, () => ({ data: [STAT_ROW] }));

		const report = reportOf(result);
		expect(report.status).toBe('degraded');
		expect(report.requests).toEqual({ games: 1, stats: 0, total: 1 });
		expect(report.games).toBe(1);
		expect(report.skipped).toEqual([{ gameId: 5001, reason: 'budget-spent' }]);
		// The stats request was never sent: the ledger refused it first.
		expect(api.calls).toHaveLength(1);
	});

	it('stops asking for box scores when the endpoint is not entitled, as this key is not', async () => {
		const second = { ...LIVE_GAME, id: 5003 };
		const { result, api } = await refresh(
			{ budget: budget({ limit: 400 }) },
			{ data: [LIVE_GAME, second] },
			() => new Response('Unauthorized', { status: 401 }),
		);

		const report = reportOf(result);
		expect(report.status).toBe('degraded');
		expect(report.skipped).toEqual([{ gameId: 5001, reason: 'unauthorized' }]);
		// One retry is not attempted for a 401, and the second game is not tried at
		// all: the refusal will not change between games.
		expect(api.calls).toHaveLength(2);
		expect(report.games).toBe(2);
	});

	it('carries on to the next game after a failure that might not repeat', async () => {
		const second = { ...LIVE_GAME, id: 5003 };
		const { result } = await refresh({ budget: budget({ limit: 400 }) }, { data: [LIVE_GAME, second] }, (url) =>
			url.includes('5001') ? json({ error: 'gateway' }, 502) : { data: [STAT_ROW] },
		);

		const report = reportOf(result);
		expect(report.status).toBe('degraded');
		expect(report.skipped).toEqual([{ gameId: 5001, reason: 'rejected' }]);
		expect(report.statRows).toBe(1);
	});

	it('serves the cache rather than throwing when the games request fails', async () => {
		const { result } = await refresh({ budget: budget({ limit: 400 }) }, { error: 'unavailable' }, undefined, {});
		// The stub above returns a payload without `data`, so this is malformed.
		const report = reportOf(result);
		expect(report.status).toBe('degraded');
		expect(report.games).toBe(0);
	});

	it('reports an unreachable upstream as a degraded refresh', async () => {
		const fake = makeFake({ budget: budget({ limit: 400 }) });
		const fetchImpl = (async () => {
			throw new Error('fetch failed');
		}) as unknown as typeof globalThis.fetch;

		const report = reportOf(await refreshSlate(DAY, options(fake, fetchImpl)));
		expect(report.status).toBe('degraded');
		expect(report.notes.join(' ')).toContain('unreachable');
	});
});

describe('input and payload problems', () => {
	it('refuses a date that is not a calendar date, without touching anything', async () => {
		const fake = makeFake({ budget: budget({ limit: 400 }) });
		const api = upstream({ data: [] });
		const result = await refreshSlate('27-10-2026', options(fake, api.fetchImpl));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('error');
		expect(api.calls).toEqual([]);
		expect(fake.calls).toEqual([]);
	});

	it('answers not-configured when there is no database client', async () => {
		const result = await refreshSlate(DAY, { client: null, env: ENV });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});

	it('records a game it cannot read instead of stopping', async () => {
		const { result, fake } = await refresh(
			{ budget: budget({ limit: 400 }), withStats: [] },
			{ data: [{ status: 'Final' }, FINAL_GAME] },
			() => ({ data: [] }),
		);

		const report = reportOf(result);
		expect(report.problems.join(' ')).toContain('without an id');
		expect(report.games).toBe(1);
		expect((fake.recorded('games', 'upsert')?.payload as unknown[]).length).toBe(1);
	});

	it('records a stat row it cannot read', async () => {
		const { result } = await refresh({ budget: budget({ limit: 400 }) }, { data: [LIVE_GAME] }, () => ({
			data: [{ pts: 4 }],
		}));

		expect(reportOf(result).problems.join(' ')).toContain('without its game, player or name');
	});
});

describe('mapping upstream payloads', () => {
	const ingestedAt = new Date(FIXED_NOW).toISOString();

	it('calls a game with an in-progress state live even without a period', () => {
		const slate = parseGames([{ ...LIVE_GAME, period: null }], DAY, ingestedAt);
		expect(slate.games[0]?.live).toBe(true);
	});

	it('treats a postponed game as settled and not live', () => {
		const slate = parseGames([{ ...FINAL_GAME, status: 'Postponed', postponed: true }], DAY, ingestedAt);
		expect(slate.games[0]?.settled).toBe(true);
		expect(slate.games[0]?.live).toBe(false);
	});

	it('does not call a scheduled game live just because the clock is past', () => {
		const slate = parseGames([{ ...LIVE_GAME, status: '9:30 pm ET', status_state: 'scheduled', period: null }], DAY, ingestedAt);
		expect(slate.games[0]?.live).toBe(false);
		expect(slate.games[0]?.settled).toBe(false);
	});

	it('names a team from the payload and de-duplicates it between games', () => {
		const slate = parseGames([LIVE_GAME, FINAL_GAME], DAY, ingestedAt);
		expect(slate.teams).toHaveLength(2);
		expect(slate.teams.map((team) => team.id).sort()).toEqual([1, 2]);
	});

	it('reads a stat row whose game is only identified by a flat game_id', () => {
		const { rows, problems } = parseStats([{ ...STAT_ROW, game: undefined, game_id: 5001 }], ingestedAt);
		expect(problems).toEqual([]);
		expect(rows[0]?.game_id).toBe(5001);
	});

	it('falls back to a flat player_name when the name is not split', () => {
		const { rows } = parseStats([{ ...STAT_ROW, player: { id: 900 }, player_name: 'Jayson Tatum' }], ingestedAt);
		expect(rows[0]?.player_name).toBe('Jayson Tatum');
	});
});
