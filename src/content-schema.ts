import { z } from 'astro/zod';

/**
 * Content-collection schemas — single source of truth.
 *
 * `src/content.config.ts` passes these to `defineCollection`, and the unit
 * tests in `src/content-schema.test.ts` validate frontmatter against them.
 * Keeping them here means a schema change is enforced in both places at once.
 */

/**
 * Blog entry schema. `heroImage` is injected because its validator is
 * context-dependent: Astro passes `context.image()` (resolved at build time),
 * tests pass a plain string schema.
 */
export function blogSchema<THero extends z.ZodType>(heroImage: THero) {
	return z.object({
		title: z.string(),
		description: z.string(),
		author: z.string(),
		// Transform string to Date object
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		heroImage: z.optional(heroImage),
	});
}

/**
 * Drill catalogue schema (#102).
 *
 * Drills are content, not rows: one markdown file in `src/content/drills/`, so
 * adding a drill is a markdown-only pull request and the catalogue needs no
 * database.
 *
 * `measures` names the numbers a drill records, and those names are the columns
 * of `session_drills` -- the seam #103 logs against and #104 trends over. A
 * drill therefore cannot promise a number the schema has nowhere to store, and
 * the `refine` below mirrors the table's `makes <= attempts` check.
 */
export const DRILL_CATEGORIES = [
	'shooting',
	'finishing',
	'ball-handling',
	'defence',
	'conditioning',
] as const;

export const DRILL_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;

export const DRILL_MEASURES = ['makes', 'attempts', 'sets', 'reps', 'weight_kg'] as const;

export type DrillCategory = (typeof DRILL_CATEGORIES)[number];
export type DrillDifficulty = (typeof DRILL_DIFFICULTIES)[number];
export type DrillMeasure = (typeof DRILL_MEASURES)[number];

export const drillSchema = z
	.object({
		name: z.string(),
		category: z.enum(DRILL_CATEGORIES),
		difficulty: z.enum(DRILL_DIFFICULTIES),
		equipment: z.array(z.string()).default([]),
		description: z.string(),
		/** Which numbers the drill is logged with, using the table's column names. */
		measures: z.array(z.enum(DRILL_MEASURES)).min(1),
		/** How progress in this drill is measured, in words. */
		progress: z.string(),
	})
	.refine((drill) => !drill.measures.includes('makes') || drill.measures.includes('attempts'), {
		message: "a drill that records 'makes' must also record 'attempts'",
		path: ['measures'],
	});

export const authorsSchema = z.object({
	name: z.string(),
	bio: z.string(),
	avatar: z.string(),
	socialLinks: z
		.object({
			github: z.url().optional(),
			twitter: z.url().optional(),
			linkedin: z.url().optional(),
		})
		.default({}),
});
