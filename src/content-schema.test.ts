import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'astro/zod';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { authorsSchema, blogSchema } from './content-schema';

const BLOG_DIR = fileURLToPath(new URL('./content/blog/', import.meta.url));
const AUTHORS_DIR = fileURLToPath(new URL('./content/authors/', import.meta.url));

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
