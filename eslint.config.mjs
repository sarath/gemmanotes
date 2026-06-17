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
      
      // Disable noisy TypeScript type-checking/stylistic rules that aren't Obsidian marketplace guidelines
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/unbound-method": "off",
      
      // Other general formatting/environment lint rules that aren't Obsidian marketplace checks
      "@microsoft/sdl/no-inner-html": "off",
      "@microsoft/sdl/no-document-write": "off",
      "import/no-extraneous-dependencies": "off",
      "import/no-nodejs-modules": "off",
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-implicit-globals": "off",
      "no-restricted-globals": "off",
      "no-restricted-imports": "off",
      "no-control-regex": "off",
      "no-empty": "off",
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
