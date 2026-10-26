import { describe, expect, it } from 'vitest';
import { updateLevel } from './dependabot-update-level.mjs';

/**
 * The fixtures below are trimmed copies of real Dependabot commit messages from
 * this repository, with the parts the parser reads kept verbatim: the subject,
 * the `Bumps`/`Updates` line and the `updated-dependencies` trailer. The pull
 * request each one came from is named, so an expectation can be checked against
 * the real thing rather than against the fixture.
 *
 * The two grouped fixtures are the exception: they are written to the format
 * Dependabot documents for a group, because no grouped pull request has existed
 * in this repository yet. They are the cases to revisit once the first real one
 * lands.
 */
const trailer = (entries) => `\n---\nupdated-dependencies:\n${entries}\n\nSigned-off-by: dependabot[bot] <support@github.com>\n`;

const messages = {
	'patch - @astrojs/mdx 8.1.0 to 8.1.1 (PR #75)': `chore(deps): bump @astrojs/mdx from 8.1.0 to 8.1.1

Bumps [@astrojs/mdx](https://github.com/withastro/astro/tree/HEAD/packages/integrations/mdx) from 8.1.0 to 8.1.1.
- [Release notes](https://github.com/withastro/astro/releases)
${trailer('- dependency-name: "@astrojs/mdx"\n  dependency-version: 8.1.1\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...')}`,

	'patch - @astrojs/check 0.9.10 to 0.9.12 (PR #77)': `chore(deps): bump @astrojs/check from 0.9.10 to 0.9.12

Bumps [@astrojs/check](https://github.com/withastro/astro/tree/HEAD/packages/language-tools/astro-check) from 0.9.10 to 0.9.12.
${trailer('- dependency-name: "@astrojs/check"\n  dependency-version: 0.9.12\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...')}`,

	'minor - astro 7.3.2 to 7.4.2 (PR #78)': `chore(deps): bump astro from 7.3.2 to 7.4.2

Bumps [astro](https://github.com/withastro/astro/tree/HEAD/packages/astro) from 7.3.2 to 7.4.2.
${trailer('- dependency-name: astro\n  dependency-version: 7.4.2\n  dependency-type: direct:production\n  update-type: version-update:semver-minor\n...')}`,

	'minor - eslint 10.11.0 to 10.13.0 (PR #25)': `chore(deps-dev): bump eslint from 10.11.0 to 10.13.0

Bumps [eslint](https://github.com/eslint/eslint) from 10.11.0 to 10.13.0.
${trailer('- dependency-name: eslint\n  dependency-version: 10.13.0\n  dependency-type: direct:development\n  update-type: version-update:semver-minor\n...')}`,

	'major - typescript 6.0.3 to 7.0.2 (PR #12)': `chore(deps): bump typescript from 6.0.3 to 7.0.2

Bumps [typescript](https://github.com/microsoft/TypeScript) from 6.0.3 to 7.0.2.
${trailer('- dependency-name: typescript\n  dependency-version: 7.0.2\n  dependency-type: direct:production\n  update-type: version-update:semver-major\n...')}`,

	'major - eslint-plugin-astro 1.7.0 to 3.2.1 (PR #76)': `chore(deps-dev): bump eslint-plugin-astro from 1.7.0 to 3.2.1

Bumps [eslint-plugin-astro](https://github.com/ota-meshi/eslint-plugin-astro) from 1.7.0 to 3.2.1.
${trailer('- dependency-name: eslint-plugin-astro\n  dependency-version: 3.2.1\n  dependency-type: direct:development\n  update-type: version-update:semver-major\n...')}`,

	// The docker ecosystem has no semver to compare, so Dependabot writes the
	// dependency without an update-type. That absence has to stop the merge:
	// node:25-alpine passed every check and was still the wrong upgrade (PR #57).
	'unknown - node 24-alpine to 25-alpine (PR #57)': `chore(deps): bump node from 24-alpine to 25-alpine

Bumps node from 24-alpine to 25-alpine.
${trailer('- dependency-name: node\n  dependency-version: 25-alpine\n  dependency-type: direct:production\n...')}`,

	'unknown - a message carrying no dependency information at all': 'chore(deps): bump something\n\nNo trailer and no version pair here.\n',

	'patch - a message with no trailer, read from its version pair': `chore(deps): bump something from 2.4.0 to 2.4.1

Bumps something from 2.4.0 to 2.4.1.
`,

	'unknown - an unreadable tag next to a readable patch': `chore(deps): bump base image and a library

Bumps node from 24-alpine to 25-alpine.
Bumps something from 2.4.0 to 2.4.1.
`,
};

describe('updateLevel', () => {
	for (const [name, text] of Object.entries(messages)) {
		it(`reads "${name}" as ${name.split(' - ')[0]}`, () => {
			expect(updateLevel(text)).toBe(name.split(' - ')[0]);
		});
	}

	// Written to Dependabot's documented group format: one trailer entry per
	// dependency, so the riskiest entry in the group decides.
	const grouped = (...entries) =>
		`Bumps the astro group with ${entries.length} updates.\n\n${entries
			.map((entry) => `Updates \`${entry.name}\` from ${entry.from} to ${entry.to}`)
			.join('\n\n')}\n${trailer(
			entries
				.map(
					(entry) =>
						`- dependency-name: ${entry.name}\n  dependency-version: ${entry.to}\n  dependency-type: direct:production\n  update-type: version-update:semver-${entry.level}\n`,
				)
				.join(''),
		)}`;

	it('reads a group of patch updates as patch', () => {
		const text = grouped(
			{ name: 'astro', from: '7.3.2', to: '7.3.3', level: 'patch' },
			{ name: '@astrojs/mdx', from: '8.1.0', to: '8.1.1', level: 'patch' },
		);
		expect(updateLevel(text)).toBe('patch');
	});

	it('reads a group holding a minor as minor, not as patch', () => {
		const text = grouped(
			{ name: 'astro', from: '7.3.2', to: '7.4.2', level: 'minor' },
			{ name: '@astrojs/mdx', from: '8.1.0', to: '8.1.1', level: 'patch' },
		);
		expect(updateLevel(text)).toBe('minor');
	});

	it('reads a group holding a major as major', () => {
		const text = grouped(
			{ name: 'astro', from: '7.3.2', to: '8.0.0', level: 'major' },
			{ name: '@astrojs/mdx', from: '8.1.0', to: '8.1.1', level: 'patch' },
		);
		expect(updateLevel(text)).toBe('major');
	});
});
