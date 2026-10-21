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

export const authorsSchema = z.object({
	name: z.string(),
	bio: z.string(),
	avatar: z.string(),
	socialLinks: z
		.object({
			github: z.string().url().optional(),
			twitter: z.string().url().optional(),
			linkedin: z.string().url().optional(),
		})
		.default({}),
});
