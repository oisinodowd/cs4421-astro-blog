import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = new URL('./migration-report.mjs', import.meta.url).pathname;

// `supabase migration list --output-format json` puts the local version in
// `local` and the recorded one in `remote`, with either absent when that side
// does not have it.
function snapshot(rows) {
  return JSON.stringify({
    migrations: rows.map(([local, remote]) => ({ local, remote, time: '2026-10-27 12:00:00' })),
    message: 'Migrations listed',
  });
}

const A = '20261027120000';
const B = '20261027120100';

function run(before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-report-'));
  const beforePath = join(dir, 'before.json');
  const afterPath = join(dir, 'after.json');
  writeFileSync(beforePath, snapshot(before));
  writeFileSync(afterPath, snapshot(after));

  try {
    const stdout = execFileSync('node', [SCRIPT, beforePath, afterPath], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

describe('migration report', () => {
  it('reports what was applied and the resulting schema version', () => {
    const result = run(
      [
        [A, null],
        [B, null],
      ],
      [
        [A, A],
        [B, B],
      ],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| Pending before the push | 2: ');
    expect(result.stdout).toContain(A);
    expect(result.stdout).toContain(B);
    expect(result.stdout).toContain(`| Schema version | ${B} |`);
    expect(result.stdout).toContain('| Local vs remote | 2/2 recorded |');
  });

  it('treats a second run with nothing pending as a success', () => {
    const result = run(
      [
        [A, A],
        [B, B],
      ],
      [
        [A, A],
        [B, B],
      ],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(nothing to do)');
    expect(result.stdout).toContain(`| Schema version | ${B} |`);
  });

  it('fails when migrations are still pending after the push', () => {
    const result = run(
      [
        [A, null],
        [B, null],
      ],
      [
        [A, A],
        [B, null],
      ],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`still pending after the push: ${B}`);
  });

  it('warns when the database holds a migration the repository does not', () => {
    const result = run(
      [[A, A]],
      [
        [A, A],
        // Recorded in the database, absent from the repository: applied from
        // somewhere other than this workflow.
        [null, B],
      ],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Warning');
    expect(result.stdout).toContain(`migration(s) the repository does not: ${B}`);
  });

  it('rejects a snapshot it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-report-'));
    const beforePath = join(dir, 'before.json');
    const afterPath = join(dir, 'after.json');
    writeFileSync(beforePath, 'not json');
    writeFileSync(afterPath, snapshot([]));

    let status = 0;
    try {
      execFileSync('node', [SCRIPT, beforePath, afterPath], { encoding: 'utf8' });
    } catch (error) {
      status = error.status;
    }
    expect(status).toBe(1);
  });
});
