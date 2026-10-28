import { describe, expect, it } from 'vitest';

import { FakeSupabase } from './testing/fake-supabase';
import { getGameBoxScore, latestSlateDate, listGamesOn, readSlateDay } from './tracker-cache';

const BOSTON = {
	id: 1,
	abbreviation: 'BOS',
	city: 'Boston',
	name: 'Celtics',
	full_name: 'Boston Celtics',
	conference: 'East',
	division: 'Atlantic',
	updated_at: '2026-10-27T20:00:00.000Z',
};

const LAKERS = { ...BOSTON, id: 2, abbreviation: 'LAL', city: 'Los Angeles', name: 'Lakers', full_name: 'Los Angeles Lakers', conference: 'West', division: 'Pacific' };

/** A row exactly as PostgREST returns one: upstream shapes, plus the embeds. */
const GAME_ROW = {
	id: 2234,
	game_date: '2026-10-27',
	status: '2nd Qtr',
	period: 2,
	clock: '4:31',
	postseason: false,
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
	in_bonus: { home: false, visitor: true },
	timeouts_remaining: null,
	raw: { id: 2234 },
	ingested_at: '2026-10-27T21:00:00.000Z',
	home: BOSTON,
	visitor: LAKERS,
};

function fakeWithGames(data: unknown, error?: { message: string; code?: string }) {
	return new FakeSupabase({ tables: { games: { select: { data, error: error ?? null } } } });
}

