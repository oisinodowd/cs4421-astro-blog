/**
 * The shared upstream request budget (#97 spends it, #101 degrades when it says
 * no).
 *
 * The accounting lives in the database rather than in process memory because the
 * service runs two ECS tasks: an in-process counter would be two counters, each
 * believing it held the whole daily allowance. `consume_upstream_budget` does its
 * read and its write in one statement, so two tasks calling it in the same
 * instant cannot both spend the last request.
 */
import {
	classifyError,
	failure,
	isRecord,
	notConfigured,
	readNumber,
	resolveClient,
	success,
	type ClientOption,
	type Result,
} from './db';

export interface BudgetDecision {
	/** False when there was no headroom: a rejected call spends nothing. */
	allowed: boolean;
	requestsUsed: number;
	dailyLimit: number;
}

export interface ConsumeBudgetOptions extends ClientOption {
	/** How many requests this call is spending. Defaults to one. */
	cost?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Consume `cost` requests from the UTC day's allowance.
 *
 * `day` is passed in rather than read from the clock here, so a caller can ask
 * about the same day twice -- an ingest refreshing a slate, then replenishing a
 * live game -- and so a test does not have to move the clock.
 */
export async function consumeBudget(
	day: string,
	dailyLimit: number,
	options: ConsumeBudgetOptions = {},
): Promise<Result<BudgetDecision>> {
	const client = resolveClient(options);
	const cost = options.cost ?? 1;

	if (client === null) return notConfigured();
	if (typeof day !== 'string' || !DAY.test(day)) {
		return failure('error', `day must be a UTC date as YYYY-MM-DD, got ${JSON.stringify(day)}`);
	}
	if (!Number.isInteger(dailyLimit) || dailyLimit <= 0) {
		return failure('error', `dailyLimit must be a positive whole number, got ${dailyLimit}`);
	}
	if (!Number.isInteger(cost) || cost < 1) {
		return failure('error', `cost must be a positive whole number, got ${cost}`);
	}

	const response = await client.rpc('consume_upstream_budget', {
		p_day: day,
		p_limit: dailyLimit,
		p_cost: cost,
	});
	if (response.error) return { ok: false, error: classifyError(response.error) };

	// The function returns a table, so PostgREST answers with an array of one row.
	const rows = response.data;
	if (!Array.isArray(rows) || rows.length === 0) {
		return failure('error', 'consume_upstream_budget returned no row');
	}

	const row = rows[0];
	if (!isRecord(row)) return failure('error', 'consume_upstream_budget returned a row that is not an object');

	const allowed = row.allowed;
	const requestsUsed = readNumber(row.requests_used);
	const reportedLimit = readNumber(row.daily_limit);
	if (typeof allowed !== 'boolean' || requestsUsed === null || reportedLimit === null) {
		return failure('error', 'consume_upstream_budget returned a row without allowed, requests_used and daily_limit');
	}

	return success({ allowed, requestsUsed, dailyLimit: reportedLimit });
}
