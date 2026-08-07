import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { Command } from "commander";
import { enforceSpecReasonPolicy } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError } from "../../src/api/errors.js";

/**
 * Guards the spec-declared `--reason` mechanism ({@link CommandSpec.reasonPolicy})
 * from three directions:
 *
 *  1. UNIT — `enforceSpecReasonPolicy` (the preAction hook body) resolves the
 *     running command's spec via its parent chain and enforces the declared
 *     policy: `"always"` demands `--reason` unconditionally, `"unless-dry-run"`
 *     lets `--dry-run` stand in, `reasonDetail` rides in the error message, and
 *     a spec-less / policy-less path is a no-op.
 *  2. DRIFT — a spec whose ERRORS prose documents a client-side "missing
 *     --reason" failure must also declare the machine-readable policy (minus an
 *     explicit exception list for genuinely conditional requirements).
 *  3. SOURCE — no command action may hand-call `requireReason` any more; the
 *     only legitimate homes are its definition (src/api/writeFlags.ts) and
 *     src/program.ts (the hook itself + the documented `reference detail set`
 *     edit-mode exception).
 */

// ─── 1. unit: enforceSpecReasonPolicy over fake command chains ───────────────

/** Minimal Command stand-in: just the members commandPath()/opts() touch. */
interface FakeCmd {
  name: () => string;
  parent: FakeCmd | null;
  opts: () => Record<string, unknown>;
}

/** Build a fake parent chain for a space-joined path (e.g. "ib person delete"). */
function fake(path: string, opts: Record<string, unknown> = {}): Command {
  const parts = path.split(" ");
  let parent: FakeCmd | null = null;
  for (const p of parts.slice(0, -1)) {
    const prev = parent;
    parent = { name: () => p, parent: prev, opts: () => ({}) };
  }
  const leaf: FakeCmd = { name: () => parts[parts.length - 1], parent, opts: () => opts };
  return leaf as unknown as Command;
}

/** Run the hook and hand back the CliError it must throw. */
function reasonError(cmd: Command): CliError {
  try {
    enforceSpecReasonPolicy(cmd);
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error("expected enforceSpecReasonPolicy to throw");
}

describe("enforceSpecReasonPolicy", () => {
  test('an "always" command without --reason exits 4', () => {
    // Real spec path with reasonPolicy: "always".
    const err = reasonError(fake("ib person delete", {}));
    expect(err.exitCode).toBe(4);
    expect(err.statusCode).toBe(0); // client-origin, matches the origin:"client" spec rows
    expect(err.message).toContain("Missing required flag: --reason");
  });

  test('an "always" command is NOT exempted by --dry-run', () => {
    const err = reasonError(fake("ib person delete", { dryRun: true }));
    expect(err.exitCode).toBe(4);
  });

  test('an "always" command with --reason passes', () => {
    expect(() =>
      enforceSpecReasonPolicy(fake("ib person delete", { reason: "cleanup" }))
    ).not.toThrow();
  });

  test('an "unless-dry-run" command with --dry-run passes', () => {
    // Real spec path with reasonPolicy: "unless-dry-run".
    expect(() =>
      enforceSpecReasonPolicy(fake("ib legal delete", { dryRun: true }))
    ).not.toThrow();
  });

  test('an "unless-dry-run" command without --reason or --dry-run exits 4', () => {
    const err = reasonError(fake("ib legal delete", {}));
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain("Missing required flag: --reason");
  });

  test("reasonDetail is appended to the thrown message", () => {
    const attachment = reasonError(fake("ib attachment delete", {}));
    expect(attachment.message).toContain("(blob deletion is irreversible)");
    const merge = reasonError(fake("ib customer merge", {}));
    expect(merge.message).toContain(
      "(customer merge is irreversible; --dry-run previews via /validate)"
    );
  });

  test("a spec-less path is a no-op", () => {
    expect(() => enforceSpecReasonPolicy(fake("ib no such command", {}))).not.toThrow();
  });

  test("a policy-less spec path is a no-op", () => {
    // Real spec, no reasonPolicy (read command).
    expect(() => enforceSpecReasonPolicy(fake("ib company list", {}))).not.toThrow();
  });
});

// ─── 2. drift: documented missing-`--reason` errors imply a declared policy ──

/**
 * Commands whose `--reason` requirement is genuinely CONDITIONAL — not
 * expressible as a spec-level policy — and therefore keep a hand-called
 * `requireReason` at the branch that needs it (in src/program.ts):
 *
 *  - "ib reference detail set": `--reason` is required only in EDIT mode
 *    (--replace/--append/--prepend); a plain --summary/--detail set does not
 *    demand it. See the "deliberate exception" comment in program.ts.
 *
 * NOT excepted (verified unconditional from source, migrated to the spec):
 * "ib legal save" calls the guard in BOTH its full-save and edit-mode branches,
 * so the requirement is unconditional and lives in its spec.
 */
const CONDITIONAL_REASON_EXCEPTIONS = new Set<string>(["ib reference detail set"]);

describe("reasonPolicy drift guard", () => {
  test("every spec documenting a client-origin missing---reason error declares reasonPolicy", () => {
    const offenders = COMMAND_SPECS.filter(
      (s) =>
        !CONDITIONAL_REASON_EXCEPTIONS.has(s.command) &&
        !s.reasonPolicy &&
        s.errors.some(
          (e) =>
            "origin" in e && e.origin === "client" && /missing --reason/i.test(e.meaning)
        )
    ).map((s) => s.command);
    expect(offenders).toEqual([]);
  });

  test("the exception list stays honest: entries exist and declare no policy", () => {
    for (const command of CONDITIONAL_REASON_EXCEPTIONS) {
      const spec = COMMAND_SPECS.find((s) => s.command === command);
      expect(spec, `${command} vanished from COMMAND_SPECS — prune the exception`).toBeDefined();
      expect(
        spec?.reasonPolicy,
        `${command} now declares reasonPolicy — remove it from the exception list`
      ).toBeUndefined();
    }
  });
});

// ─── 3. source walk: no hand-called requireReason outside the two homes ──────

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** Files where `requireReason(` may legitimately appear. */
const ALLOWED_FILES = new Set(["api/writeFlags.ts", "program.ts"]);

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsFilesUnder(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** 1-based line numbers of every literal `requireReason(` call/definition in `source`. */
export function requireReasonSitesIn(source: string): number[] {
  const found: number[] = [];
  const NEEDLE = "requireReason(";
  for (let at = source.indexOf(NEEDLE); at !== -1; at = source.indexOf(NEEDLE, at + NEEDLE.length)) {
    found.push(source.slice(0, at).split("\n").length);
  }
  return found;
}

describe("no in-action requireReason calls remain", () => {
  test("`requireReason(` appears only in src/api/writeFlags.ts and src/program.ts", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (ALLOWED_FILES.has(rel)) continue;
      for (const line of requireReasonSitesIn(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scanner recognises a planted positive", () => {
    const sample = [
      "// prose mentioning requireReason without a call is NOT matched",
      "  requireReason(opts);",
      "  requireReason(opts, { allowDryRun: true });",
    ].join("\n");
    expect(requireReasonSitesIn(sample)).toEqual([2, 3]);
  });
});
