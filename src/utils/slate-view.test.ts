import { describe, expect, it } from 'vitest';

import { parseGames, parseStats } from './slate-ingest';
import {
	describeStatus,
	formatAge,
	latestIngestedAt,
	isStale,
	matchup,
	quarterLines,
	shotLine,
	splitBoxScore,
	teamLabel,
} from './slate-view';
import { FakeSupabase } from './testing/fake-supabase';
import { GAME, GAME_STATS } from './testing/fixtures/nba';
import { getGameBoxScore, type CachedGame, type CachedTeam } from './tracker-cache';

const INGESTED_AT = '2026-10-26T02:00:00.000Z';

function toCachedTeam(team: typeof GAME.home_team): CachedTeam {
	return {
		id: team.id,
		abbreviation: team.abbreviation,
		city: team.city,
		name: team.name,
		fullName: team.full_name,
		conference: team.conference,
		division: team.division,
	};
}

/** The captured game as the cache hands it to a page. */
function cached(over: Partial<CachedGame> = {}): CachedGame {
	return {
		id: GAME.id,
		gameDate: GAME.date,
		status: GAME.status,
		period: GAME.period,
		clock: GAME.time,
		postseason: GAME.postseason,
		homeTeam: toCachedTeam(GAME.home_team),
		visitorTeam: toCachedTeam(GAME.visitor_team),
		homeScore: GAME.home_team_score,
		visitorScore: GAME.visitor_team_score,
		homeQuarters: [GAME.home_q1, GAME.home_q2, GAME.home_q3, GAME.home_q4],
		visitorQuarters: [GAME.visitor_q1, GAME.visitor_q2, GAME.visitor_q3, GAME.visitor_q4],
		ingestedAt: INGESTED_AT,
		...over,
	};
}

/** The captured game, read through the real ingest and the real cache mapper. */
function cachedGameWithStats() {
	const slate = parseGames([GAME], GAME.date, INGESTED_AT);
	const [mapped] = slate.games;
	if (mapped === undefined) throw new Error('the fixture did not map');

	const stats = parseStats(GAME_STATS.data, INGESTED_AT);
	if (stats.problems.length > 0) throw new Error(stats.problems.join('; '));

	const fake = new FakeSupabase({
		tables: {
			games: {
				select: {
					data: [{ ...mapped.row, home: GAME.home_team, visitor: GAME.visitor_team, player_stats: stats.rows }],
				},
			},
		},
	});
	return { fake, slate, stats };
}

describe('describeStatus', () => {
	it('names a live game by its period and the clock', () => {
		expect(describeStatus(cached({ status: '2nd Qtr', period: 2, clock: '4:31' }))).toEqual({
			label: 'Q2 · 4:31',
			live: true,
			settled: false,
		});
	});

	it('names overtime rather than inventing a fifth quarter', () => {
		expect(describeStatus(cached({ status: 'OT', period: 5, clock: '1:02' })).label).toBe('OT · 1:02');
		expect(describeStatus(cached({ status: '2nd OT', period: 6, clock: '0:14' })).label).toBe('2OT · 0:14');
	});

	it('drops the clock when upstream did not send one', () => {
		expect(describeStatus(cached({ status: '3rd Qtr', period: 3, clock: null })).label).toBe('Q3');
	});

	it('calls the captured final final', () => {
		expect(describeStatus(cached())).toEqual({ label: 'Final', live: false, settled: true });
	});

	it('treats a postponed game as settled, whatever else it says', () => {
		expect(describeStatus(cached({ status: 'Postponed', period: 1 }))).toEqual({
			label: 'Postponed',
			live: false,
			settled: true,
		});
	});

	it('shows a scheduled game\'s tip-off text and does not call it live', () => {
		expect(describeStatus(cached({ status: '9:30 pm ET', period: null, clock: null }))).toEqual({
			label: '9:30 pm ET',
			live: false,
			settled: false,
		});
	});

	it('turns upstream\'s ISO tip-off into a time a person reads', () => {
		// What the live endpoint actually sends for a scheduled game: the status is
		// the tip-off instant, and the period is 0.
		expect(describeStatus(cached({ status: '2026-10-28T23:00:00Z', period: null, clock: null }))).toEqual({
			label: '7:00 PM ET',
			live: false,
			settled: false,
		});
	});

	it('does not present a period of zero as a quarter, even if one reached the view', () => {
		expect(describeStatus(cached({ status: '2026-10-28T23:00:00Z', period: 0, clock: null })).label).toBe(
			'7:00 PM ET',
		);
	});
});

describe('quarterLines', () => {
	it('reads the captured line score quarter by quarter, then the total', () => {
		expect(quarterLines(cached())).toEqual([
			{ label: 'Q1', home: 47, visitor: 29 },
			{ label: 'Q2', home: 24, visitor: 45 },
			{ label: 'Q3', home: 29, visitor: 29 },
			{ label: 'Q4', home: 23, visitor: 29 },
			{ label: 'T', home: 123, visitor: 132 },
		]);
	});

	it('keeps a quarter that has not been played null instead of showing a zero', () => {
		const lines = quarterLines(
			cached({ status: '2nd Qtr', period: 2, homeQuarters: [28, 23, null, null], visitorQuarters: [25, null, null, null] }),
		);
		expect(lines[1]).toEqual({ label: 'Q2', home: 23, visitor: null });
		expect(lines[3]).toEqual({ label: 'Q4', home: null, visitor: null });
	});
});

