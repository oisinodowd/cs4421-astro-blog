#!/usr/bin/env node
/**
 * Dependabot update level (ticket #72).
 *
 * Reads the text of a Dependabot pull request on stdin — or from a file path
 * given as the first argument — and prints the highest update level it contains:
 * `patch`, `minor`, `major` or `unknown`.
 *
 * Dependabot writes a machine-readable trailer into every update commit:
 *
 *   updated-dependencies:
 *   - dependency-name: "@astrojs/mdx"
 *     dependency-version: 8.1.1
 *     dependency-type: direct:production
 *     update-type: version-update:semver-patch
 *   ...
 *
 * That trailer is the primary signal, and it is read from the commit messages
 * rather than the pull request body: the body of a version update does not carry
 * it, and the body's prose picks up unrelated version numbers from changelogs.
 * A grouped update lists one entry per dependency, so the highest level wins —
 * a group holding a minor is not a patch.
 *
 * There is no side effect here, and no decision: the caller decides what to do
 * with the answer.
 *
 * It fails closed. Text with nothing readable — a docker tag such as
 * `24-alpine`, or a future change to Dependabot's message format — reports
 * `unknown`, and the auto-merge workflow only ever acts on `patch`.
 *
 * Usage: gh pr view <n> --json body,commits | node scripts/dependabot-update-level.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Ordered by risk, so the highest level in a pull request can win. */
const LEVELS = ['patch', 'minor', 'major'];

/** Dependabot's own trailer, e.g. `update-type: version-update:semver-patch`. */
const TRAILER_ENTRY = /update-type:\s*(?:version-update|security-update):semver-(major|minor|patch)/g;

/** Fallback for messages with no trailer: `Bumps x from 1.2.3 to 1.2.4`. */
const VERSION_PAIR = /\bfrom\s+v?(\S+?)\s+to\s+v?([0-9][^\s`)]*)/g;

/** Leading `major.minor.patch`; a suffix such as `-beta.1` does not matter here. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)/;

function highestOf(levels) {
  return levels.reduce((highest, level) => (LEVELS.indexOf(level) > LEVELS.indexOf(highest) ? level : highest), 'patch');
}

/** The level one version pair represents, or null when the pair is not a change. */
function levelOfPair(from, to) {
  const before = SEMVER.exec(from);
  const after = SEMVER.exec(to);
  // A tag that is not `x.y.z` — a docker tag like `24-alpine`, or a dist-tag —
  // cannot be classified, which has to stop the auto-merge rather than be ignored.
  if (!before || !after) return 'unknown';

  if (before[1] !== after[1]) return 'major';
  if (before[2] !== after[2]) return 'minor';
  if (before[3] !== after[3]) return 'patch';
  return null;
}

/**
 * The highest update level the given Dependabot text contains.
 *
 * @param {string} text Dependabot commit messages or pull request body.
 * @returns {'patch' | 'minor' | 'major' | 'unknown'}
 */
export function updateLevel(text) {
  const fromTrailer = [...text.matchAll(TRAILER_ENTRY)].map((match) => match[1]);
  if (fromTrailer.length > 0) return highestOf(fromTrailer);

  const pairs = [...text.matchAll(VERSION_PAIR)].map((match) => levelOfPair(match[1], match[2]));
  if (pairs.length === 0) return 'unknown';
  if (pairs.includes('unknown')) return 'unknown';

  const levels = pairs.filter((level) => level !== null);
  return levels.length > 0 ? highestOf(levels) : 'unknown';
}

function main() {
  const path = process.argv[2];
  let text;
  try {
    text = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
  } catch (error) {
    console.error(`FAIL  cannot read ${path}: ${error.message}`);
    process.exit(2);
  }

  for (const match of text.matchAll(TRAILER_ENTRY)) {
    console.error(`update-type: semver-${match[1]}`);
  }

  const level = updateLevel(text);
  console.error(`update level: ${level}`);
  // Machine-readable answer on stdout, human-readable trace on stderr.
  console.log(level);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
