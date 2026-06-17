import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default tseslint.config(
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      obsidianmd,
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["error", {
        "brands": ["GemmaNotes", "gemmanotes"],
        "acronyms": ["E2B", "E4B", "BCP-47"],
        "ignoreWords": ["cursor"],
        "enforceCamelCaseLower": true
      }],
    },
  },
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "esbuild.config.mjs",
      "main.js",
      "versions.json",
      "scripts/**",
    ]
  }
);
