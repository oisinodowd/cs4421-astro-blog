import { describe, expect, it } from 'vitest';

import { createBalldontlieClient, type BudgetSpend } from './balldontlie';

const KEY = 'test-key-do-not-log';
const ENV = { BALLDONTLIE_API_KEY: KEY };

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that records what it was called with, and answers from a script. */
function fetchScript(responses: Array<Response | (() => Response | Promise<Response>)>) {
	const calls: Array<{ url: string; authorization: string | null }> = [];
	let index = 0;

	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url: String(input), authorization: headers.authorization ?? null });
		const next = responses[Math.min(index, responses.length - 1)];
		index++;
		// Cloned, because a Response body can only be read once and a scripted
		// response is meant to be usable by more than one request.
		return typeof next === 'function' ? await next() : next.clone();
	}) as unknown as typeof globalThis.fetch;

	return { fetchImpl, calls, count: () => index };
}

/** A budget that allows a fixed number of requests and records who asked. */
function budgetAllowing(allowedCount: number) {
	let asked = 0;
	const guard = async (): Promise<BudgetSpend> => {
		asked++;
		const allowed = asked <= allowedCount;
		return { allowed, requestsUsed: allowed ? asked : allowedCount, dailyLimit: allowedCount };
	};
	return { guard, asked: () => asked };
}

function client(fetchImpl: typeof globalThis.fetch, budget: () => Promise<BudgetSpend>, maxPages = 3) {
	return createBalldontlieClient({
		env: ENV,
		fetch: fetchImpl,
		budget,
		retryDelayMs: 0,
		timeoutMs: 50,
		maxPages,
	});
}

describe('the client refuses to spend without permission', () => {
	it('sends nothing when there is no API key', async () => {
		const script = fetchScript([json({ data: [] })]);
		const budget = budgetAllowing(10);
		const result = await createBalldontlieClient({
			env: {},
			fetch: script.fetchImpl,
			budget: budget.guard,
		}).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
		expect(script.count()).toBe(0);
		expect(budget.asked()).toBe(0);
	});

	it('sends nothing when the shared allowance is already spent', async () => {
		const script = fetchScript([json({ data: [] })]);
		const budget = budgetAllowing(0);
		const result = await client(script.fetchImpl, budget.guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('budget-spent');
		expect(result.error.message).toContain('0/0');
		expect(script.count()).toBe(0);
	});

	it('counts a retry as a second request, and lets the budget refuse it', async () => {
		// One 429, and only one request of allowance: the retry is refused, so the
		// caller learns the request was rate-limited rather than that it retried.
		const script = fetchScript([json({ error: 'slow down' }, 429), json({ data: [{ id: 1 }] })]);
		const budget = budgetAllowing(1);
		const result = await client(script.fetchImpl, budget.guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('budget-spent');
		expect(script.count()).toBe(1);
		expect(budget.asked()).toBe(2);
	});
});

describe('listGames', () => {
	it('asks for one day, and reports what the call cost', async () => {
		const script = fetchScript([json({ data: [{ id: 1 }, { id: 2 }] })]);
		const budget = budgetAllowing(10);
		const result = await client(script.fetchImpl, budget.guard).listGames('2026-10-27');

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.rows).toHaveLength(2);
		expect(result.value.requests).toBe(1);
		expect(script.calls[0]?.url).toBe('https://api.balldontlie.io/v1/games?dates[]=2026-10-27&per_page=100');
	});

	it('sends the key in the authorization header and nowhere else', async () => {
		const script = fetchScript([json({ data: [] })]);
		await client(script.fetchImpl, budgetAllowing(5).guard).listGames('2026-10-27');

		expect(script.calls[0]?.authorization).toBe(KEY);
		expect(script.calls[0]?.url).not.toContain(KEY);
	});

	it('refuses a date that is not a calendar date, without asking for budget', async () => {
		const script = fetchScript([json({ data: [] })]);
		const budget = budgetAllowing(5);
		const result = await client(script.fetchImpl, budget.guard).listGames('Tuesday');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed');
		expect(script.count()).toBe(0);
		expect(budget.asked()).toBe(0);
	});

	it('follows a cursor, and counts each page as a request', async () => {
		const script = fetchScript([
			json({ data: [{ id: 1 }], meta: { next_cursor: 25 } }),
			json({ data: [{ id: 2 }] }),
		]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.rows.map((row) => row.id)).toEqual([1, 2]);
		expect(result.value.requests).toBe(2);
		expect(script.calls[1]?.url).toContain('cursor=25');
	});

	it('stops at the page bound rather than spending without limit', async () => {
		const script = fetchScript([json({ data: [{ id: 1 }], meta: { next_cursor: 25 } })]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard, 2).listGames('2026-10-27');

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.requests).toBe(2);
		expect(script.count()).toBe(2);
	});
});

