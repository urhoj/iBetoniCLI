import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintForError } from "../../src/api/errors.js";

// fb#1844: `ib customer settings --company 27` (no positional, no --asiakas)
// exits 4 with resolveTarget's "missing or invalid target: …" message — and the
// hint said "pass ecofleet or mapon". matchClientRowForMessage falls back to the
// ONLY un-matched exit-4 client row, which on that command was the
// --gps-provider one. Pin the pairing on every <asiakasId>/--asiakas dual-target
// customer command: the target error resolves the target remedy, and the
// gps-provider error still resolves its own.
const TARGET_MSG = "missing or invalid target: pass <asiakasId> positionally or via --asiakas <id>";
const clientErr = (msg: string): CliError => new CliError(msg, 0, null, 4);

describe("customer dual-target commands — missing-target hint", () => {
  // fb#1863: the jerry admin trio had NO row at all (hint: null), same gap.
  test.each(["ib customer settings", "ib customer modules", "ib customer operator", "ib jerry admin detail", "ib jerry admin enable", "ib jerry admin disable"])(
    "%s resolves the target remedy, never a sibling exit-4 row",
    (command) => {
      const spec = COMMAND_SPECS.find((s) => s.command === command);
      expect(spec).toBeDefined();
      const hint = hintForError(clientErr(TARGET_MSG), spec!.errors);
      expect(hint).toBe("pass <asiakasId> positionally or via --asiakas <id>");
    }
  );

  test("ib customer settings still hints the --gps-provider row for its own error", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib customer settings")!;
    const hint = hintForError(clientErr("unknown --gps-provider: teltonika. Valid: ecofleet, mapon"), spec.errors);
    expect(hint).toBe("pass ecofleet or mapon");
  });
});
