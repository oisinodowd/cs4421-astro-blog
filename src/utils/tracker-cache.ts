/**
 * Reads of the tracker cache (#95), which is what the slate and game pages render
 * from (#98, #99).
 *
 * These are reads of a cache, never calls upstream: #97's ingest fills `teams`,
 * `games` and `player_stats`, and a page that fetched from balldontlie itself
 * would spend the shared daily allowance once per visitor. Keeping the reads here
 * is also what lets `deploy-static.yml` prerender nothing and the pages stay thin.
 *
 * `*` is selected rather than a column list, unlike `sessions.ts`: these tables
 * mirror an upstream payload whose shape has changed between seasons, and the
 * mapper below -- not the select list -- is what decides the shape a page gets.
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

export interface CachedTeam {
	id: number;
	abbreviation: string;
	city: string;
	name: string;
	fullName: string;
	conference: string | null;
	division: string | null;
}

export interface CachedGame {
	id: number;
	gameDate: string;
	/** Upstream text: "Final", "2nd Qtr". Whether that is live is the ingest's call. */
	status: string;
	period: number | null;
	clock: string | null;
	postseason: boolean;
	homeTeam: CachedTeam | null;
	visitorTeam: CachedTeam | null;
	homeScore: number | null;
	visitorScore: number | null;
	/** Four quarters, null where upstream has not played it yet. */
	homeQuarters: Array<number | null>;
	visitorQuarters: Array<number | null>;
	/**
	 * When the cache last saw this game. A page shows the age of it, so a stale
	 * snapshot is never presented as the current score.
	 */
	ingestedAt: string;
}

export interface CachedPlayerStat {
	playerId: number;
	playerName: string;
	teamId: number | null;
	/** Upstream sends minutes as text, e.g. "34:12". */
	min: string | null;
	pts: number | null;
	reb: number | null;
	ast: number | null;
	stl: number | null;
	blk: number | null;
	turnover: number | null;
	pf: number | null;
	fgm: number | null;
	fga: number | null;
	fg3m: number | null;
	fg3a: number | null;
	ftm: number | null;
	fta: number | null;
	oreb: number | null;
	dreb: number | null;
}

export interface CachedBoxScore {
	game: CachedGame;
	/** Highest scorer first, then by name, so the order is stable between reads. */
	players: CachedPlayerStat[];
}

// The foreign key names are what disambiguate two embeds of the same table: a
// game has a home team and a visitor team, and both are rows in `teams`.
const GAME_EMBEDS =
	'home:teams!games_home_team_id_fkey(*), visitor:teams!games_visitor_team_id_fkey(*)';

/** The day's games, in tip-off order as the cache holds them. */
export async function listGamesOn(
	gameDate: string,
	options: ClientOption = {},
): Promise<Result<CachedGame[]>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();

	const date = readCalendarDate(gameDate);
	if (date === null) {
		return failure('error', `gameDate must be a calendar date as YYYY-MM-DD, got ${JSON.stringify(gameDate)}`);
	}

	const response = await client
		.from('games')
		.select(`*, ${GAME_EMBEDS}`)
		.eq('game_date', date)
		.order('id', { ascending: true });

	if (response.error) return { ok: false, error: classifyError(response.error) };
	if (!Array.isArray(response.data)) return failure('error', 'expected a list of game rows');

	const games: CachedGame[] = [];
	for (const row of response.data) {
		const mapped = toGame(row);
		if (!mapped.ok) return mapped;
		games.push(mapped.value);
	}
	return success(games);
}

