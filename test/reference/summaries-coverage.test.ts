import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(here, "../../src/reference/summaries.coverage.json");

type LedgerRecord = { lastReviewed: string | null; runs: number };
const ledger: Record<string, LedgerRecord> = JSON.parse(
  readFileSync(ledgerPath, "utf8")
);

describe("summaries coverage ledger", () => {
  const commandPaths = new Set(COMMAND_SPECS.map((s) => s.command));

  test("every ledger key is a real command (no orphans)", () => {
    const orphans = Object.keys(ledger).filter((k) => !commandPaths.has(k));
    expect(orphans, `orphan ledger keys: ${orphans.join(", ")}`).toEqual([]);
  });

  test("each record has lastReviewed (null | YYYY-MM-DD) and numeric runs", () => {
    for (const [cmd, rec] of Object.entries(ledger)) {
      expect(typeof rec, `${cmd} record`).toBe("object");
      if (rec.lastReviewed !== null) {
        expect(String(rec.lastReviewed), `${cmd} lastReviewed`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(typeof rec.runs, `${cmd} runs`).toBe("number");
    }
  });
});
