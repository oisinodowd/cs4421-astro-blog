#!/usr/bin/env node
// Migration run report (ticket #96).
//
// `supabase db push` says what it is doing, but what a reviewer needs afterwards
// is the state of the database, not the scrollback. This reads two
// `supabase migration list --output-format json` snapshots -- one taken before
// the push, one after -- and reports what was applied, the resulting schema
// version, and whether the database now agrees with the repository.
//
// Usage: node scripts/migration-report.mjs <before.json> <after.json>
// Exit:  0 in sync, 1 if migrations are still pending after the push.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [, , beforePath, afterPath] = process.argv;

if (!beforePath || !afterPath) {
  console.error('usage: node scripts/migration-report.mjs <before.json> <after.json>');
  process.exit(2);
}

function snapshot(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`FAIL: could not read ${basename(path)} as JSON: ${error.message}`);
    process.exit(1);
  }

  const rows = Array.isArray(parsed.migrations) ? parsed.migrations : [];
  return {
    local: rows.map((row) => row.local).filter(Boolean).sort(),
    remote: rows.map((row) => row.remote).filter(Boolean).sort(),
  };
}

const before = snapshot(beforePath);
const after = snapshot(afterPath);

const applied = before.local.filter((version) => !before.remote.includes(version));
const pendingAfter = after.local.filter((version) => !after.remote.includes(version));
const unrecorded = after.remote.filter((version) => !after.local.includes(version));

const lines = [
  '### Database migrations',
  '',
  '| | |',
  '| --- | --- |',
  `| Pending before the push | ${applied.length}${applied.length ? `: ${applied.join(', ')}` : ''} |`,
  `| Applied | ${applied.length}${applied.length ? `: ${applied.join(', ')}` : ' (nothing to do)'} |`,
  `| Schema version | ${after.remote.length ? after.remote[after.remote.length - 1] : 'none'} |`,
  `| Local vs remote | ${after.remote.length}/${after.local.length} recorded |`,
];

if (unrecorded.length) {
  lines.push(
    '',
    `> **Warning:** the database has ${unrecorded.length} migration(s) the repository does not: ${unrecorded.join(', ')}.`,
    '> Those were applied from somewhere other than this workflow -- a laptop, or a branch that was never merged.',
  );
}

console.log(lines.join('\n'));

if (pendingAfter.length) {
  console.error(
    `FAIL: ${pendingAfter.length} migration(s) are still pending after the push: ${pendingAfter.join(', ')}`,
  );
  process.exit(1);
}

console.log(
  applied.length
    ? `\nApplied ${applied.length} migration(s); the database is now at ${after.remote[after.remote.length - 1]}.`
    : '\nNothing was pending; the database was already at the repository version.',
);
