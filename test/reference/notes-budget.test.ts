import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import baseline from "./notes-budget-baseline.json" with { type: "json" };

/**
 * fb#780 — per-spec notes budget. Notes are the fastest-growing dump field
 * (~30 KB in June 2026, ~94 KB by August) because they are where spec authors
 * park caveats; long business context belongs in the DB detail tier
 * (`ib reference detail set <cmd> --field detail`), which every AI can fetch
 * on demand without every dump/`--help` reader paying for it.
 *
 * Ratchet semantics (mirrors the workspace baseline auditors): only a NEW
 * offender or a GROWN baselined one fails; the liveness guard forces stale
 * baseline entries to be pruned, so the file can only shrink honestly.
 */
const NOTES_BUDGET_BYTES = 800;

const notesBytes = (notes: string[] | undefined): number =>
  JSON.stringify(notes ?? []).length;

const ceilings: Record<string, number> = baseline.ceilings;

describe("spec notes budget (fb#780)", () => {
  test(`no spec exceeds ${NOTES_BUDGET_BYTES} B of notes unless baselined (and never above its ceiling)`, () => {
    const failures: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const bytes = notesBytes(spec.notes);
      const ceiling = ceilings[spec.command];
      if (ceiling !== undefined) {
        if (bytes > ceiling) {
          failures.push(
            `${spec.command}: notes grew to ${bytes} B (ceiling ${ceiling} B)`
          );
        }
      } else if (bytes > NOTES_BUDGET_BYTES) {
        failures.push(
          `${spec.command}: notes are ${bytes} B (budget ${NOTES_BUDGET_BYTES} B). ` +
            `Trim them — move business context to the detail tier (\`ib reference detail set "${spec.command.replace(/^ib /, "")}" --field detail\`). ` +
            `If the size is a reviewed decision, add '"${spec.command}": ${bytes}' to test/reference/notes-budget-baseline.json in the same PR.`
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("liveness: every baselined spec still exists and still exceeds the budget", () => {
    // A baseline entry for a trimmed or renamed spec is dead weight that hides
    // future growth — prune it (and lower ceilings as specs shrink).
    const byCommand = new Map(COMMAND_SPECS.map((s) => [s.command, s]));
    const stale: string[] = [];
    for (const [command, ceiling] of Object.entries(ceilings)) {
      const spec = byCommand.get(command);
      if (!spec) {
        stale.push(`${command}: no longer in the catalogue — delete its baseline entry`);
        continue;
      }
      const bytes = notesBytes(spec.notes);
      if (bytes <= NOTES_BUDGET_BYTES) {
        stale.push(
          `${command}: notes are now ${bytes} B (<= ${NOTES_BUDGET_BYTES}) — delete its baseline entry`
        );
      } else if (ceiling > bytes) {
        stale.push(
          `${command}: ceiling ${ceiling} B is above the actual ${bytes} B — lower it to ${bytes}`
        );
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
