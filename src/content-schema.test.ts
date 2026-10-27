import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'astro/zod';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { DRILL_MEASURES, authorsSchema, blogSchema, drillSchema } from './content-schema';
import { DRILL_SLUG_PATTERN } from './utils/sessions';

const BLOG_DIR = fileURLToPath(new URL('./content/blog/', import.meta.url));
const AUTHORS_DIR = fileURLToPath(new URL('./content/authors/', import.meta.url));
const DRILLS_DIR = fileURLToPath(new URL('./content/drills/', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));

// Astro injects its image() helper as the heroImage validator (resolved at
// build time). In unit tests heroImage is a plain path string; every other
// field is validated by the exact schema Astro enforces.
const blog = blogSchema(z.string());

function listFiles(dir: string, pattern: RegExp): string[] {
	return readdirSync(dir)
		.filter((file) => pattern.test(file))
		.sort();
}

/** Pull the YAML frontmatter out of a markdown body. Throws on malformed input. */
function frontmatterOf(raw: string): unknown {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) {
		throw new Error('malformed frontmatter: missing "---" delimiters');
	}
	return parse(match[1]); // throws if the YAML itself is invalid
}

function readFrontmatter(dir: string, file: string): unknown {
	return frontmatterOf(readFileSync(dir + file, 'utf8'));
}

const blogFiles = listFiles(BLOG_DIR, /\.(md|mdx)$/);
const authorFiles = listFiles(AUTHORS_DIR, /\.md$/);
const drillFiles = listFiles(DRILLS_DIR, /\.md$/);

/**
 * The `create table public.session_drills (...)` block, read out of the
 * migrations. A drill promises numbers the trainer tables have to be able to
 * store, and the only way to know that without a database is to read the DDL.
 */
function sessionDrillsTable(): string {
	const migration = readdirSync(MIGRATIONS_DIR).find((file) =>
		/create_trainer_tables\.sql$/.test(file),
	);
	if (!migration) throw new Error('no create_trainer_tables migration found');

	const sql = readFileSync(MIGRATIONS_DIR + migration, 'utf8');
	const start = sql.indexOf('create table public.session_drills');
	const end = sql.indexOf('\n);', start);
	if (start === -1 || end === -1) {
		throw new Error('could not find the session_drills table in the migration');
	}
	return sql.slice(start, end);
}

describe('real blog entries match the content schema', () => {
	it('has blog entries to validate', () => {
		expect(blogFiles.length).toBeGreaterThan(0);
	});

	for (const file of blogFiles) {
		it(`accepts blog/${file}`, () => {
			blog.parse(readFrontmatter(BLOG_DIR, file));
		});
	}
});

describe('real author entries match the content schema', () => {
	it('has author entries to validate', () => {
		expect(authorFiles.length).toBeGreaterThan(0);
	});

	for (const file of authorFiles) {
		it(`accepts authors/${file}`, () => {
			authorsSchema.parse(readFrontmatter(AUTHORS_DIR, file));
		});
	}
});

describe('real drill entries match the drill schema', () => {
	it('has drills to validate', () => {
		expect(drillFiles.length).toBeGreaterThan(0);
	});

	for (const file of drillFiles) {
		it(`accepts drills/${file}`, () => {
			drillSchema.parse(readFrontmatter(DRILLS_DIR, file));
		});
	}
});

describe('the drill catalogue agrees with the trainer tables', () => {
	// Both sides read the same pattern: the data module checks it when a session
	// is logged, and this asserts the catalogue's filenames satisfy it, so a drill
	// in the repository can always be logged against.
	it('gives every drill a slug the session_drills check accepts', () => {
		for (const file of drillFiles) {
			const slug = file.replace(/\.md$/, '');
			expect(DRILL_SLUG_PATTERN.test(slug), `drills/${file} -> "${slug}" fails the drill_slug check`).toBe(
				true,
			);
		}
	});

	it('only names numbers that session_drills has a column for', () => {
		const table = sessionDrillsTable();
		for (const measure of DRILL_MEASURES) {
			expect(table, `session_drills has no ${measure} column`).toContain(measure);
		}
	});
});

describe('content integrity', () => {
	it('every blog entry references an author that exists', () => {
		const authorIds = new Set(authorFiles.map((file) => file.replace(/\.md$/, '')));
		for (const file of blogFiles) {
			const data = blog.parse(readFrontmatter(BLOG_DIR, file));
			expect(
				authorIds.has(data.author),
				`blog/${file} references unknown author "${data.author}"`,
			).toBe(true);
		}
	});
});

