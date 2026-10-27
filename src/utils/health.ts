import {
  dependencyMonitor,
  type DependencyMonitor,
  type DependencyStatus,
} from './dependencies';

export interface HealthReport {
  /**
   * Liveness of this process, not of its dependencies: it says a server is up
   * and rendering, which is what the ALB, the Docker HEALTHCHECK and the uptime
   * monitor are asking. A dependency being down is reported below, never as a
   * failed request -- see the note on `dependencies`.
   */
  status: 'ok';
  nodeEnv: string;
  uptime: number;
  timestamp: string;
  /**
   * Whether each dependency is configured and answering. Present even on a
   * container booted with no credentials, which is the state the CI smoke test
   * runs in; values themselves are never echoed.
   */
  dependencies: DependencyStatus;
}

export interface HealthOptions {
  env?: Record<string, string | undefined>;
  monitor?: DependencyMonitor;
}

export async function getHealthReport(options: HealthOptions = {}): Promise<HealthReport> {
  const { env = process.env, monitor = dependencyMonitor } = options;
  return {
    status: 'ok',
    nodeEnv: env.NODE_ENV ?? 'development',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    dependencies: await monitor.status(env),
  };
}

export async function getHealthResponse(options: HealthOptions = {}): Promise<Response> {
  return new Response(JSON.stringify(await getHealthReport(options)), {
    headers: { 'content-type': 'application/json' },
  });
}
