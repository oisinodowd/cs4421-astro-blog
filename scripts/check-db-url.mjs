#!/usr/bin/env node
// Connection-string pre-flight (ticket #96).
//
// The migration workflow runs this before the `production` gate. A connection
// string that cannot work is a configuration mistake, not something a reviewer
// can decide, so it should fail in seconds with a message naming what to fix --
// instead of after a reviewer has approved a run that was never going to
// connect, which is what happened on the first attempt at this workflow.
//
// Two of the failures it catches are the ones the dashboard hands over by
// accident:
//
//   - a string still carrying the `[YOUR-PASSWORD]` placeholder, because the
//     password is the one part of the dashboard string you have to substitute;
//   - the direct connection host `db.<ref>.supabase.co`, which on a project
//     without the IPv4 add-on publishes only an AAAA record. GitHub-hosted
//     runners have no IPv6 route, so that string works from a laptop with IPv6
//     and cannot work here. The session pooler on port 5432 is the equivalent
//     that resolves over IPv4.
//
// Usage: SUPABASE_DB_URL=... node scripts/check-db-url.mjs
// Exit:  0 the string is usable, 1 it is not.
//
// The password is never printed, not even on failure: the messages report the
// host, port and user name, which is what identifies the mistake.

import { promises as dns } from 'node:dns';
import { pathToFileURL } from 'node:url';

const TRANSACTION_POOLER_PORT = '6543';
const SESSION_POOLER_PORT = '5432';

const POOLER_GUIDANCE =
  'Supabase dashboard -> Connect -> Session pooler (port 5432), then substitute the database password.';

function directConnectionProblem(host, detail) {
  return (
    `the direct connection host ${host} is not reachable over IPv4 (${detail}). ` +
    `GitHub-hosted runners have no IPv6 route, so use the session pooler instead: ${POOLER_GUIDANCE}`
  );
}

/**
 * Inspect a connection string without touching the network.
 *
 * Returns the parts worth reporting plus every reason the string cannot be used.
 */
export function inspectDbUrl(raw) {
  const value = (raw ?? '').trim();
  const found = { host: '', port: '', username: '', directHost: false };

  if (!value) {
    return {
      ...found,
      problems: [
        'SUPABASE_DB_URL is not set. Add it as a repository secret: Settings -> Secrets and variables -> Actions -> New repository secret.',
      ],
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      ...found,
      problems: [
        'SUPABASE_DB_URL is not a valid URL. Expected postgresql://user:password@host:port/database.',
      ],
    };
  }

  const info = {
    host: url.hostname,
    port: url.port || SESSION_POOLER_PORT,
    username: url.username,
    // The pooler hosts are <region>.pooler.supabase.com; the direct host is
    // db.<ref>.supabase.co and has no IPv4 address on a non-add-on project.
    directHost: /^db\.[a-z0-9]+\.supabase\.co$/.test(url.hostname),
  };
  const problems = [];

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    problems.push(`SUPABASE_DB_URL has scheme ${url.protocol}, expected postgresql://.`);
  }

  // The placeholder sits in the userinfo, so look there rather than anywhere in
  // the string: the password is the only part that is ever bracketed.
  const userinfo = value.slice(value.indexOf('://') + 3, value.lastIndexOf('@'));
  if (/\[[^\]]*\]/.test(userinfo)) {
    problems.push(
      'the password is still the dashboard placeholder ([YOUR-PASSWORD]): substitute the project database password',
    );
  }

  if (info.port === TRANSACTION_POOLER_PORT) {
    problems.push(
      'port 6543 is the transaction pooler, which cannot run migrations because they need a session connection: use the session pooler on port 5432',
    );
  }

  if (/\.pooler\.supabase\.com$/.test(info.host) && info.username === 'postgres') {
    problems.push(
      'the pooler needs the tenant-qualified user name (postgres.<project-ref>), not postgres: copy the user name from the session pooler string',
    );
  }

  return { ...info, problems };
}

/**
 * Inspect the string, then resolve the direct-connection host as well, because
 * whether that host is usable depends on DNS rather than on the string itself.
 *
 * `resolve4` is injectable so the AAAA-only case can be tested without owning
 * a domain that is deliberately IPv6-only.
 */
export async function checkDbUrl(raw, { resolve4 = defaultResolve4 } = {}) {
  const inspection = inspectDbUrl(raw);
  const problems = [...inspection.problems];

  if (inspection.directHost) {
    try {
      const addresses = await resolve4(inspection.host);
      if (!addresses.length) {
        problems.push(directConnectionProblem(inspection.host, 'it publishes no A record'));
      }
    } catch (error) {
      const code = error.code ?? error.message;
      // ENODATA is "the name exists and has no A record", which is the same
      // finding as an empty answer; anything else is a lookup that failed.
      problems.push(
        directConnectionProblem(
          inspection.host,
          code === 'ENODATA' ? 'it publishes no A record' : `DNS lookup failed: ${code}`,
        ),
      );
    }
  }

  return { ...inspection, problems };
}

async function defaultResolve4(host) {
  return dns.resolve4(host);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { host, port, username, problems } = await checkDbUrl(process.env.SUPABASE_DB_URL);

  if (problems.length) {
    for (const problem of problems) {
      console.error(`FAIL: ${problem}`);
    }
    process.exit(1);
  }

  // Host, port and user name only: they say which connection was checked without
  // putting the credential in the log.
  console.log(`PASS: ${username}@${host}:${port} is a usable session connection`);
}