describe('failures are classified, never thrown', () => {
	it('reads an entitlement refusal as unauthorized, body and all', async () => {
		// This is the shape the real key gets from /stats: a 401 with a plain-text
		// body, which must not be mistaken for a malformed JSON payload.
		const script = fetchScript([new Response('Unauthorized', { status: 401 })]);
		const result = await client(script.fetchImpl, budgetAllowing(5).guard).listStats([1]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('unauthorized');
		expect(result.error.status).toBe(401);
		expect(result.error.message).toBe('Unauthorized');
	});

	it('redacts the key even if upstream echoes it back', async () => {
		const script = fetchScript([new Response(`bad key ${KEY}`, { status: 403 })]);
		const result = await client(script.fetchImpl, budgetAllowing(5).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(JSON.stringify(result.error)).not.toContain(KEY);
		expect(result.error.message).toContain('[redacted]');
	});

	it('retries a 429 once, then succeeds', async () => {
		const script = fetchScript([json({ error: 'rate limited' }, 429), json({ data: [{ id: 7 }] })]);
		const budget = budgetAllowing(10);
		const result = await client(script.fetchImpl, budget.guard).listGames('2026-10-27');

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.requests).toBe(2);
		expect(budget.asked()).toBe(2);
	});

	it('retries a 5xx once, then reports the refusal', async () => {
		const script = fetchScript([json({ error: 'upstream is unwell' }, 503)]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('rejected');
		expect(result.error.status).toBe(503);
		expect(script.count()).toBe(2);
	});

	it('does not retry a 4xx that a retry cannot fix', async () => {
		const script = fetchScript([json({ error: 'bad request' }, 400)]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		expect(script.count()).toBe(1);
	});

	it('reads a timeout as a timeout', async () => {
		const script = fetchScript([
			() => {
				const error = new Error('the operation was aborted');
				error.name = 'TimeoutError';
				throw error;
			},
		]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('timeout');
	});

	it('reads a transport failure as unreachable', async () => {
		const script = fetchScript([
			() => {
				throw new Error('fetch failed');
			},
		]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('unreachable');
	});

	it('reads a 200 that is not JSON as malformed', async () => {
		const script = fetchScript([new Response('<html>maintenance</html>', { status: 200 })]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed');
	});

	it('reads a 200 without a data array as malformed', async () => {
		const script = fetchScript([json({ meta: { per_page: 25 } })]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed');
	});

	it('refuses a data array holding something that is not an object', async () => {
		const script = fetchScript([json({ data: [{ id: 1 }, 'nonsense'] })]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listGames('2026-10-27');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('not an object');
	});
});

describe('listStats', () => {
	it('asks for whole games at a time', async () => {
		const script = fetchScript([json({ data: [{ id: 1 }] })]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listStats([5001, 5002]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(script.calls[0]?.url).toBe(
			'https://api.balldontlie.io/v1/stats?game_ids[]=5001&game_ids[]=5002&per_page=100',
		);
	});

	it('refuses an empty game list rather than asking for everything', async () => {
		const script = fetchScript([json({ data: [] })]);
		const result = await client(script.fetchImpl, budgetAllowing(10).guard).listStats([]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed');
		expect(script.count()).toBe(0);
	});
});
