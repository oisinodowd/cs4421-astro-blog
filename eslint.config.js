import eslintPluginAstro from "eslint-plugin-astro"
import tsParser from "@typescript-eslint/parser"

export default [
  {
    ignores: ["cdk/cdk.out/**"],
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
]