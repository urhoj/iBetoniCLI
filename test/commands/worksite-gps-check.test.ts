import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runWorksiteGpsCheck } from "../../src/commands/worksite/index.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = mockApiClient();

const proposal = (tyomaaId: number, autoApplicable: boolean, confidence: "high" | "medium" | "low" = "high") => ({
  tyomaaId,
  tyomaaNimi: null,
  accuracy: autoApplicable ? "PARTIAL" : "EXACT",
  current: { lat: 60.04, lng: 24 },
  proposed: { lat: 60.14, lng: 24 },
  distanceM: 11000,
  spreadM: 0,
  keikkaIds: [1],
  confidence,
  autoApplicable,
});

const envelope = (items: ReturnType<typeof proposal>[]) => ({ items, nextCursor: null, count: items.length });

describe("ib worksite gps-check (fb#2361)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.post.mockReset();
  });

  test("reads only, with from/to in the query, when --apply is absent", async () => {
    mockClient.get.mockResolvedValueOnce(envelope([proposal(1, true)]));
    const res = await runWorksiteGpsCheck(mockClient, { from: "2026-10-01", to: "2026-10-08" }, false, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/gps-check?from=2026-10-01&to=2026-10-08");
    expect(mockClient.post).not.toHaveBeenCalled();
    expect(res.items[0].applied).toBeUndefined();
  });

  test("--apply pins only autoApplicable rows and reports a failed pin on its row", async () => {
    mockClient.get.mockResolvedValueOnce(envelope([proposal(1, true), proposal(2, false), proposal(3, true)]));
    mockClient.post
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new CliError("Worksite not found", 404, null, 5));
    const res = await runWorksiteGpsCheck(mockClient, { from: "2026-10-01" }, true, { dryRun: true });

    expect(mockClient.post).toHaveBeenCalledTimes(2);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/1/location",
      { lat: 60.14, lng: 24 },
      { headers: expect.objectContaining({ "X-Dry-Run": "1", "X-Action-Reason": expect.stringContaining("GPS stop pin") }) }
    );
    expect(res.items.map((p) => p.applied)).toEqual([true, undefined, false]);
    expect(res.items[2].error).toContain("not found");
  });

  test("--apply skips single-pour (medium) rows unless --min-confidence medium", async () => {
    const rows = () => envelope([proposal(1, true, "high"), proposal(2, true, "medium"), proposal(3, true, "low")]);
    mockClient.get.mockResolvedValueOnce(rows());
    mockClient.post.mockResolvedValue({ success: true });
    const strict = await runWorksiteGpsCheck(mockClient, { from: "2026-10-01" }, true, {});
    expect(strict.items.map((p) => p.applied)).toEqual([true, undefined, undefined]);

    mockClient.get.mockResolvedValueOnce(rows());
    const loose = await runWorksiteGpsCheck(mockClient, { from: "2026-10-01" }, true, {}, "medium");
    expect(loose.items.map((p) => p.applied)).toEqual([true, true, undefined]);
  });
});
