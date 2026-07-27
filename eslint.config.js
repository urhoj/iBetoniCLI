import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      // New in eslint:recommended as of ESLint 10 — warn for now, fix incrementally.
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "no-unassigned-vars": "warn",
    },
  },
);
