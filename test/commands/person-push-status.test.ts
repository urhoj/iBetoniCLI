import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runPersonPushStatus } from "../../src/commands/person/pushStatus.js";

const c = mockApiClient();
const LIST = { items: [], nextCursor: null, count: 0 };

describe("ib person push-status", () => {
  beforeEach(() => vi.clearAllMocks());

  test("no flags = bare path", async () => {
    c.get.mockResolvedValueOnce(LIST);
    await runPersonPushStatus(c, {});
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/push-status");
  });

  test("passes --since as an ISO date and --drivers-only as true", async () => {
    c.get.mockResolvedValueOnce(LIST);
    await runPersonPushStatus(c, { since: "2026-10-29", driversOnly: true });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/push-status?since=2026-10-29&driversOnly=true");
  });

  test("resolves the today alias", async () => {
    c.get.mockResolvedValueOnce(LIST);
    await runPersonPushStatus(c, { since: "today" });
    expect(c.get.mock.calls[0][0]).toMatch(/\?since=\d{4}-\d{2}-\d{2}$/);
  });
});
