/**
 * A fake of the slice of `@supabase/supabase-js` the data modules use (#95).
 *
 * It records every call, so a test can assert what a module actually sent, and
 * answers from a plan, so the mapping and the error paths are exercised without
 * a network. That is the point of the seam: `npm run test:unit` passes with no
 * credentials, nothing listening, and no chance of a red build caused by
 * somebody else's outage.
 *
 * Two behaviours are copied deliberately, because the modules depend on them:
 * `.single()` answers PGRST116 when it does not match exactly one row, and
 * `.maybeSingle()` answers null data with no error when it matches none.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type FakeOperation = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

export interface FakeFilter {
	column: string;
	operator: 'eq' | 'gte' | 'lte' | 'in';
	value: unknown;
}

export interface FakeCall {
	table: string;
	operation: FakeOperation;
	payload?: unknown;
	columns?: string;
	/** The conflict target an upsert was called with, so a test can assert it. */
	onConflict?: string;
	filters: FakeFilter[];
	order: Array<{ column: string; ascending?: boolean }>;
	limit?: number;
}

export interface FakeError {
	message: string;
	code?: string;
}

export interface FakeResponse {
	data?: unknown;
	error?: FakeError | null;
}

export type FakeResponder = FakeResponse | ((call: FakeCall) => FakeResponse);

/** A handler for every call, or a queue of responses consumed one per call. */
export type FakePlanEntry = FakeResponder | FakeResponse[];

export interface FakePlan {
	tables?: Record<string, Partial<Record<FakeOperation, FakePlanEntry>>>;
	rpc?: Record<string, FakePlanEntry>;
}

export class FakeSupabase {
	/** Every query, in the order the module resolved it. */
	readonly calls: FakeCall[] = [];
	readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

	private readonly queues = new Map<string, FakeResponse[]>();

	constructor(private readonly plan: FakePlan = {}) {}

	from(table: string): FakeBuilder {
		return new FakeBuilder(this, table);
	}

	async rpc(name: string, args: Record<string, unknown> = {}): Promise<FakeResponse> {
		this.rpcCalls.push({ name, args });
		const call: FakeCall = {
			table: `rpc:${name}`,
			operation: 'select',
			payload: args,
			filters: [],
			order: [],
		};
		return this.answer(`rpc:${name}`, call, this.plan.rpc?.[name]);
	}

	/** The same object, as the client type a module expects. */
	asClient(): SupabaseClient {
		return this as unknown as SupabaseClient;
	}

	/** The first call recorded against a table and operation. */
	recorded(table: string, operation: FakeOperation): FakeCall | undefined {
		return this.calls.find((call) => call.table === table && call.operation === operation);
	}

	recordedAll(table: string, operation: FakeOperation): FakeCall[] {
		return this.calls.filter((call) => call.table === table && call.operation === operation);
	}

	planFor(table: string, operation: FakeOperation): FakePlanEntry | undefined {
		return this.plan.tables?.[table]?.[operation];
	}

	/**
	 * Called by the builder when a query resolves. Three kinds of plan entry:
	 *
	 *  - a **function** answers every matching call, which is how a stateful
	 *    responder (the budget ledger) is written;
	 *  - an **array** is a queue, consumed one entry per call, which is how a test
	 *    scripts "the cache is empty, then it holds this row";
	 *  - an **object** answers every call with the same response.
	 */
	answer(key: string, call: FakeCall, responder: FakePlanEntry | undefined): FakeResponse {
		this.calls.push(call);
		if (typeof responder === 'function') return responder(call);
		if (responder === undefined) return { data: [], error: null };
		if (!Array.isArray(responder)) return responder;

		const queue = this.queues.get(key) ?? [...responder];
		this.queues.set(key, queue);
		const next = queue.shift();
		return next === undefined ? { data: [], error: null } : next;
	}
}

class FakeBuilder implements PromiseLike<FakeResponse> {
	private readonly call: FakeCall;
	private kind: 'many' | 'single' | 'maybeSingle' = 'many';

	constructor(
		private readonly fake: FakeSupabase,
		table: string,
	) {
		this.call = { table, operation: 'select', filters: [], order: [] };
	}

	select(columns?: string): this {
		this.call.columns = columns;
		return this;
	}

	insert(payload: unknown): this {
		this.call.operation = 'insert';
		this.call.payload = payload;
		return this;
	}

	update(payload: unknown): this {
		this.call.operation = 'update';
		this.call.payload = payload;
		return this;
	}

	delete(): this {
		this.call.operation = 'delete';
		return this;
	}

	upsert(payload: unknown, options?: { onConflict?: string }): this {
		this.call.operation = 'upsert';
		this.call.payload = payload;
		this.call.onConflict = options?.onConflict;
		return this;
	}

	in(column: string, values: unknown[]): this {
		return this.filter('in', column, values);
	}

	eq(column: string, value: unknown): this {
		return this.filter('eq', column, value);
	}

	gte(column: string, value: unknown): this {
		return this.filter('gte', column, value);
	}

	lte(column: string, value: unknown): this {
		return this.filter('lte', column, value);
	}

	order(column: string, options?: { ascending?: boolean }): this {
		this.call.order.push({ column, ascending: options?.ascending });
		return this;
	}

	limit(count: number): this {
		this.call.limit = count;
		return this;
	}

	single(): this {
		this.kind = 'single';
		return this;
	}

	maybeSingle(): this {
		this.kind = 'maybeSingle';
		return this;
	}

	then<TResult1 = FakeResponse, TResult2 = never>(
		onfulfilled?: ((value: FakeResponse) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.resolve().then(onfulfilled, onrejected);
	}

	private filter(operator: FakeFilter['operator'], column: string, value: unknown): this {
		this.call.filters.push({ column, operator, value });
		return this;
	}

	private async resolve(): Promise<FakeResponse> {
		const responder = this.fake.planFor(this.call.table, this.call.operation);
		const response = this.fake.answer(`${this.call.table}:${this.call.operation}`, this.call, responder);
		return this.unwrap(response);
	}

	private unwrap(response: FakeResponse): FakeResponse {
		if (response.error) return { data: null, error: response.error };
		const data = response.data ?? null;

		if (this.kind === 'single') {
			if (!Array.isArray(data)) return { data, error: null };
			if (data.length === 1) return { data: data[0], error: null };
			return {
				data: null,
				error: {
					message: 'JSON object requested, multiple (or no) rows returned',
					code: 'PGRST116',
				},
			};
		}

		if (this.kind === 'maybeSingle') {
			if (!Array.isArray(data)) return { data, error: null };
			return { data: data.length === 1 ? data[0] : null, error: null };
		}

		return { data, error: null };
	}
}
