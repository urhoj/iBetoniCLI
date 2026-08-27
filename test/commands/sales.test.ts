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

describe("ib sales — segment/search parity with the Myynti UI (fb#817)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  // Segments chosen so each bucket is unambiguous: 'all' must fold into BOTH
  // pumppu and betoni, and the unset row must surface under 'muu'.
  const ROWS: SalesProspect[] = [
    row({ saasProspectId: 1, segment: "pumppu", companyName: "Pumppu Oy" }),
    row({ saasProspectId: 2, segment: "betoni", companyName: "Betoni Oy" }),
    row({ saasProspectId: 3, segment: "all", companyName: "Molemmat Oy" }),
    row({ saasProspectId: 4, segment: "muu", companyName: "Muu Oy" }),
    row({ saasProspectId: 5, segment: null, companyName: "Ei Segmenttia Oy", asiakasNimi: "Piilonimi" }),
  ];

  const ids = async (opts: Parameters<typeof runProspectList>[1]) => {
    mockClient.get.mockResolvedValue(ROWS);
    return (await runProspectList(mockClient, opts)).items.map((r) => r.saasProspectId);
  };

  test("--segment pumppu is pumppu OR all (UI union)", async () => {
    expect(await ids({ segment: "pumppu" })).toEqual([1, 3]);
  });

  test("--segment betoni is betoni OR all (UI union)", async () => {
    expect(await ids({ segment: "betoni" })).toEqual([2, 3]);
  });

  test("--segment muu is muu OR unset — the not-yet-typed bucket (UI union)", async () => {
    expect(await ids({ segment: "muu" })).toEqual([4, 5]);
  });

  test("an explicit non-bucket value stays an exact match", async () => {
    expect(await ids({ segment: "all" })).toEqual([3]);
  });

  test("--search matches asiakasNimi (the UI's field the CLI previously lacked)", async () => {
    expect(await ids({ search: "piilonimi" })).toEqual([5]);
  });

  test("--search trims the needle like the Myynti UI does (q.trim())", async () => {
    // The UI search box trims before matching — a padded box and a padded
    // --search must agree (fb#817 review A3).
    expect(await ids({ search: "  piilonimi  " })).toEqual([5]);
    mockClient.get.mockResolvedValue([row({ saasProspectId: 6, companyName: "Sorvi Oy" })]);
    expect((await runProspectList(mockClient, { search: "SORVI" })).count).toBe(1);
  });

  test("--search still matches companyName + ytunnus + region", async () => {
    expect((await ids({ search: "pumppu oy" })).length).toBeGreaterThan(0);
    mockClient.get.mockResolvedValue([
      row({ saasProspectId: 9, companyName: "X", ytunnus: "7777777-7" }),
      row({ saasProspectId: 10, companyName: "Y", region: "Kainuu" }),
    ]);
    expect((await runProspectList(mockClient, { search: "7777777" })).count).toBe(1);
    // mockResolvedValue persists across calls — no need to re-arm for the next
    // assertion on the same rows.
    expect((await runProspectList(mockClient, { search: "kainuu" })).count).toBe(1);
  });

  test("--search matches a needle straddling the companyName→asiakasNimi join boundary, like the Myynti UI (fb#920)", async () => {
    mockClient.get.mockResolvedValue([
      row({ saasProspectId: 11, companyName: "Kamppi", asiakasNimi: "Rakennus Oy" }),
    ]);
    // Neither field alone contains "kamppi rakennus" — only the UI's joined
    // `${companyName} ${asiakasNimi}` string does.
    expect((await runProspectList(mockClient, { search: "kamppi rakennus" })).count).toBe(1);
  });
});
