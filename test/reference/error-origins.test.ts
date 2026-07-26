import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintForError } from "../../src/api/errors.js";
import type { CommandError } from "../../src/output/help.js";

/**
 * Feedback #289: a spec ERRORS row is matched to a real error by `http`
 * (server-originated) or by `exit` (client-side only), so a server row written
 * without `http` is DEAD — its remedy can never reach the caller, who silently
 * gets the generic per-status hint instead. The `CommandError` union makes the
 * omission a compile error; this file guards the two things the type cannot:
 * rows built dynamically or through a cast, and the specific rows that were
 * found dead.
 */

function rowsOf(command: string): CommandError[] {
  const spec = COMMAND_SPECS.find((s) => s.command === command);
  if (!spec) throw new Error(`no spec for ${command}`);
  return spec.errors;
}

describe("every documented error row declares exactly one origin", () => {
  test("no row omits both `http` and `origin` (dead row), and none declares both", () => {
    const offenders: string[] = [];
    for (const spec of COMMAND_SPECS) {
      for (const row of spec.errors ?? []) {
        const hasHttp = row.http !== undefined;
        const hasOrigin = row.origin !== undefined;
        if (hasHttp === hasOrigin) {
          offenders.push(`${spec.command} :: exit ${row.exit} — ${row.meaning}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("client rows never carry an http status (they are raised before any request)", () => {
    for (const spec of COMMAND_SPECS) {
      for (const row of spec.errors ?? []) {
        if (row.origin === "client") expect(row.http).toBeUndefined();
      }
    }
  });
});

// The four rows the fb#289 audit missed: each documents a SERVER response but was
// written as a bare `{ exit }`, so the command's own remedy was unreachable.
describe("previously dead rows now reach their own remedy", () => {
  test.each(["ib reference detail delete", "ib reference detail lint"])(
    "%s answers a real 403 with its developer-access remedy, not the generic one",
    (command) => {
      const hint = hintForError(new CliError("Forbidden", 403, null, 3), rowsOf(command));
      expect(hint).toMatch(/isDeveloper/i);
      expect(hint).not.toMatch(/check the PERMISSIONS line/i);
    }
  );

  test.each(["ib jerry coverage", "ib jerry email-activity"])(
    "%s separates the local not-logged-in guard from a server 401",
    (command) => {
      const rows = rowsOf(command);
      expect(hintForError(new CliError("Not logged in", 0, null, 2), rows)).toMatch(/auth login/i);
      expect(hintForError(new CliError("Unauthorized", 401, null, 2), rows)).toMatch(/auth refresh/i);
    }
  );
});
