/**
 * The slate and game views' decisions, kept out of the templates (#98, #99).
 *
 * Everything here is a pure function of rows the cache already holds: which
 * quarter a line belongs to, what to call a game's state, who led the box score,
 * how old a snapshot is. The pages render the result and decide styling; they do
 * not re-derive a meaning from a status string, which is how two pages end up
 * disagreeing about whether a game is live.
 *
 * Nothing in here fetches, and nothing throws: an upstream field the cache could
 * not read is already `null` by the time it arrives, and each function says what
 * a null means in its own terms (`—`, `TBD`, no line).
 */
import type { CachedGame, CachedPlayerStat, CachedTeam } from './tracker-cache';

export interface GameStatus {
	/** What the page shows, e.g. "Final", "Q3 · 4:31", "9:30 pm ET". */
	label: string;
	live: boolean;
	settled: boolean;
}

/**
 * The zone a slate belongs to. A 7pm tip-off in New York is already tomorrow in
 * UTC, so the day a page asks about is the Eastern one, here and in the pages.
 */
export const TRACKER_TIME_ZONE = 'America/New_York';

/** The number of players a game page leads with before the full table. */
export const TOP_PERFORMERS = 5;

/**
 * Upstream puts a scheduled game's tip-off in `status` as an ISO timestamp, not
 * as a time a person would read. Formatted in the tracker's zone, with the zone
 * named literally: ICU's own abbreviation varies with the runtime's tz data.
 */
function tipOffLabel(status: string): string {
	const at = Date.parse(status);
	if (!Number.isFinite(at)) return status;

	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: TRACKER_TIME_ZONE,
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).formatToParts(new Date(at));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? '';
	return `${part('hour')}:${part('minute')} ${part('dayPeriod')} ET`;
}

function periodLabel(period: number): string {
	if (period <= 4) return `Q${period}`;
	if (period === 5) return 'OT';
	return `${period - 4}OT`;
}

function isFinal(status: string): boolean {
	return /final/i.test(status);
}

/**
 * A game's state, read the same way the ingest reads it (#97): postponed and
 * final are settled; anything else with a period is being played. A scheduled
 * game has no period and shows upstream's own text, which is the tip-off time.
 */
export function describeStatus(game: CachedGame): GameStatus {
	if (/postponed/i.test(game.status)) return { label: 'Postponed', live: false, settled: true };
	if (isFinal(game.status)) return { label: 'Final', live: false, settled: true };
	if (game.period !== null && game.period > 0) {
		const clock = game.clock === null ? '' : ` · ${game.clock}`;
		return { label: `${periodLabel(game.period)}${clock}`, live: true, settled: false };
	}
	// Not started: the cache stores no tip-off column, and upstream's status is
	// where it puts one -- an ISO timestamp for a scheduled game.
	return { label: tipOffLabel(game.status), live: false, settled: false };
}

export interface QuarterLine {
	label: string;
	home: number | null;
	visitor: number | null;
}

/**
 * The line score, one row per quarter plus the total.
 *
 * A quarter upstream has not played is null and the page prints an em dash; the
 * total is the score, so a game in overtime still sums to more than its four
 * quarters and the table does not pretend otherwise.
 */
export function quarterLines(game: CachedGame): QuarterLine[] {
	const rows: QuarterLine[] = game.homeQuarters.map((home, index) => ({
		label: `Q${index + 1}`,
		home,
		visitor: game.visitorQuarters[index] ?? null,
	}));
	rows.push({ label: 'T', home: game.homeScore, visitor: game.visitorScore });
	return rows;
}

/** The team's short name, or `TBD` when the embed matched nothing. */
export function teamLabel(team: CachedTeam | null): string {
	return team?.abbreviation ?? 'TBD';
}

/** "LAL @ UTA" for a heading; the visitor is named first, as a fixture is. */
export function matchup(game: CachedGame): string {
	return `${teamLabel(game.visitorTeam)} @ ${teamLabel(game.homeTeam)}`;
}

/** When the cache last saw any of these games, or null if none carries a time. */
export function latestIngestedAt(games: CachedGame[]): string | null {
	let newest: number | null = null;
	for (const game of games) {
		const at = Date.parse(game.ingestedAt);
		if (!Number.isFinite(at)) continue;
		if (newest === null || at > newest) newest = at;
	}
	return newest === null ? null : new Date(newest).toISOString();
}

/** How long ago a snapshot was taken, in words a visitor can act on. */
export function formatAge(ms: number): string {
	const seconds = Math.round(Math.max(0, ms) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.floor(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * How old a snapshot may be before a page stops presenting it as current. Half a
 * day is fine for a final score; five minutes is not for a game in progress.
 */
export const STALE_LIVE_MS = 5 * 60 * 1000;
export const STALE_SETTLED_MS = 12 * 60 * 60 * 1000;

/** No snapshot at all is treated as stale: there is nothing to vouch for. */
export function isStale(ageMs: number | null, live: boolean): boolean {
	if (ageMs === null || !Number.isFinite(ageMs)) return true;
	return ageMs > (live ? STALE_LIVE_MS : STALE_SETTLED_MS);
}

export interface BoxScoreView {
	/** The leaders, highest scorer first. */
	top: CachedPlayerStat[];
	/** Every player in the same order, for the table underneath. */
	full: CachedPlayerStat[];
	total: number;
}

/**
 * Split a box score into the part a page leads with and the part it keeps
 * available. The cache already sorts by points, but this sorts again so the
 * order is a property of the view rather than an assumption about the query.
 */
export function splitBoxScore(players: CachedPlayerStat[], topCount = TOP_PERFORMERS): BoxScoreView {
	const full = [...players].sort(
		(a, b) => (b.pts ?? -1) - (a.pts ?? -1) || a.playerName.localeCompare(b.playerName),
	);
	return { top: full.slice(0, Math.max(0, topCount)), full, total: full.length };
}

/**
 * "10/20" for a shooting line, an em dash when upstream did not send both
 * halves: a made shot count on its own is not a percentage and should not be
 * printed as one.
 */
export function shotLine(made: number | null, attempted: number | null): string {
	if (made === null || attempted === null) return '—';
	return `${made}/${attempted}`;
}
