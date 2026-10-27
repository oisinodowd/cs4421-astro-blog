#!/usr/bin/env node
/**
 * Build-output validation.
 *
 * Runs after `astro build` and fails if the static output that CloudFront will
 * serve is incomplete or internally broken:
 *
 *   1. required artifacts exist (index.html, the blog index and every blog
 *      post, the drill index and every drill, rss.xml, sitemap-index.xml);
 *   2. every internal link in every generated page resolves to a real file in
 *      dist/client.
 *
 * Exit code 1 on any problem, with one line per failure, so CI logs point
 * straight at the offending page.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'dist', 'client');
const CONTENT_BLOG = path.join(ROOT, 'src', 'content', 'blog');
const CONTENT_DRILLS = path.join(ROOT, 'src', 'content', 'drills');

const failures = [];
const fail = (message) => failures.push(message);

/** The site's own host, so absolute links back into the site are still checked. */
function siteHost() {
	const config = readFileSync(path.join(ROOT, 'astro.config.mjs'), 'utf8');
	const match = config.match(/\bsite:\s*['"]([^'"]+)['"]/);
	if (!match) return null;
	try {
		return new URL(match[1]).host;
	} catch {
		return null;
	}
}

function walk(dir) {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(full));
		else if (entry.isFile()) files.push(full);
	}
	return files;
}

function decodeHref(href) {
	return href.replace(/&amp;/g, '&').replace(/&#38;/g, '&').trim();
}

/** All link-ish attributes worth verifying, with the source page for messages. */
function extractRefs(html) {
	const refs = [];
	const patterns = [
		/<a\b[^>]*?\bhref="([^"]*)"/gi,
		/<link\b[^>]*?\bhref="([^"]*)"/gi,
		/<img\b[^>]*?\bsrc="([^"]*)"/gi,
		/<script\b[^>]*?\bsrc="([^"]*)"/gi,
		/<source\b[^>]*?\bsrc(?:set)?="([^"]*)"/gi,
	];
	for (const pattern of patterns) {
		for (const match of html.matchAll(pattern)) refs.push(decodeHref(match[1]));
	}
	return refs;
}

/**
 * Turn an href into a path inside dist/client, or null when it is not an
 * internal reference we can check (external host, mailto:, fragment-only, ...).
 */
function toLocalPath(href, fromFile, host) {
	if (!href || href.startsWith('#')) return null;
	if (/^(mailto|tel|javascript|data|blob):/i.test(href)) return null;

	let pathname;
	if (/^https?:\/\//i.test(href)) {
		let url;
		try {
			url = new URL(href);
		} catch {
			return null;
		}
		// Only the site's own absolute URLs are internal.
		if (!host || url.host !== host) return null;
		pathname = url.pathname;
	} else if (href.startsWith('//')) {
		return null;
	} else if (href.startsWith('/')) {
		try {
			pathname = new URL(href, 'http://local').pathname;
		} catch {
			return null;
		}
	} else {
		// Relative reference: resolve against the page that contains it.
		try {
			pathname = new URL(href, 'http://local/' + path.relative(CLIENT, fromFile).split(path.sep).join('/')).pathname;
		} catch {
			return null;
		}
	}

	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		decoded = pathname; // malformed %-escapes: check it literally
	}
	return path.join(CLIENT, decoded);
}

/** A URL is served if it maps to a file: exact path, directory index, or .html. */
function resolvesToFile(target) {
	if (!target.startsWith(CLIENT)) return false; // link escapes the build directory

	const candidates = [target];
	if (!path.extname(target)) {
		candidates.push(path.join(target, 'index.html'), target + '.html');
	}
	if (target.endsWith(path.sep)) candidates.push(target + 'index.html');

	return candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

// --- 1. required artifacts -------------------------------------------------

if (!existsSync(CLIENT)) {
	console.error(`FAIL  build output missing: ${path.relative(ROOT, CLIENT)} (did the build run?)`);
	process.exit(1);
}

const requiredFiles = [
	'index.html',
	'blog/index.html',
	'drills/index.html',
	'rss.xml',
	'sitemap-index.xml',
];
for (const file of requiredFiles) {
	if (!existsSync(path.join(CLIENT, file))) fail(`missing artifact: dist/client/${file}`);
}

// Every markdown post needs a rendered page, which is the link between content
// committed to the repo and what actually gets served.
const posts = existsSync(CONTENT_BLOG)
	? readdirSync(CONTENT_BLOG).filter((file) => /\.(md|mdx)$/.test(file))
	: [];

if (posts.length === 0) {
	fail(`no blog posts found in ${path.relative(ROOT, CONTENT_BLOG)}`);
}

for (const post of posts) {
	const slug = post.replace(/\.(md|mdx)$/, '');
	if (!existsSync(path.join(CLIENT, 'blog', slug, 'index.html'))) {
		fail(`missing page for content/blog/${post}: expected dist/client/blog/${slug}/index.html`);
	}
}

// The drill catalogue (#102) is content too, so it gets the same contract: a
// markdown file in the repository has to have a page in the output, or the
// catalogue is describing pages that do not exist.
const drills = existsSync(CONTENT_DRILLS)
	? readdirSync(CONTENT_DRILLS).filter((file) => file.endsWith('.md'))
	: [];

if (drills.length === 0) {
	fail(`no drills found in ${path.relative(ROOT, CONTENT_DRILLS)}`);
}

for (const drill of drills) {
	const slug = drill.replace(/\.md$/, '');
	if (!existsSync(path.join(CLIENT, 'drills', slug, 'index.html'))) {
		fail(`missing page for content/drills/${drill}: expected dist/client/drills/${slug}/index.html`);
	}
}

// --- 2. internal link integrity -------------------------------------------

const host = siteHost();
const pages = walk(CLIENT).filter((file) => file.endsWith('.html'));
let checked = 0;

for (const page of pages) {
	const html = readFileSync(page, 'utf8');
	const refs = extractRefs(html);

	for (const href of refs) {
		const target = toLocalPath(href, page, host);
		if (!target) continue;
		checked++;
		if (!resolvesToFile(target)) {
			fail(`broken link on ${path.relative(CLIENT, page)}: ${href}`);
		}
	}
}

// --- report ---------------------------------------------------------------

const label = path.relative(ROOT, CLIENT) || 'dist/client';
if (failures.length > 0) {
	console.error(`\nBuild output INVALID — ${failures.length} problem(s):\n`);
	for (const failure of failures) console.error(`  FAIL  ${failure}`);
	console.error('');
	process.exit(1);
}

console.log(
	`Build output OK — ${pages.length} page(s) in ${label}, ${posts.length} blog post(s), ${drills.length} drill(s), ${checked} internal link(s) resolved.`,
);
