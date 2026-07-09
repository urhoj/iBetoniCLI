import { describe, test, expect } from "vitest";
import {
  formatHelp,
  formatGroupHelp,
  type CommandSpec,
} from "../../src/output/help.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

const sampleSpec: CommandSpec = {
  command: "ib keikka list",
  description:
    "List concrete delivery orders for the active company within a date range.",
  permissions: ["auth.page.grid.tilaus.read"],
  flags: [
    {
      name: "from",
      type: "date",
      default: "today",
      description: "Start date (YYYY-MM-DD)",
    },
    {
      name: "to",
      type: "date",
      default: "today",
      description: "End date (YYYY-MM-DD)",
    },
    {
      name: "limit",
      type: "number",
      default: "100",
      description: "Max rows",
    },
  ],
  outputShape:
    "Keikka[] in universal list envelope { items, nextCursor, count }",
  errors: [
    { exit: 2, http: 401, meaning: "Token expired", remedy: "ib auth refresh" },
    {
      exit: 3,
      http: 403,
      meaning: "Permission denied",
      remedy: "check auth.page.grid.tilaus.read",
    },
  ],
  examples: ["ib keikka list --from 2026-05-28 --to 2026-05-30"],
};

describe("formatHelp", () => {
  test("renders the AI-optimized help template with all required sections", () => {
    const out = formatHelp(sampleSpec);
    expect(out).toContain("USAGE");
    expect(out).toContain("ib keikka list");
    expect(out).toContain("DESCRIPTION");
    expect(out).toContain("auth.page.grid.tilaus.read");
    expect(out).toContain("Timezone");
    expect(out).toContain("FLAGS");
    expect(out).toContain("--from");
    expect(out).toContain("--to");
    expect(out).toContain("--limit");
    expect(out).toContain("GLOBAL FLAGS");
    expect(out).toContain("OUTPUT (JSON, stdout)");
    expect(out).toContain("ERRORS");
    expect(out).toContain("exit 2 (HTTP 401)");
    expect(out).toContain("exit 3 (HTTP 403)");
    expect(out).toContain("EXAMPLES");
    expect(out).toContain("ib keikka list --from 2026-05-28");
  });

  test("renders WRITE-SAFETY FLAGS block only when writeFlags is true", () => {
    const withWrite = formatHelp({ ...sampleSpec, writeFlags: true });
    expect(withWrite).toContain("WRITE-SAFETY FLAGS");
    expect(withWrite).toContain("--dry-run");
    expect(withWrite).toContain("--idempotency-key");
    expect(withWrite).toContain("--reason");

    const withoutWrite = formatHelp(sampleSpec);
    expect(withoutWrite).not.toContain("WRITE-SAFETY FLAGS");
  });
});

describe("formatGroupHelp tier filtering", () => {
  test("jerry group omits the admin subgroup at standard", () => {
    const std = formatGroupHelp(
      "ib jerry",
      "Jerry",
      COMMAND_SPECS,
      "standard"
    );
    expect(std).not.toMatch(/^\s+admin\b/m);
    const dev = formatGroupHelp(
      "ib jerry",
      "Jerry",
      COMMAND_SPECS,
      "developer"
    );
    expect(dev).toContain("admin");
  });
  test("fully-hidden group renders the not-available fallback at standard", () => {
    // schema is now under ib dev schema — use that path for tier-gating tests
    const std = formatGroupHelp(
      "ib dev schema",
      "Schema",
      COMMAND_SPECS,
      "standard"
    );
    expect(std).toContain("not available at your access level");
    expect(std).not.toContain("SUBCOMMANDS");
    const dev = formatGroupHelp(
      "ib dev schema",
      "Schema",
      COMMAND_SPECS,
      "developer"
    );
    expect(dev).toContain("SUBCOMMANDS");
  });
  test("feedback group keeps create, drops list at standard", () => {
    // feedback is now under ib dev feedback
    const std = formatGroupHelp(
      "ib dev feedback",
      "Feedback",
      COMMAND_SPECS,
      "standard"
    );
    expect(std).toContain("create");
    expect(std).not.toMatch(/^\s+list\b/m);
  });
});

describe("formatGroupHelp re-homed alias redirect", () => {
  test("ib cache alias renders the canonical ib dev cache group help", () => {
    const alias = formatGroupHelp("ib cache", "Cache", COMMAND_SPECS, "developer");
    // Not the misleading tier fallback…
    expect(alias).not.toContain("not available at your access level");
    // …but the canonical group's help, listing its real subcommands.
    expect(alias).toContain("SUBCOMMANDS");
    expect(alias).toContain("stats");
    // USAGE steers to the canonical path.
    expect(alias).toContain("ib dev cache <command>");
    // Identical to invoking the canonical path directly.
    const canonical = formatGroupHelp(
      "ib dev cache",
      "Cache",
      COMMAND_SPECS,
      "developer"
    );
    expect(alias).toBe(canonical);
  });

  test("ib schema alias for a standard caller shows the canonical not-available message", () => {
    const std = formatGroupHelp("ib schema", "Schema", COMMAND_SPECS, "standard");
    expect(std).toContain("not available at your access level");
    // Points at the canonical path, not the old alias.
    expect(std).toContain("ib dev schema");
  });
});

