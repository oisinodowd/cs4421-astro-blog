import eslintPluginAstro from "eslint-plugin-astro"
import tsParser from "@typescript-eslint/parser"

export default [
  {
    ignores: ["cdk/cdk.out/**", "dist/**", ".astro/**"],
  },

  // add more generic rule sets here, such as:
  // js.configs.recommended,
  ...eslintPluginAstro.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      sourceType: "module",
    },
    rules: {
      // override/add rules settings here, such as:
      // "astro/no-set-html-directive": "error"
      "no-console": "error",
    },
    settings: {
      "import/core-modules": ["astro:content", "astro:transitions"],
      "import/parsers": {
        "astro-eslint-parser": [".astro"],
        espree: [".js", ".mjs", ".cjs"],
        "@typescript-eslint/parser": [".ts", ".tsx"],
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
    },
  },

  // #95: a route reads and writes through the data modules, never through the
  // client. Importing the client into a page is how query building spreads into
  // templates, which is the thing those modules exist to prevent.
  {
    files: ["src/pages/**/*.{ts,tsx,astro}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@supabase/supabase-js"],
              message: "Use the data modules (src/utils/db.ts and the stores beside it) instead of the client.",
            },
          ],
        },
      ],
    },
  },

  // Node CLI scripts in scripts/ report their results on stdout/stderr by design.
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    rules: {
      "no-console": "off",
    },
  },
]
