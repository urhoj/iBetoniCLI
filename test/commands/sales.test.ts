import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  resolveProspect,
  runProspectList,
  runProspectUpdate,
  type SalesProspect,
} from "../../src/commands/sales/index.js";
import type { WriteFlags } from "../../src/api/writeFlags.js";

const mockClient = mockApiClient();

/** The CliError exitCode a promise rejects with (undefined when it resolves). */
async function exitCodeOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
}

const row = (over: Partial<SalesProspect>): SalesProspect => ({
  saasProspectId: 1,
  asiakasId: 100,
  companyName: "Betoni Oy",
  status: "prospect",
  ...over,
});

const NO_FLAGS: WriteFlags = {};

describe("ib sales — resolveProspect ytunnus normalisation (fb#819)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.put.mockReset();
  });

  test("1869376-5 and 18693765 resolve the SAME row (both stored shapes, both query shapes)", async () => {
    // A format miss here is what sends the weekly job down `add` and creates a
    // duplicate row the filtered unique index cannot catch — the whole reason
    // this lookup normalises digits-only.
    mockClient.get.mockResolvedValue([row({ saasProspectId: 7, ytunnus: "1869376-5" })]);
    expect((await resolveProspect(mockClient, { ytunnus: "1869376-5" })).saasProspectId).toBe(7);
    expect((await resolveProspect(mockClient, { ytunnus: "18693765" })).saasProspectId).toBe(7);

    mockClient.get.mockResolvedValue([row({ saasProspectId: 8, ytunnus: "18693765" })]);
    expect((await resolveProspect(mockClient, { ytunnus: "1869376-5" })).saasProspectId).toBe(8);
    expect((await resolveProspect(mockClient, { ytunnus: "18693765" })).saasProspectId).toBe(8);
  });

  test("stored values are compared digits-only, but left EXACTLY as provided", async () => {
    mockClient.get.mockResolvedValue([row({ saasProspectId: 9, ytunnus: " 1869376-5 " })]);
    const hit = await resolveProspect(mockClient, { ytunnus: "18693765" });
    expect(hit.ytunnus).toBe(" 1869376-5 ");
  });

  test("id and --asiakas refs still resolve their own ways", async () => {
    mockClient.get.mockResolvedValue([
      row({ saasProspectId: 3, asiakasId: 500, ytunnus: null }),
      row({ saasProspectId: 4, asiakasId: 600, ytunnus: "2222222-2" }),
    ]);
    expect((await resolveProspect(mockClient, { id: 4 })).saasProspectId).toBe(4);
    expect((await resolveProspect(mockClient, { asiakas: 500 })).saasProspectId).toBe(3);
  });

  test("no ref at all exits 4 BEFORE any fetch", async () => {
    expect(await exitCodeOf(resolveProspect(mockClient, {}))).toBe(4);
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("an EMPTY ytunnus ref exits 4 and matches no row (fb#819 guard)", async () => {
    expect(await exitCodeOf(resolveProspect(mockClient, { ytunnus: "" }))).toBe(4);
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("a WHITESPACE-ONLY ytunnus ref exits 4 — it used to normalise to '' and match any null-ytunnus row", async () => {
    // Seen failing against the pre-fix behaviour: normYtunnus("   ") === ""
    // matched every row whose stored ytunnus is null.
    mockClient.get.mockResolvedValue([row({ saasProspectId: 5, ytunnus: null })]);
    expect(await exitCodeOf(resolveProspect(mockClient, { ytunnus: "   " }))).toBe(4);
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("no match exits 5; ambiguous exits 4 naming both ids", async () => {
    mockClient.get.mockResolvedValue([row({ saasProspectId: 6, ytunnus: "9999999-9" })]);
    expect(await exitCodeOf(resolveProspect(mockClient, { ytunnus: "1111111-1" }))).toBe(5);

    mockClient.get.mockResolvedValue([
      row({ saasProspectId: 12, ytunnus: "1111111-1" }),
      row({ saasProspectId: 13, ytunnus: "11111111" }),
    ]);
    const err: { exitCode?: number; message?: string } | undefined = await resolveProspect(
      mockClient,
      { ytunnus: "1111111-1" }
    ).catch((e) => e);
    expect(err?.exitCode).toBe(4);
    expect(err?.message).toContain("12");
    expect(err?.message).toContain("13");
  });
});

describe("ib sales — the flag-vs-document split on ytunnus (fb#819)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.put.mockReset();
  });

  test("--ytunnus resolves BY the key; the written ytunnus comes only from the update fields", async () => {
    // Lookup by A (digits-only match)...
    mockClient.get.mockResolvedValue([row({ saasProspectId: 11, ytunnus: "1869376-5" })]);
    const target = await resolveProspect(mockClient, { ytunnus: "18693765" });
    expect(target.saasProspectId).toBe(11);

    // ...then write B to the RESOLVED id. Conflating the two would let the
    // lookup key overwrite the field it looked up by.
    mockClient.put.mockResolvedValue({ ok: true });
    await runProspectUpdate(mockClient, target.saasProspectId, { ytunnus: "2691421-3" }, NO_FLAGS);
    expect(mockClient.put).toHaveBeenCalledTimes(1);
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/admin/sales-prospects/11",
      expect.objectContaining({ ytunnus: "2691421-3", scope: "task" }),
      expect.objectContaining({ headers: expect.any(Object) })
    );
    const body = mockClient.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.ytunnus).not.toBe("1869376-5");
    expect(body.ytunnus).not.toBe("18693765");
  });
});

