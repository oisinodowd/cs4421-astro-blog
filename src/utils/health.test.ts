
import { describe, expect, it } from 'vitest';
import { getHealthReport, getHealthResponse } from './health';

describe('health report', () => {
  it('returns ok status with a timestamp', () => {
    const report = getHealthReport();
    expect(report.status).toBe('ok');
    expect(typeof report.timestamp).toBe('string');
  });

  it('computes a fresh timestamp per call', async () => {
    const a = getHealthReport();
    await new Promise((r) => setTimeout(r, 5));
    const b = getHealthReport();
    expect(a.timestamp === b.timestamp).toBe(false);
  });

  it('wraps the report in a JSON response', async () => {
    const res = getHealthResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
