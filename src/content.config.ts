import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

import { authorsSchema, blogSchema, drillSchema } from './content-schema';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: (context) => blogSchema(context.image()),
});

const authors = defineCollection({
	loader: glob({ base: './src/content/authors', pattern: '**/*.md' }),
	schema: authorsSchema,
});

// Drills live in the repository rather than a table (#102), so the catalogue is
// reviewed and versioned like the posts beside it.
const drills = defineCollection({
	loader: glob({ base: './src/content/drills', pattern: '**/*.md' }),
	schema: drillSchema,
});

export const collections = { blog, authors, drills };
