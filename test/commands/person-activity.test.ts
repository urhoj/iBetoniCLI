import { describe, test, expect, vi } from "vitest";
import { runPersonActivity } from "../../src/commands/person/activity.js";
import type { ApiClient } from "../../src/api/client.js";

describe("runPersonActivity", () => {
  test("GETs the activity endpoint with the limit query", async () => {
    const get = vi.fn(async () => ({ personId: 63 }));
    const res = await runPersonActivity({ get } as unknown as ApiClient, 63, { limit: 20 });
    expect(get).toHaveBeenCalledWith("/api/cli/person/63/activity?limit=20");
    expect(res).toEqual({ personId: 63 });
  });

  test("omits the query when no limit is given", async () => {
    const get = vi.fn(async () => ({}));
    await runPersonActivity({ get } as unknown as ApiClient, 63, {});
    expect(get).toHaveBeenCalledWith("/api/cli/person/63/activity");
  });
});
