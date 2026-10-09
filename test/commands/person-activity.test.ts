import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runPersonActivity } from "../../src/commands/person/activity.js";

describe("runPersonActivity", () => {
  test("GETs the activity endpoint with the limit query", async () => {
    const get = vi.fn(async () => ({ personId: 63 }));
    const res = await runPersonActivity(mockApiClient({ get }), 63, { limit: 20 });
    expect(get).toHaveBeenCalledWith("/api/cli/person/63/activity?limit=20");
    expect(res).toEqual({ personId: 63 });
  });

  test("omits the query when no limit is given", async () => {
    const get = vi.fn(async () => ({}));
    await runPersonActivity(mockApiClient({ get }), 63, {});
    expect(get).toHaveBeenCalledWith("/api/cli/person/63/activity");
  });

  test("passes the --from/--to window, expanding relative dates (fb#2348)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    try {
      const get = vi.fn(async () => ({}));
      await runPersonActivity(mockApiClient({ get }), 6286, { from: "yesterday", to: "2026-10-07T09:30" });
      expect(get).toHaveBeenCalledWith(
        "/api/cli/person/6286/activity?from=2026-10-06&to=2026-10-07T09%3A30"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
