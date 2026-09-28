import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runStats, resolveStatsPeriod } from "../../src/commands/stats/index.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintForError } from "../../src/api/errors.js";

const mockClient = mockApiClient();

beforeEach(() => {
  mockClient.get.mockReset();
  mockClient.get.mockResolvedValue({ totals: { orders: 0, m3: 0 } });
});

describe("resolveStatsPeriod", () => {
  test("--month expands to first/last day", () => {
    expect(resolveStatsPeriod({ month: "2026-06" })).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
  test("--week expands to 7-day window (alias resolved)", () => {
    expect(resolveStatsPeriod({ week: "2026-06-08" })).toEqual({ from: "2026-06-08", to: "2026-06-14" });
  });
  test("--from/--to pass through (aliases resolved)", () => {
    expect(resolveStatsPeriod({ from: "2026-06-01", to: "2026-06-30" })).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
  test("rejects combining period flags", () => {
    expect(() => resolveStatsPeriod({ month: "2026-06", today: true })).toThrow();
    expect(() => resolveStatsPeriod({ month: "2026-06", from: "2026-06-01", to: "2026-06-02" })).toThrow();
  });
  test("rejects from without to", () => {
    expect(() => resolveStatsPeriod({ from: "2026-06-01" })).toThrow();
  });
});

describe("runStats", () => {
  test("builds /api/cli/stats query with from/to", async () => {
    await runStats(mockClient, { from: "2026-06-01", to: "2026-06-30" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/stats?from=2026-06-01&to=2026-06-30");
  });
  test("appends &by= when --by given", async () => {
    await runStats(mockClient, { month: "2026-06", by: "customer" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/stats?from=2026-06-01&to=2026-06-30&by=customer");
  });
  test("rejects an unknown --by before any network call", async () => {
    await expect(runStats(mockClient, { month: "2026-06", by: "bogus" })).rejects.toThrow();
    expect(mockClient.get).not.toHaveBeenCalled();
  });
  test("appends &all=1 when --all given", async () => {
    await runStats(mockClient, { from: "2026-06-01", to: "2026-06-30", all: true });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/stats?from=2026-06-01&to=2026-06-30&all=1");
  });
  test("omits &all when --all not given", async () => {
    await runStats(mockClient, { from: "2026-06-01", to: "2026-06-30" });
    const url = mockClient.get.mock.calls[0][0] as string;
    expect(url).not.toContain("all=");
  });
});

describe("runStats --iso-week (company-scoped weekly route)", () => {
  test("GETs /api/stat/weekly?week=", async () => {
    await runStats(mockClient, { isoWeek: "2026-39" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/stat/weekly?week=2026-39");
  });
  test("rejects a malformed week before any network call", async () => {
    await expect(runStats(mockClient, { isoWeek: "2026-9" })).rejects.toThrow(/YYYY-WW/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
  test("cannot be combined with another period flag, --by or --all", async () => {
    expect(() => resolveStatsPeriod({ isoWeek: "2026-39", month: "2026-09" })).toThrow();
    await expect(runStats(mockClient, { isoWeek: "2026-39", by: "vehicle" })).rejects.toThrow(/--iso-week/);
    await expect(runStats(mockClient, { isoWeek: "2026-39", all: true })).rejects.toThrow(/--iso-week/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});

// Review fix round 1: the new --iso-week 403 row had no `match`, so per matchHttpRow
// (src/api/errors.ts) it became the FIRST unmatched 403 row — the catch-all — and
// silently answered the pre-existing, unrelated `--all` 403 too. Assert against the
// REAL backend message text for each cause (puminet5api routes/statRoutes.js:114
// requireCompanyRole denyMessage; routes/cli/statsCliRoutes.js:35 the --all gate) to
// prove each reaches its own remedy rather than the other's.
describe("ib stats — 403 remedy disambiguation (--iso-week vs --all)", () => {
  const statsErrors = () => COMMAND_SPECS.find((s) => s.command === "ib stats")!.errors;

  test("the real Viikkotilastot company-admin 403 gets the --iso-week remedy", () => {
    const err = new CliError("Viikkotilastot näkyvät yrityksen pääkäyttäjille", 403, null, 3);
    expect(hintForError(err, statsErrors())).toMatch(/asiakasAdmin/);
  });

  test("the real --all scope 403 does NOT get the --iso-week remedy", () => {
    const err = new CliError("all scope requires developer or global-viewer access", 403, null, 3);
    const hint = hintForError(err, statsErrors());
    expect(hint).not.toMatch(/asiakasAdmin/);
  });
});