describe("ib sales — runProspectList filters and --brief projection (fb#819)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  const ROWS: SalesProspect[] = [
    row({
      saasProspectId: 1,
      status: "contacted",
      tier: 1,
      segment: "pumps",
      companyName: "Aalto Betoni",
      ytunnus: "1111111-1",
      region: "Uusimaa",
      analysis: "long analysis A",
      pitchAngle: "pitch A",
    }),
    row({
      saasProspectId: 2,
      status: "prospect",
      tier: 2,
      segment: "logistics",
      companyName: "Betonimestarit",
      ytunnus: "2222222-2",
      region: "Pirkanmaa",
      analysis: "long analysis B",
      pitchAngle: "pitch B",
    }),
  ];

  test("no filters returns every row in an envelope", async () => {
    mockClient.get.mockResolvedValue(ROWS);
    const out = await runProspectList(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/admin/sales-prospects");
    expect(out.count).toBe(2);
    expect(out.items.map((r) => r.saasProspectId)).toEqual([1, 2]);
  });

  test("status / tier / segment / search filter client-side", async () => {
    mockClient.get.mockResolvedValue(ROWS);
    expect((await runProspectList(mockClient, { status: "prospect" })).count).toBe(1);
    mockClient.get.mockResolvedValue(ROWS);
    expect((await runProspectList(mockClient, { tier: 1 })).count).toBe(1);
    mockClient.get.mockResolvedValue(ROWS);
    expect((await runProspectList(mockClient, { segment: "logistics" })).count).toBe(1);
    mockClient.get.mockResolvedValue(ROWS);
    expect((await runProspectList(mockClient, { search: "aalto" })).count).toBe(1);
    mockClient.get.mockResolvedValue(ROWS);
    expect((await runProspectList(mockClient, { search: "2222222" })).count).toBe(1);
  });

  test("--brief drops analysis + pitchAngle and nothing else", async () => {
    mockClient.get.mockResolvedValue(ROWS);
    const out = await runProspectList(mockClient, { brief: true });
    for (const item of out.items) {
      expect(item.analysis).toBeUndefined();
      expect(item.pitchAngle).toBeUndefined();
      expect(item.saasProspectId).toBeDefined();
      expect(item.companyName).toBeDefined();
    }
  });
});
