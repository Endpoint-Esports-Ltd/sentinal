// ESLint flat config (D2 of docs/plans/2026-09-24-hardening-sweep.md).
// recommended + typescript-eslint recommended (NOT type-checked). The rules
// that flood on this codebase start at "warn"; there is no CI gate.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "src/cli/embedded-assets.ts",
      "targets/opencode/dist/**",
      "targets/claude-code/hooks/dist/**",
      "targets/opencode/tests/fixtures/**",
      ".sentinal/worktrees/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Plain-JS build/release scripts run under Node/Bun. typescript-eslint
    // disables no-undef for TS files only; declare the runtime globals here
    // (inline rather than via the `globals` package — one fewer devDependency).
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Bun: "readonly",
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec-e2e.ts", "**/*.e2e.ts", "tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
