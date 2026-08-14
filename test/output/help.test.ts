import { describe, test, expect, afterEach } from "vitest";
import type { Command } from "commander";
import {
  formatHelp,
  formatGroupHelp,
  type CommandSpec,
} from "../../src/output/help.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { buildProgram } from "../../src/program.js";
import {
  isHiddenAtTier,
  setCallerTier,
  type CallerTier,
} from "../../src/tier.js";

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
    const withWrite = formatHelp({ ...sampleSpec, writeFlags: true, dryRunKind: "server" });
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

/** Full path → Command over the whole tree (no argv hint = every domain). */
const leafIndex = await (async () => {
  const map = new Map<string, Command>();
  const walk = (cmd: Command, path: string[]): void => {
    const full = [...path, cmd.name()].join(" ");
    map.set(full, cmd);
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(await buildProgram(), []);
  return map;
})();

describe("leaf --help leaks no hidden command path", () => {
  // The dump has scrubbed cross-references for a while; leaf `--help` did not,
  // so a VISIBLE command's NOTES / SEE ALSO / ERRORS still named hidden commands
  // (10 leaves at standard tier, incl. `ib auth whoami` → `ib auth impersonate`).
  // Both surfaces now share `scrubSpecForTier` (feedback #288).
  const leaves = leafIndex;

  // The ambient tier is process-global — always hand it back.
  afterEach(() => setCallerTier("developer"));

  for (const tier of ["standard", "admin"] as const satisfies readonly CallerTier[]) {
    test(`no visible leaf's --help names a command hidden at ${tier}`, () => {
      setCallerTier(tier);
      const hidden = COMMAND_SPECS.filter((s) => isHiddenAtTier(s, tier)).map(
        (s) => s.command
      );
      const offenders: string[] = [];
      for (const spec of COMMAND_SPECS) {
        if (isHiddenAtTier(spec, tier)) continue; // renders the fallback, not the spec
        const help = leaves.get(spec.command)?.helpInformation() ?? "";
        for (const h of hidden) if (help.includes(h)) offenders.push(`${spec.command} → ${h}`);
      }
      expect(offenders).toEqual([]);
    });
  }

  test("the redacted remedy replaces the prose but keeps the ERRORS row", () => {
    setCallerTier("standard");
    const help = leaves.get("ib auth whoami")!.helpInformation();
    expect(help).toContain("Impersonation session expired"); // row survives
    expect(help).toContain("not available at your access level");
    expect(help).not.toContain("ib auth impersonate");
  });

  test("developer tier renders the spec verbatim (no over-scrubbing)", () => {
    setCallerTier("developer");
    expect(leaves.get("ib auth whoami")!.helpInformation()).toBe(
      formatHelp(COMMAND_SPECS.find((s) => s.command === "ib auth whoami")!)
    );
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

