/**
 * Dependency configuration and reachability probes (ticket #94).
 *
 * Every credential the container needs arrives from SSM Parameter Store as an
 * environment variable (see `cdk/lib/ecs-service-stack.ts`). None of it is
 * assumed to be present: a container booted with no credentials at all -- which
 * is exactly what the CI container smoke test does -- still has to serve pages
 * and answer `/api/health` with a 200.
 *
 * Three rules this module holds to:
 *
 *  - A probe failure is never an exception. Callers get `reachable: false` and
 *    a `detail` code from a closed set, so a dependency outage can neither turn
 *    the liveness endpoint red (the ALB, the Docker `HEALTHCHECK` and the
 *    uptime monitor all read it) nor fail the deploy.
 *  - No value is ever reported. Caught errors are classified by name, never by
 *    message: an upstream error message can quote the URL, and the URL contains
 *    the project ref.
 *  - A missing dependency is a normal state, not an error. It is reported, not
 *    thrown, because #94 requires the site to serve without any credentials.
 */

/** A closed set of reasons, so a report can never carry a credential out with it. */
export type DependencyDetail =
  | 'ok'
  | 'not-configured'
  | 'unauthorized'
  | 'rate-limited'
  | 'timeout'
  | 'unreachable'
  | 'error';

export interface DependencyReport {
  /** Are the variables for this dependency present and non-empty? */
  configured: boolean;
  /** Did the last probe get a successful answer? Always false when unconfigured. */
  reachable: boolean;
  detail: DependencyDetail;
}

export interface DependencyStatus {
  supabase: DependencyReport;
  balldontlie: DependencyReport;
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export interface BalldontlieConfig {
  apiKey: string;
}

type Env = Record<string, string | undefined>;
type DependencyName = 'supabase' | 'balldontlie';
type ProbeOutcome = Pick<DependencyReport, 'reachable' | 'detail'>;

/** The balldontlie v1 API. #97's client imports this rather than repeating it. */
export const BALLDONTLIE_API_BASE = 'https://api.balldontlie.io/v1';

/**
 * The Data API root. A 200 here means the project is up and it accepted our
 * key; it deliberately says nothing about whether the migrations have run. This
 * is a *dependency* probe, not a readiness probe -- schema state is proved by
 * the migration workflow (#96).
 */
export const SUPABASE_PROBE_PATH = '/rest/v1/';

/**
 * Probe results are cached per process. Without a cache the 30-second container
 * health check would spend the entire balldontlie allowance -- two tasks
 * fetching every 30 seconds is 5,760 requests a day against a budget of 400 --
 * proving that a service we have not used yet is still up. Six hours costs 8
 * requests a day and still notices an outage within a working session.
 */
const SUPABASE_PROBE_TTL_MS = 5 * 60 * 1000;
const BALLDONTLIE_PROBE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * A failure is cached for much less than a success, or one blip would keep the
 * endpoint reporting `unreachable` for hours after the dependency recovered.
 */
const FAILURE_TTL_MS = 60 * 1000;

/**
 * Bounded so a hung dependency cannot make the health check exceed the 5s
 * timeouts the ALB, the Docker `HEALTHCHECK` and `wget` apply to it.
 */
const PROBE_TIMEOUT_MS = 1500;

/** Presence, not validation: an empty string is treated as absent. */
function read(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

export function readSupabaseConfig(env: Env = process.env): SupabaseConfig | null {
  const url = read(env, 'SUPABASE_URL');
  const serviceRoleKey = read(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (url === '' || serviceRoleKey === '') return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

export function readBalldontlieConfig(env: Env = process.env): BalldontlieConfig | null {
  const apiKey = read(env, 'BALLDONTLIE_API_KEY');
  if (apiKey === '') return null;
  return { apiKey };
}

interface CacheEntry {
  at: number;
  outcome: ProbeOutcome;
}

export interface DependencyMonitorOptions {
  /** Injected so tests exercise the classification without touching the network. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  probeTimeoutMs?: number;
  supabaseTtlMs?: number;
  balldontlieTtlMs?: number;
  failureTtlMs?: number;
}

export class DependencyMonitor {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly supabaseTtlMs: number;
  private readonly balldontlieTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly cache = new Map<DependencyName, CacheEntry>();

  constructor(options: DependencyMonitorOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.supabaseTtlMs = options.supabaseTtlMs ?? SUPABASE_PROBE_TTL_MS;
    this.balldontlieTtlMs = options.balldontlieTtlMs ?? BALLDONTLIE_PROBE_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
  }

  /**
   * Both dependencies, probed concurrently so one slow upstream cannot delay the
   * report of the other.
   */
  async status(env: Env = process.env): Promise<DependencyStatus> {
    const [supabase, balldontlie] = await Promise.all([
      this.check('supabase', readSupabaseConfig(env), this.supabaseTtlMs, (config) =>
        this.probeSupabase(config),
      ),
      this.check('balldontlie', readBalldontlieConfig(env), this.balldontlieTtlMs, (config) =>
        this.probeBalldontlie(config),
      ),
    ]);
    return { supabase, balldontlie };
  }

  private async check<T>(
    name: DependencyName,
    config: T | null,
    successTtlMs: number,
    run: (config: T) => Promise<ProbeOutcome>,
  ): Promise<DependencyReport> {
    if (config === null) {
      return { configured: false, reachable: false, detail: 'not-configured' };
    }

    const at = this.now();
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      const ttl = cached.outcome.reachable ? successTtlMs : this.failureTtlMs;
      if (at - cached.at < ttl) {
        return { configured: true, ...cached.outcome };
      }
    }

    const outcome = await run(config);
    this.cache.set(name, { at, outcome });
    return { configured: true, ...outcome };
  }

  private probeSupabase(config: SupabaseConfig): Promise<ProbeOutcome> {
    return this.probe(`${config.url}${SUPABASE_PROBE_PATH}`, {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    });
  }

  private probeBalldontlie(config: BalldontlieConfig): Promise<ProbeOutcome> {
    return this.probe(`${BALLDONTLIE_API_BASE}/teams?per_page=1`, {
      // Not `Bearer`: balldontlie expects the raw key in this header.
      authorization: config.apiKey,
    });
  }

  private async probe(url: string, headers: Record<string, string>): Promise<ProbeOutcome> {
    try {
      const response = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      await discard(response);
      return classifyStatus(response.status);
    } catch (error) {
      return classifyError(error);
    }
  }
}

async function discard(response: Response): Promise<void> {
  try {
    // Read none of the body: leave the socket free rather than buffering a
    // payload the probe only wanted the status code from.
    await response.body?.cancel();
  } catch {
    // The status code is all this needs; a body that will not close is not a
    // dependency failure.
  }
}

function classifyStatus(status: number): ProbeOutcome {
  if (status >= 200 && status < 300) return { reachable: true, detail: 'ok' };
  if (status === 401 || status === 403) return { reachable: false, detail: 'unauthorized' };
  if (status === 429) return { reachable: false, detail: 'rate-limited' };
  return { reachable: false, detail: 'error' };
}

function classifyError(error: unknown): ProbeOutcome {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { reachable: false, detail: 'timeout' };
  }
  return { reachable: false, detail: 'unreachable' };
}

/**
 * One monitor per process, so the cache survives between requests. Both ECS
 * tasks therefore report independently -- and each spends at most its own
 * handful of probes a day.
 */
export const dependencyMonitor = new DependencyMonitor();
