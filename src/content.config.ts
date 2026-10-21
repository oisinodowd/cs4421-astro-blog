import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

import { authorsSchema, blogSchema } from './content-schema';

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

export const collections = { blog, authors };
