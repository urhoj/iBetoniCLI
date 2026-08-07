import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runPersonAbsences } from "../../src/commands/person/absences.js";

const c = mockApiClient();

const LIST = { items: [], nextCursor: null, count: 0 };

describe("ib person absences", () => {
  beforeEach(() => vi.clearAllMocks());

  test("encodes from/to/personId (reuses /api/cli/driver/absences)", async () => {
    c.get.mockResolvedValueOnce(LIST);
    await runPersonAbsences(c, { from: "2026-06-01", to: "2026-06-30", person: 555 });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/absences?from=2026-06-01&to=2026-06-30&personId=555");
  });

  test("omits personId when absent", async () => {
    c.get.mockResolvedValueOnce(LIST);
    await runPersonAbsences(c, { from: "2026-06-01", to: "2026-06-30" });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/absences?from=2026-06-01&to=2026-06-30");
  });
});
