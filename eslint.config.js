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
  {
    // The per-domain spec segments (fb#782) exist only at author time:
    // pack-specs.mjs inlines their data into the packed dist/reference/specs.js
    // and DELETES dist/reference/specs/, so a runtime import of a segment would
    // crash in the shipped build while working under tsx. Everything must go
    // through the specs.ts barrel; only the barrel and the segments themselves
    // may import segment modules.
    ignores: ["src/reference/specs.ts", "src/reference/specs/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/reference/specs/*", "./specs/*", "../specs/*", "./shared.js"],
              message:
                "Import COMMAND_SPECS/COMMON_AUTH_ERRORS from src/reference/specs.ts (the barrel) — segment modules are pruned from the packed dist.",
            },
          ],
        },
      ],
    },
  },
);
