import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { checkDbUrl, inspectDbUrl } from './check-db-url.mjs';

const SCRIPT = new URL('./check-db-url.mjs', import.meta.url).pathname;
const PASSWORD = 'sup3rS3cretP4ssword';

function run(dbUrl) {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_DB_URL: dbUrl },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const poolerUrl = `postgresql://postgres.abcdefghijklmno:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const directUrl = `postgresql://postgres:${PASSWORD}@db.abcdefghijklmno.supabase.co:5432/postgres`;

describe('connection-string pre-flight', () => {
  it('accepts a session pooler string', () => {
    const result = run(poolerUrl);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: postgres.abcdefghijklmno@aws-0-us-east-1.pooler.supabase.com:5432');
  });

  it('never prints the password, on success or on failure', () => {
    const accepted = run(poolerUrl);
    const rejected = run(`postgresql://postgres.abcdefghijklmno:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);

    for (const [name, result] of [
      ['accepted', accepted],
      ['rejected', rejected],
    ]) {
      expect(`${result.stdout}${result.stderr}`, `${name} output`).not.toContain(PASSWORD);
    }
  });

  it('fails when the secret is not set', () => {
    const result = run('');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SUPABASE_DB_URL is not set');
  });

  it('fails when the password is still the dashboard placeholder', () => {
    const result = run('postgresql://postgres.abcdefghijklmno:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('placeholder');
  });

  it('fails on the transaction pooler, which cannot run migrations', () => {
    const result = run('postgresql://postgres.abcdefghijklmno:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('port 6543');
  });

  it('fails when the pooler user name is missing the project ref', () => {
    const result = run('postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('postgres.<project-ref>');
  });

  it('fails when the string is not a URL', () => {
    const result = run('not a connection string');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a valid URL');
  });

  // The direct host is not rejected for its shape but for its DNS: on a project
  // without the IPv4 add-on it publishes only AAAA, which a GitHub runner cannot
  // route to. Both branches are injected here rather than resolved, so the test
  // does not depend on a real IPv6-only domain.
  it('rejects the direct connection host when it has no A record', async () => {
    const result = await checkDbUrl(directUrl, { resolve4: async () => [] });

    expect(result.problems.join('\n')).toContain('no A record');
    expect(result.problems.join('\n')).toContain('Session pooler');
  });

  it('rejects the direct connection host when it does not resolve at all', async () => {
    const failure = Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    const result = await checkDbUrl(directUrl, {
      resolve4: async () => {
        throw failure;
      },
    });

    expect(result.problems.join('\n')).toContain('ENOTFOUND');
  });

  it('accepts the direct host when the project has an IPv4 address', async () => {
    const result = await checkDbUrl(directUrl, { resolve4: async () => ['203.0.113.10'] });

    expect(result.problems).toEqual([]);
  });

  it('reads the port and user name out of a string that omits the port', () => {
    const result = inspectDbUrl('postgresql://postgres.abcdefghijklmno:pw@db.abcdefghijklmno.supabase.co/postgres');

    expect(result.port).toBe('5432');
    expect(result.directHost).toBe(true);
    expect(result.username).toBe('postgres.abcdefghijklmno');
  });
});
