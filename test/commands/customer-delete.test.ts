import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runCustomerDelete } from "../../src/commands/customer/index.js";

const mockClient = mockApiClient();

describe("runCustomerDelete", () => {
  beforeEach(() => {
    mockClient.delete.mockReset();
  });

  test("DELETEs /api/asiakas/delete/<asiakasId>/<ownerAsiakasId> with X-Action-Reason", async () => {
    mockClient.delete.mockResolvedValueOnce({ deleted: 9001 });
    const result = await runCustomerDelete(
      mockClient,
      9001,
      1349,
      { reason: "lifecycle cleanup" }
    );
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/asiakas/delete/9001/1349",
      { headers: { "X-Action-Reason": "lifecycle cleanup" } }
    );
    expect(result).toEqual({ deleted: 9001 });
  });

  test("propagates --dry-run as X-Dry-Run: 1 header", async () => {
    mockClient.delete.mockResolvedValueOnce({ dryRun: true, wouldDelete: 9001 });
    await runCustomerDelete(mockClient, 9001, 1349, { reason: "test", dryRun: true });
    const call = mockClient.delete.mock.calls[0];
    expect(call[1].headers).toMatchObject({
      "X-Action-Reason": "test",
      "X-Dry-Run": "1",
    });
  });
});