describe('naming', () => {
	it('names the fixture visitor first', () => {
		expect(matchup(cached())).toBe('LAL @ UTA');
	});

	it('falls back to TBD for a team the cache could not embed', () => {
		expect(teamLabel(null)).toBe('TBD');
		expect(matchup(cached({ homeTeam: null }))).toBe('LAL @ TBD');
	});
});

describe('formatAge', () => {
	it('describes the age in the largest unit that still reads as a number', () => {
		expect(formatAge(0)).toBe('just now');
		expect(formatAge(45_000)).toBe('just now');
		expect(formatAge(60_000)).toBe('1 minute ago');
		expect(formatAge(9 * 60_000)).toBe('9 minutes ago');
		expect(formatAge(60 * 60_000)).toBe('1 hour ago');
		expect(formatAge(5 * 60 * 60_000)).toBe('5 hours ago');
		expect(formatAge(24 * 60 * 60_000)).toBe('1 day ago');
		expect(formatAge(3 * 24 * 60 * 60_000)).toBe('3 days ago');
	});

	it('never says a snapshot from the future is old', () => {
		expect(formatAge(-5_000)).toBe('just now');
	});
});

describe('latestIngestedAt', () => {
	it('answers the newest snapshot among the day\'s games', () => {
		const older = cached({ ingestedAt: '2026-10-26T01:00:00.000Z' });
		expect(latestIngestedAt([older, cached()])).toBe(INGESTED_AT);
	});

	it('ignores a timestamp it cannot read and answers null with nothing to read', () => {
		expect(latestIngestedAt([cached({ ingestedAt: 'not a time' })])).toBeNull();
		expect(latestIngestedAt([])).toBeNull();
	});
});

describe('isStale', () => {
	it('holds a live snapshot to minutes and a settled one to half a day', () => {
		expect(isStale(60_000, true)).toBe(false);
		expect(isStale(6 * 60_000, true)).toBe(true);
		expect(isStale(6 * 60_000, false)).toBe(false);
		expect(isStale(13 * 60 * 60_000, false)).toBe(true);
	});

	it('treats a snapshot with no timestamp as stale', () => {
		expect(isStale(null, false)).toBe(true);
	});
});

describe('shotLine', () => {
	it('prints a shooting line from both halves', () => {
		expect(shotLine(10, 20)).toBe('10/20');
		expect(shotLine(0, 0)).toBe('0/0');
	});

	it('refuses to print half a shooting line', () => {
		expect(shotLine(null, 5)).toBe('—');
		expect(shotLine(5, null)).toBe('—');
		expect(shotLine(null, null)).toBe('—');
	});
});

describe('the box score the game page renders', () => {
	it('shows every player the fixture contains, once, with the fixture\'s numbers', async () => {
		const { fake } = cachedGameWithStats();
		const result = await getGameBoxScore(GAME.id, { client: fake.asClient() });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const view = splitBoxScore(result.value.players);
		expect(view.total).toBe(GAME_STATS.data.length);
		expect(new Set(view.full.map((player) => player.playerId)).size).toBe(GAME_STATS.data.length);

		for (const row of GAME_STATS.data) {
			const player = view.full.find((entry) => entry.playerId === row.player.id);
			expect(player, row.player.last_name).toMatchObject({
				playerName: `${row.player.first_name} ${row.player.last_name}`,
				teamId: row.team.id,
				min: row.min,
				pts: row.pts,
				reb: row.reb,
				ast: row.ast,
				stl: row.stl,
				blk: row.blk,
				turnover: row.turnover,
				pf: row.pf,
				fgm: row.fgm,
				fga: row.fga,
				fg3m: row.fg3m,
				fg3a: row.fg3a,
				ftm: row.ftm,
				fta: row.fta,
				oreb: row.oreb,
				dreb: row.dreb,
			});
		}
	});

	it('leads with the five highest scorers, in order, and keeps the rest below', async () => {
		const { fake } = cachedGameWithStats();
		const result = await getGameBoxScore(GAME.id, { client: fake.asClient() });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const view = splitBoxScore(result.value.players);
		expect(view.top.map((player) => player.playerName)).toEqual([
			'Lauri Markkanen',
			'LeBron James',
			'Anthony Davis',
			'Collin Sexton',
			'Austin Reaves',
		]);
		expect(view.top.map((player) => player.pts)).toEqual([29, 27, 25, 22, 18]);
		// The full table still holds the leaders, not only the remainder.
		expect(view.full).toHaveLength(11);
		expect(view.full.slice(0, view.top.length).map((player) => player.playerId)).toEqual(
			view.top.map((player) => player.playerId),
		);
	});

	it('turns the fixture\'s three-point line into what the page prints', async () => {
		const { fake } = cachedGameWithStats();
		const result = await getGameBoxScore(GAME.id, { client: fake.asClient() });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const lebron = result.value.players.find((player) => player.playerId === 237);
		expect(lebron).toBeDefined();
		expect(shotLine(lebron?.fg3m ?? null, lebron?.fg3a ?? null)).toBe('3/7');
	});

	it('answers the captured game\'s line score from the same fixture', async () => {
		const { fake, slate } = cachedGameWithStats();
		const result = await getGameBoxScore(GAME.id, { client: fake.asClient() });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(slate.problems).toEqual([]);
		expect(result.value.game.homeScore).toBe(123);
		expect(result.value.game.visitorScore).toBe(132);
		expect(quarterLines(result.value.game).at(-1)).toEqual({ label: 'T', home: 123, visitor: 132 });
	});
});