describe('listGamesOn', () => {
	it('answers not-configured when there is no client', async () => {
		const result = await listGamesOn('2026-10-27', { client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});

	it('refuses a date that is not a calendar date, without querying', async () => {
		const fake = fakeWithGames([]);
		for (const gameDate of ['2026-02-30', '27-10-2026', '']) {
			const result = await listGamesOn(gameDate, { client: fake.asClient() });
			expect(result.ok, gameDate).toBe(false);
		}
		expect(fake.calls).toHaveLength(0);
	});

	it('maps a game with both teams, the scores and the quarter lines', async () => {
		const fake = fakeWithGames([GAME_ROW]);
		const result = await listGamesOn('2026-10-27', { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [game] = result.value;
		expect(game).toEqual({
			id: 2234,
			gameDate: '2026-10-27',
			status: '2nd Qtr',
			period: 2,
			clock: '4:31',
			postseason: false,
			homeTeam: {
				id: 1,
				abbreviation: 'BOS',
				city: 'Boston',
				name: 'Celtics',
				fullName: 'Boston Celtics',
				conference: 'East',
				division: 'Atlantic',
			},
			visitorTeam: {
				id: 2,
				abbreviation: 'LAL',
				city: 'Los Angeles',
				name: 'Lakers',
				fullName: 'Los Angeles Lakers',
				conference: 'West',
				division: 'Pacific',
			},
			homeScore: 51,
			visitorScore: 48,
			homeQuarters: [28, 23, null, null],
			visitorQuarters: [25, 23, null, null],
			ingestedAt: '2026-10-27T21:00:00.000Z',
		});
	});

	it('asks for the two team embeds by foreign key, so home and visitor cannot swap', async () => {
		const fake = fakeWithGames([]);
		await listGamesOn('2026-10-27', { client: fake.asClient() });

		const columns = fake.recorded('games', 'select')?.columns ?? '';
		expect(columns).toContain('home:teams!games_home_team_id_fkey');
		expect(columns).toContain('visitor:teams!games_visitor_team_id_fkey');
	});

	it('filters to one day and keeps the cache order', async () => {
		const fake = fakeWithGames([]);
		await listGamesOn('2026-10-27', { client: fake.asClient() });

		const call = fake.recorded('games', 'select');
		expect(call?.filters).toEqual([{ column: 'game_date', operator: 'eq', value: '2026-10-27' }]);
		expect(call?.order).toEqual([{ column: 'id', ascending: true }]);
	});

	it('reports an empty slate as an empty list, not as an error', async () => {
		const fake = fakeWithGames([]);
		const result = await listGamesOn('2026-07-04', { client: fake.asClient() });

		expect(result).toEqual({ ok: true, value: [] });
	});

	it('leaves a team null when the embed matched nothing, rather than failing the page', async () => {
		const fake = fakeWithGames([{ ...GAME_ROW, home: null }]);
		const result = await listGamesOn('2026-10-27', { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value[0]?.homeTeam).toBeNull();
		expect(result.value[0]?.visitorTeam?.abbreviation).toBe('LAL');
	});

	it('reports a game row it cannot map', async () => {
		const fake = fakeWithGames([{ ...GAME_ROW, status: null }]);
		const result = await listGamesOn('2026-10-27', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('missing a field');
	});

	it('classifies a failed read', async () => {
		const fake = fakeWithGames(null, { message: 'relation "games" does not exist', code: '42P01' });
		const result = await listGamesOn('2026-10-27', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('error');
		expect(result.error.message).toContain('does not exist');
	});
});

describe('getGameBoxScore', () => {
	const stat = (over: Record<string, unknown>) => ({
		game_id: 2234,
		player_id: 900,
		player_name: 'Someone',
		team_id: 1,
		min: '34:12',
		pts: 0,
		reb: 0,
		ast: 0,
		stl: 0,
		blk: 0,
		turnover: 0,
		pf: 0,
		fgm: 0,
		fga: 0,
		fg3m: 0,
		fg3a: 0,
		ftm: 0,
		fta: 0,
		oreb: 0,
		dreb: 0,
		ingested_at: '2026-10-27T21:00:00.000Z',
		...over,
	});

	it('returns the game and its box score, top performers first', async () => {
		const fake = new FakeSupabase({
			tables: {
				games: {
					select: {
						data: [
							{
								...GAME_ROW,
								player_stats: [
									stat({ player_id: 900, player_name: 'Bench Guard', pts: 4 }),
									stat({ player_id: 901, player_name: 'Top Scorer', pts: 27, reb: 9 }),
									stat({ player_id: 902, player_name: 'Second Option', pts: 21 }),
								],
							},
						],
					},
				},
			},
		});
		const result = await getGameBoxScore(2234, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.game.id).toBe(2234);
		expect(result.value.players.map((player) => player.playerName)).toEqual([
			'Top Scorer',
			'Second Option',
			'Bench Guard',
		]);
		expect(result.value.players[0]?.min).toBe('34:12');
		expect(result.value.players[0]?.reb).toBe(9);
	});

	it('sorts a player who did not score last, not first', async () => {
		const fake = new FakeSupabase({
			tables: {
				games: {
					select: {
						data: [
							{
								...GAME_ROW,
								player_stats: [
									stat({ player_id: 900, player_name: 'Did Not Score', pts: null }),
									stat({ player_id: 901, player_name: 'Scored Two', pts: 2 }),
								],
							},
						],
					},
				},
			},
		});
		const result = await getGameBoxScore(2234, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.players.map((player) => player.playerName)).toEqual(['Scored Two', 'Did Not Score']);
	});

	it('maps a stat row that is all nulls apart from the identity columns', async () => {
		const fake = new FakeSupabase({
			tables: {
				games: {
					select: {
						data: [
							{
								...GAME_ROW,
								player_stats: [
									stat({
										pts: null,
										reb: null,
										ast: null,
										min: null,
										team_id: null,
										fgm: null,
										fga: null,
										fg3m: null,
										fg3a: null,
										ftm: null,
										fta: null,
										oreb: null,
										dreb: null,
										stl: null,
										blk: null,
										turnover: null,
										pf: null,
									}),
								],
							},
						],
					},
				},
			},
		});
		const result = await getGameBoxScore(2234, { client: fake.asClient() });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.players[0]).toMatchObject({ playerId: 900, pts: null, min: null, teamId: null });
	});

	it('answers not-found for an unknown game', async () => {
		const fake = new FakeSupabase({ tables: { games: { select: { data: [] } } } });
		const result = await getGameBoxScore(9999, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-found');
	});

	it('refuses an id that is not a whole number, without querying', async () => {
		const fake = new FakeSupabase({ tables: { games: { select: { data: [] } } } });
		for (const gameId of [1.5, Number.NaN]) {
			const result = await getGameBoxScore(gameId, { client: fake.asClient() });
			expect(result.ok, String(gameId)).toBe(false);
		}
		expect(fake.calls).toHaveLength(0);
	});

	it('classifies a failed read', async () => {
		const fake = new FakeSupabase({
			tables: { games: { select: { data: null, error: { message: 'permission denied', code: '42501' } } } },
		});
		const result = await getGameBoxScore(2234, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('denied');
	});

	it('answers not-configured when there is no client', async () => {
		const result = await getGameBoxScore(2234, { client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});
});

describe('latestSlateDate', () => {
	it('answers the most recent date in one row, newest first', async () => {
		const fake = fakeWithGames([{ game_date: '2026-10-25' }]);
		const result = await latestSlateDate({ client: fake.asClient() });

		expect(result).toEqual({ ok: true, value: '2026-10-25' });
		const call = fake.recorded('games', 'select');
		expect(call?.columns).toBe('game_date');
		expect(call?.order).toEqual([{ column: 'game_date', ascending: false }]);
		expect(call?.limit).toBe(1);
	});

	it('answers null when the cache holds no games at all', async () => {
		const fake = fakeWithGames([]);
		expect(await latestSlateDate({ client: fake.asClient() })).toEqual({ ok: true, value: null });
	});

	it('answers not-configured when there is no client', async () => {
		const result = await latestSlateDate({ client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});
});

describe('readSlateDay', () => {
	const marker = (over: Record<string, unknown> = {}) => ({
		game_date: '2026-10-27',
		games: 8,
		checked_at: '2026-10-27T21:00:00.000Z',
		...over,
	});

	function fakeWithMarker(data: unknown, error?: { message: string; code?: string }) {
		return new FakeSupabase({ tables: { slate_days: { select: { data, error: error ?? null } } } });
	}

	it('maps the row that says when the day was last checked', async () => {
		const fake = fakeWithMarker([marker()]);
		const result = await readSlateDay('2026-10-27', { client: fake.asClient() });

		expect(result).toEqual({
			ok: true,
			value: { gameDate: '2026-10-27', games: 8, checkedAt: '2026-10-27T21:00:00.000Z' },
		});
		const call = fake.recorded('slate_days', 'select');
		expect(call?.filters).toEqual([{ column: 'game_date', operator: 'eq', value: '2026-10-27' }]);
	});

	it('answers null for a day that has never been checked', async () => {
		const fake = fakeWithMarker([]);
		expect(await readSlateDay('2026-07-04', { client: fake.asClient() })).toEqual({ ok: true, value: null });
	});

	it('refuses a date that is not a calendar date, without querying', async () => {
		const fake = fakeWithMarker([]);
		const result = await readSlateDay('2026-02-30', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		expect(fake.calls).toHaveLength(0);
	});

	it('reports a marker row it cannot read', async () => {
		const fake = fakeWithMarker([marker({ checked_at: null })]);
		const result = await readSlateDay('2026-10-27', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('checked_at');
	});

	it('classifies a failed read, which the ingest treats as no marker', async () => {
		const fake = fakeWithMarker(null, { message: 'relation "slate_days" does not exist', code: '42P01' });
		const result = await readSlateDay('2026-10-27', { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('error');
	});

	it('answers not-configured when there is no client', async () => {
		const result = await readSlateDay('2026-10-27', { client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});
});