describe('malformed frontmatter is rejected', () => {
	it('rejects a file without a frontmatter block', () => {
		expect(() => frontmatterOf('just some text, no frontmatter')).toThrow(/frontmatter/);
	});

	it('rejects invalid YAML inside frontmatter', () => {
		expect(() => frontmatterOf("---\ntitle: 'unterminated\n---\nbody")).toThrow();
	});

	it('rejects a blog entry with no title', () => {
		expect(() =>
			blog.parse({ description: 'd', author: 'a', pubDate: 'Jul 08 2022' }),
		).toThrow();
	});

	it('rejects a blog entry with no description', () => {
		expect(() => blog.parse({ title: 't', author: 'a', pubDate: 'Jul 08 2022' })).toThrow();
	});

	it('rejects a blog entry with no author', () => {
		expect(() => blog.parse({ title: 't', description: 'd', pubDate: 'Jul 08 2022' })).toThrow();
	});

	it('rejects a blog entry with no pubDate', () => {
		expect(() => blog.parse({ title: 't', description: 'd', author: 'a' })).toThrow();
	});

	it('rejects a non-string title', () => {
		expect(() =>
			blog.parse({ title: 42, description: 'd', author: 'a', pubDate: 'Jul 08 2022' }),
		).toThrow();
	});

	it('rejects an unparseable pubDate in real frontmatter', () => {
		const data = frontmatterOf("---\ntitle: t\ndescription: d\nauthor: a\npubDate: 'not-a-date'\n---");
		expect(() => blog.parse(data)).toThrow();
	});

	it('rejects an unparseable updatedDate', () => {
		expect(() =>
			blog.parse({
				title: 't',
				description: 'd',
				author: 'a',
				pubDate: 'Jul 08 2022',
				updatedDate: 'sometime last week',
			}),
		).toThrow();
	});

	it('rejects an author entry with no name', () => {
		expect(() => authorsSchema.parse({ bio: 'b', avatar: '/a.svg' })).toThrow();
	});

	it('rejects an author entry with no bio', () => {
		expect(() => authorsSchema.parse({ name: 'n', avatar: '/a.svg' })).toThrow();
	});

	it('rejects an author entry with no avatar', () => {
		expect(() => authorsSchema.parse({ name: 'n', bio: 'b' })).toThrow();
	});

	it('rejects social links that are not URLs', () => {
		expect(() =>
			authorsSchema.parse({
				name: 'n',
				bio: 'b',
				avatar: '/a.svg',
				socialLinks: { github: 'not-a-url' },
			}),
		).toThrow();
	});
});

describe('malformed drill frontmatter is rejected', () => {
	// The shape every catalogue entry uses, so each case below changes one field
	// and nothing else.
	const valid = {
		name: 'Test Drill',
		category: 'shooting',
		difficulty: 'beginner',
		equipment: ['ball'],
		description: 'd',
		measures: ['makes', 'attempts'],
		progress: 'makes out of attempts',
	};

	it('accepts the shape the catalogue uses', () => {
		expect(() => drillSchema.parse(valid)).not.toThrow();
	});

	it('rejects a category outside the catalogue', () => {
		expect(() => drillSchema.parse({ ...valid, category: 'goaltending' })).toThrow();
	});

	it('rejects an unknown difficulty', () => {
		expect(() => drillSchema.parse({ ...valid, difficulty: 'expert' })).toThrow();
	});

	it('rejects a drill with nothing to measure', () => {
		expect(() => drillSchema.parse({ ...valid, measures: [] })).toThrow();
	});

	it('rejects a measure the sessions table cannot store', () => {
		expect(() => drillSchema.parse({ ...valid, measures: ['three_pointers'] })).toThrow();
	});

	it('rejects makes without attempts', () => {
		expect(() => drillSchema.parse({ ...valid, measures: ['makes'] })).toThrow(/attempts/);
	});

	it('rejects a drill with no description', () => {
		expect(() =>
			drillSchema.parse({
				name: 'Test Drill',
				category: 'shooting',
				difficulty: 'beginner',
				measures: ['makes', 'attempts'],
				progress: 'makes out of attempts',
			}),
		).toThrow();
	});

	it('rejects a drill with no progress measure', () => {
		expect(() =>
			drillSchema.parse({
				name: 'Test Drill',
				category: 'shooting',
				difficulty: 'beginner',
				description: 'd',
				measures: ['makes', 'attempts'],
			}),
		).toThrow();
	});

	it('accepts a drill that needs no equipment', () => {
		const parsed = drillSchema.parse({
			name: 'Test Drill',
			category: 'conditioning',
			difficulty: 'beginner',
			description: 'd',
			measures: ['sets', 'reps'],
			progress: 'sets and reps',
		});
		expect(parsed.equipment).toEqual([]);
	});
});

describe('schema defaults and optionals', () => {
	it('accepts a minimal blog entry (heroImage and updatedDate optional)', () => {
		expect(() =>
			blog.parse({ title: 't', description: 'd', author: 'a', pubDate: 'Jul 08 2022' }),
		).not.toThrow();
	});

	it('accepts valid social link URLs', () => {
		expect(() =>
			authorsSchema.parse({
				name: 'n',
				bio: 'b',
				avatar: '/a.svg',
				socialLinks: { github: 'https://github.com/x' },
			}),
		).not.toThrow();
	});

	it('defaults socialLinks to an empty object', () => {
		const parsed = authorsSchema.parse({ name: 'n', bio: 'b', avatar: '/a.svg' });
		expect(parsed.socialLinks).toEqual({});
	});

	it('coerces pubDate strings into Date objects', () => {
		const parsed = blog.parse({
			title: 't',
			description: 'd',
			author: 'a',
			pubDate: 'Jul 08 2022',
		});
		expect(parsed.pubDate).toBeInstanceOf(Date);
	});
});
