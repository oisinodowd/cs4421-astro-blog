import { describe, expect, it } from 'vitest';

import {
  DependencyMonitor,
  readBalldontlieConfig,
  readSupabaseConfig,
  type DependencyReport,
} from './dependencies';

const SUPABASE_KEY = 'service-role-secret';
const BALLDONTLIE_KEY = 'balldontlie-secret';

const CONFIGURED_ENV = {
  SUPABASE_URL: 'https://project-ref.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY,
  BALLDONTLIE_API_KEY: BALLDONTLIE_KEY,
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

function jsonResponse(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that records what it was asked for, so the probes stay offline. */
function recordingFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function reportOf(results: { supabase: DependencyReport; balldontlie: DependencyReport }) {
  return [results.supabase, results.balldontlie];
}

describe('dependency configuration', () => {
  it('treats an absent variable as unconfigured', () => {
    expect(readSupabaseConfig({})).toBeNull();
    expect(readSupabaseConfig({ SUPABASE_URL: 'https://x.supabase.co' })).toBeNull();
    expect(readSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: 'key' })).toBeNull();
    expect(readBalldontlieConfig({})).toBeNull();
  });

  it('treats a blank or whitespace-only variable as unconfigured', () => {
    expect(readSupabaseConfig({ SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: 'key' })).toBeNull();
    expect(readBalldontlieConfig({ BALLDONTLIE_API_KEY: '  ' })).toBeNull();
  });

  it('trims the values and the trailing slash off the URL', () => {
    expect(
      readSupabaseConfig({
        SUPABASE_URL: ' https://project-ref.supabase.co/ ',
        SUPABASE_SERVICE_ROLE_KEY: ' key ',
      }),
    ).toEqual({ url: 'https://project-ref.supabase.co', serviceRoleKey: 'key' });
    expect(readBalldontlieConfig({ BALLDONTLIE_API_KEY: ' key ' })).toEqual({ apiKey: 'key' });
  });
});

describe('DependencyMonitor — unconfigured', () => {
  it('reports both dependencies as unconfigured without attempting a request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new Error('a probe must not run without credentials');
    });
    const results = await new DependencyMonitor({ fetch: fetchImpl }).status({});

    expect(reportOf(results)).toEqual([
      { configured: false, reachable: false, detail: 'not-configured' },
      { configured: false, reachable: false, detail: 'not-configured' },
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe('DependencyMonitor — reachable', () => {
  it('reports both dependencies reachable on a 200 and sends each key its own way', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200));
    const results = await new DependencyMonitor({ fetch: fetchImpl }).status(CONFIGURED_ENV);

    expect(reportOf(results)).toEqual([
      { configured: true, reachable: true, detail: 'ok' },
      { configured: true, reachable: true, detail: 'ok' },
    ]);

    const supabaseCall = calls.find((c) => c.url.includes('supabase.co'));
    expect(supabaseCall?.url).toBe('https://project-ref.supabase.co/rest/v1/');
    expect(supabaseCall?.headers.apikey).toBe(SUPABASE_KEY);
    expect(supabaseCall?.headers.authorization).toBe(`Bearer ${SUPABASE_KEY}`);

    const balldontlieCall = calls.find((c) => c.url.includes('balldontlie'));
    expect(balldontlieCall?.url).toBe('https://api.balldontlie.io/v1/teams?per_page=1');
    // Raw key, not a bearer token.
    expect(balldontlieCall?.headers.authorization).toBe(BALLDONTLIE_KEY);
  });
});

describe('DependencyMonitor — failures are classified, never thrown', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate-limited'],
    [500, 'error'],
    [503, 'error'],
  ])('maps HTTP %i to detail %s', async (status, detail) => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(status));
    const results = await new DependencyMonitor({ fetch: fetchImpl }).status(CONFIGURED_ENV);

    expect(reportOf(results)).toEqual([
      { configured: true, reachable: false, detail },
      { configured: true, reachable: false, detail },
    ]);
  });

  it('maps a thrown network error to unreachable and a timeout to timeout', async () => {
    const network = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });
    const timedOut = recordingFetch(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });

    const networkResults = await new DependencyMonitor({ fetch: network.fetchImpl }).status(
      CONFIGURED_ENV,
    );
    const timeoutResults = await new DependencyMonitor({ fetch: timedOut.fetchImpl }).status(
      CONFIGURED_ENV,
    );

    expect(reportOf(networkResults).map((r) => r.detail)).toEqual(['unreachable', 'unreachable']);
    expect(reportOf(timeoutResults).map((r) => r.detail)).toEqual(['timeout', 'timeout']);
  });

  it('never lets a credential or the project ref reach a report', async () => {
    // The realistic leak is an upstream error message: it can quote the URL,
    // and the URL carries the project ref. Errors are classified by name only.
    const { fetchImpl } = recordingFetch((call) =>
      Promise.reject(new Error(`request to ${call.url} failed (apikey ${SUPABASE_KEY})`)),
    );
    const results = await new DependencyMonitor({ fetch: fetchImpl }).status(CONFIGURED_ENV);

    const serialized = JSON.stringify(results);
    expect(reportOf(results).map((r) => r.detail)).toEqual(['unreachable', 'unreachable']);
    expect(serialized).not.toContain(SUPABASE_KEY);
    expect(serialized).not.toContain(BALLDONTLIE_KEY);
    expect(serialized).not.toContain('project-ref');
    expect(serialized).not.toContain('failed');
  });
});

describe('DependencyMonitor — caching', () => {
  it('probes once per dependency inside the TTL and again after it expires', async () => {
    let now = 0;
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200));
    const monitor = new DependencyMonitor({
      fetch: fetchImpl,
      now: () => now,
      supabaseTtlMs: 60_000,
      balldontlieTtlMs: 60_000,
    });

    await monitor.status(CONFIGURED_ENV);
    await monitor.status(CONFIGURED_ENV);
    expect(calls).toHaveLength(2);

    now = 61_000;
    await monitor.status(CONFIGURED_ENV);
    expect(calls).toHaveLength(4);
  });

  it('caches a failure only briefly, so recovery is noticed without waiting out the full TTL', async () => {
    let now = 0;
    let healthy = false;
    const { fetchImpl, calls } = recordingFetch(() => (healthy ? jsonResponse(200) : jsonResponse(500)));
    const monitor = new DependencyMonitor({
      fetch: fetchImpl,
      now: () => now,
      supabaseTtlMs: 6 * 60 * 60 * 1000,
      balldontlieTtlMs: 6 * 60 * 60 * 1000,
      failureTtlMs: 60_000,
    });

    const down = await monitor.status(CONFIGURED_ENV);
    expect(down.supabase).toEqual({ configured: true, reachable: false, detail: 'error' });

    // Still inside the failure window: the cached failure stands, no new probes.
    now = 30_000;
    await monitor.status(CONFIGURED_ENV);
    expect(calls).toHaveLength(2);

    healthy = true;
    now = 61_000;
    const recovered = await monitor.status(CONFIGURED_ENV);
    expect(calls).toHaveLength(4);
    expect(recovered.supabase).toEqual({ configured: true, reachable: true, detail: 'ok' });
  });
});
