import { describe, expect, it } from 'vitest';

import { DependencyMonitor } from './dependencies';
import { getHealthReport, getHealthResponse } from './health';

const SUPABASE_KEY = 'service-role-secret';
const BALLDONTLIE_KEY = 'balldontlie-secret';

const CONFIGURED_ENV = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://project-ref.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY,
  BALLDONTLIE_API_KEY: BALLDONTLIE_KEY,
};

function okFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe('health report', () => {
  it('returns ok status with a timestamp', async () => {
    const report = await getHealthReport({ env: {}, monitor: new DependencyMonitor() });
    expect(report.status).toBe('ok');
    expect(typeof report.timestamp).toBe('string');
  });

  it('computes a fresh timestamp per call, which is what proves the response is SSR', async () => {
    const options = { env: {}, monitor: new DependencyMonitor() };
    const a = await getHealthReport(options);
    await new Promise((r) => setTimeout(r, 5));
    const b = await getHealthReport(options);
    expect(a.timestamp === b.timestamp).toBe(false);
  });

  it('reports the environment it is running in', async () => {
    const development = await getHealthReport({ env: {}, monitor: new DependencyMonitor() });
    expect(development.nodeEnv).toBe('development');

    const production = await getHealthReport({
      env: { NODE_ENV: 'production' },
      monitor: new DependencyMonitor(),
    });
    expect(production.nodeEnv).toBe('production');
  });
});

describe('health report — fail soft with no credentials', () => {
  it('answers 200 and status ok on a container with no credentials at all', async () => {
    // This is the CI container smoke test's state: the image boots with nothing
    // but NODE_ENV, and the deploy must not fail because of it.
    const { fetchImpl, calls } = okFetch();
    const response = await getHealthResponse({
      env: {},
      monitor: new DependencyMonitor({ fetch: fetchImpl }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual({
      supabase: { configured: false, reachable: false, detail: 'not-configured' },
      balldontlie: { configured: false, reachable: false, detail: 'not-configured' },
    });
    expect(calls).toEqual([]);
  });

  it('reports each dependency as configured and reachable once the credentials arrive', async () => {
    const { fetchImpl, calls } = okFetch();
    const response = await getHealthResponse({
      env: CONFIGURED_ENV,
      monitor: new DependencyMonitor({ fetch: fetchImpl }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.nodeEnv).toBe('production');
    expect(body.dependencies).toEqual({
      supabase: { configured: true, reachable: true, detail: 'ok' },
      balldontlie: { configured: true, reachable: true, detail: 'ok' },
    });
    expect(calls).toHaveLength(2);
  });

  it('stays 200 and ok when a configured dependency is unreachable', async () => {
    // Liveness, not readiness: the ALB, the Docker HEALTHCHECK and the uptime
    // monitor all read this, and a Supabase outage must not replace tasks.
    const fetchImpl = (async () =>
      new Response('{}', { status: 503 })) as unknown as typeof globalThis.fetch;
    const response = await getHealthResponse({
      env: CONFIGURED_ENV,
      monitor: new DependencyMonitor({ fetch: fetchImpl }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.dependencies.supabase).toEqual({
      configured: true,
      reachable: false,
      detail: 'error',
    });
  });
});

describe('health report — values never leave the process', () => {
  it('carries no credential and no project ref, in any dependency state', async () => {
    for (const status of [200, 401]) {
      const fetchImpl = (async () =>
        new Response('{}', { status })) as unknown as typeof globalThis.fetch;
      const response = await getHealthResponse({
        env: CONFIGURED_ENV,
        monitor: new DependencyMonitor({ fetch: fetchImpl }),
      });

      const serialized = JSON.stringify(await response.json());
      expect(serialized).not.toContain(SUPABASE_KEY);
      expect(serialized).not.toContain(BALLDONTLIE_KEY);
      expect(serialized).not.toContain('project-ref');
    }
  });
});
