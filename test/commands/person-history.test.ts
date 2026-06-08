import { describe, test, expect, vi, beforeEach } from "vitest";
import { runPersonHistory } from "../../src/commands/person/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const ROW = {
  changeId: 10,
  fieldName: "asiakasPersonSetting",
  oldValue: null,
  newValue: "2",
  changeType: "info_change",
  personId: 8,
  personFullName: "Juha Urho",
  timestamp: "2026-06-08T20:00:00.000Z",
  description: "Rooli lisätty: asiakasAdmin (Asiakas Admin)",
  reason: "requested by user",
};
const EMAIL_ROW = { changeId: 11, fieldName: "personEmail", newValue: "x@y.fi" };

describe("runPersonHistory", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("resolves active owner then GETs /api/changes/person/<id>/<owner>; projects rows", async () => {
    const get = mockClient.get as ReturnType<typeof vi.fn>;
    get
      .mockResolvedValueOnce({ currentCompanyId: 27 }) // resolveOwnerAsiakasId
      .mockResolvedValueOnce([ROW]); // change rows
    const result = await runPersonHistory(mockClient, 63, 100);
    expect(get).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
    expect(get).toHaveBeenNthCalledWith(2, "/api/changes/person/63/27?limit=100");
    expect(result.count).toBe(1);
    expect(result.items[0]).toMatchObject({
      changeId: 10,
      field: "asiakasPersonSetting",
      personName: "Juha Urho",
      at: "2026-06-08T20:00:00.000Z",
      reason: "requested by user",
    });
  });

  test("--owner skips the company-selection lookup", async () => {
    const get = mockClient.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce([ROW]);
    await runPersonHistory(mockClient, 63, 50, { owner: 27 });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/changes/person/63/27?limit=50");
  });

  test("--field filters client-side to one changeTracker field", async () => {
    const get = mockClient.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce([ROW, EMAIL_ROW]);
    const result = await runPersonHistory(mockClient, 63, 100, {
      owner: 27,
      field: "asiakasPersonSetting",
    });
    expect(result.count).toBe(1);
    expect(result.items[0].field).toBe("asiakasPersonSetting");
  });
});