/** One game and its box score, which is one query and one nested read. */
export async function getGameBoxScore(
	gameId: number,
	options: ClientOption = {},
): Promise<Result<CachedBoxScore>> {
	const client = resolveClient(options);
	if (client === null) return notConfigured();
	if (!Number.isInteger(gameId)) {
		return failure('error', `gameId must be a whole number, got ${JSON.stringify(gameId)}`);
	}

	const response = await client
		.from('games')
		.select(`*, ${GAME_EMBEDS}, player_stats(*)`)
		.eq('id', gameId)
		.maybeSingle();

	if (response.error) return { ok: false, error: classifyError(response.error) };
	if (response.data === null || response.data === undefined) {
		return failure('not-found', 'no cached game with that id');
	}

	const game = toGame(response.data);
	if (!game.ok) return game;

	const stats = isRecord(response.data) ? response.data.player_stats : undefined;
	const players = toPlayerStats(stats ?? []);
	if (!players.ok) return players;

	return success({ game: game.value, players: players.value });
}

// --- mapping ----------------------------------------------------------------

function toGame(row: unknown): Result<CachedGame> {
	if (!isRecord(row)) return failure('error', 'expected a game row');

	const id = readNumber(row.id);
	const gameDate = readCalendarDate(row.game_date);
	const status = readString(row.status);
	const ingestedAt = readString(row.ingested_at);

	if (id === null || !Number.isInteger(id) || gameDate === null || status === null || ingestedAt === null) {
		return failure('error', 'a game row is missing a field: id, game_date, status, ingested_at');
	}

	return success({
		id,
		gameDate,
		status,
		period: readInteger(row.period),
		clock: readString(row.clock),
		postseason: row.postseason === true,
		homeTeam: toTeam(row.home),
		visitorTeam: toTeam(row.visitor),
		homeScore: readInteger(row.home_score),
		visitorScore: readInteger(row.visitor_score),
		homeQuarters: [row.home_q1, row.home_q2, row.home_q3, row.home_q4].map(readInteger),
		visitorQuarters: [row.visitor_q1, row.visitor_q2, row.visitor_q3, row.visitor_q4].map(readInteger),
		ingestedAt,
	});
}

/** An embed that matched no row, or one the ingest has not filled in yet. */
function toTeam(value: unknown): CachedTeam | null {
	if (!isRecord(value)) return null;

	const id = readNumber(value.id);
	const abbreviation = readString(value.abbreviation);
	const city = readString(value.city);
	const name = readString(value.name);
	const fullName = readString(value.full_name);
	if (id === null || abbreviation === null || city === null || name === null || fullName === null) {
		return null;
	}

	return {
		id,
		abbreviation,
		city,
		name,
		fullName,
		conference: readString(value.conference),
		division: readString(value.division),
	};
}

function toPlayerStats(rows: unknown): Result<CachedPlayerStat[]> {
	if (!Array.isArray(rows)) return failure('error', 'expected the box score to be a list');

	const players: CachedPlayerStat[] = [];
	for (const row of rows) {
		if (!isRecord(row)) return failure('error', 'expected a player stat row');

		const playerId = readNumber(row.player_id);
		const playerName = readString(row.player_name);
		if (playerId === null || !Number.isInteger(playerId) || playerName === null) {
			return failure('error', 'a player stat row is missing its player_id or player_name');
		}

		players.push({
			playerId,
			playerName,
			teamId: readInteger(row.team_id),
			min: readString(row.min),
			pts: readInteger(row.pts),
			reb: readInteger(row.reb),
			ast: readInteger(row.ast),
			stl: readInteger(row.stl),
			blk: readInteger(row.blk),
			turnover: readInteger(row.turnover),
			pf: readInteger(row.pf),
			fgm: readInteger(row.fgm),
			fga: readInteger(row.fga),
			fg3m: readInteger(row.fg3m),
			fg3a: readInteger(row.fg3a),
			ftm: readInteger(row.ftm),
			fta: readInteger(row.fta),
			oreb: readInteger(row.oreb),
			dreb: readInteger(row.dreb),
		});
	}

	// A player who did not score sorts last rather than first.
	return success(
		players.sort(
			(a, b) => (b.pts ?? -1) - (a.pts ?? -1) || a.playerName.localeCompare(b.playerName),
		),
	);
}

function readInteger(value: unknown): number | null {
	const parsed = readNumber(value);
	if (parsed === null || !Number.isInteger(parsed)) return null;
	return parsed;
}
