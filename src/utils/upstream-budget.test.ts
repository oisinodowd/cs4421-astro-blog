import { describe, expect, it } from 'vitest';

import { FakeSupabase } from './testing/fake-supabase';
import { consumeBudget } from './upstream-budget';

const DAY = '2026-10-27';
const LIMIT = 400;

function fakeWith(rows: unknown, error?: { message: string; code?: string }) {
	return new FakeSupabase({
		rpc: { consume_upstream_budget: error ? { data: null, error } : { data: rows } },
	});
}

describe('consumeBudget', () => {
	it('answers not-configured rather than throwing when there is no client', async () => {
		const result = await consumeBudget(DAY, LIMIT, { client: null });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not-configured');
	});

	it('spends a request and reports the count afterwards', async () => {
		const fake = fakeWith([{ allowed: true, requests_used: 7, daily_limit: LIMIT }]);
		const result = await consumeBudget(DAY, LIMIT, { client: fake.asClient() });

		expect(result).toEqual({ ok: true, value: { allowed: true, requestsUsed: 7, dailyLimit: LIMIT } });
		expect(fake.rpcCalls).toEqual([
			{ name: 'consume_upstream_budget', args: { p_day: DAY, p_limit: LIMIT, p_cost: 1 } },
		]);
	});

	it('passes a cost through, so one ingest can spend several requests at once', async () => {
		const fake = fakeWith([{ allowed: true, requests_used: 12, daily_limit: LIMIT }]);
		await consumeBudget(DAY, LIMIT, { cost: 5, client: fake.asClient() });

		expect(fake.rpcCalls[0]?.args.p_cost).toBe(5);
	});

	it('reports a refused call without treating it as an error', async () => {
		const fake = fakeWith([{ allowed: false, requests_used: LIMIT, daily_limit: LIMIT }]);
		const result = await consumeBudget(DAY, LIMIT, { client: fake.asClient() });

		expect(result).toEqual({ ok: true, value: { allowed: false, requestsUsed: LIMIT, dailyLimit: LIMIT } });
	});

	it('classifies a database failure instead of throwing it', async () => {
		const fake = fakeWith(null, { message: 'permission denied for function consume_upstream_budget' });
		const result = await consumeBudget(DAY, LIMIT, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('unavailable');
		expect(result.error.message).toContain('permission denied');
	});

	it('rejects a day that is not a calendar date, before spending a request', async () => {
		const fake = fakeWith([]);
		for (const day of ['27-10-2026', 'yesterday', '2026-1-1', '']) {
			const result = await consumeBudget(day, LIMIT, { client: fake.asClient() });
			expect(result.ok, `${day} should be refused`).toBe(false);
		}
		expect(fake.rpcCalls).toHaveLength(0);
	});

	it('rejects a limit or cost that is not a positive whole number', async () => {
		const fake = fakeWith([]);
		for (const [limit, cost] of [
			[0, 1],
			[-5, 1],
			[400, 0],
			[400, -1],
			[400.5, 1],
		] as Array<[number, number]>) {
			const result = await consumeBudget(DAY, limit, { cost, client: fake.asClient() });
			expect(result.ok, `limit ${limit}, cost ${cost} should be refused`).toBe(false);
		}
		expect(fake.rpcCalls).toHaveLength(0);
	});

	it('treats an empty result as an error rather than assuming an allowance', async () => {
		const fake = fakeWith([]);
		const result = await consumeBudget(DAY, LIMIT, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('no row');
	});

	it('rejects a row that does not carry the three fields it promises', async () => {
		const fake = fakeWith([{ allowed: true, requests_used: null }]);
		const result = await consumeBudget(DAY, LIMIT, { client: fake.asClient() });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('daily_limit');
	});
});
