import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "../../helpers/mockClient.js";
import type { MockApiClient, MockApiClientOverrides } from "../../helpers/mockClient.js";
import { runDbTargetShow, runDbTargetSet } from "../../../src/commands/dev/db-target/index.js";

const DEV = {
  target: "dev",
  targets: ["dev", "prod"],
  switchable: true,
  server: "127.0.0.1",
  database: "puminet_dev",
  missing: [],
  complete: true,
};

function mockClient(over: MockApiClientOverrides = {}): MockApiClient {
  return mockApiClient({
    get: vi.fn(async () => DEV),
    post: vi.fn(async () => ({ ...DEV, changed: true })),
    getCurrentToken: vi.fn(() => "tok"),
    ...over,
  });
}

describe("runDbTargetShow", () => {
  test("without --expect returns the backend description untouched", async () => {
    const client = mockClient();
    const res = await runDbTargetShow(client);
    expect(client.get).toHaveBeenCalledWith("/api/dev/db-target");
    expect(res).toEqual(DEV);
    expect(res).not.toHaveProperty("matches");
  });

  test("--expect that matches sets matches:true (caller exits 0)", async () => {
    const res = await runDbTargetShow(mockClient(), { expect: "dev" });
    expect(res).toMatchObject({ expected: "dev", matches: true });
  });

  // The point of the flag: a routine must be able to stop BEFORE it writes when
  // the local backend turns out to be pointed at production (feedback #430).
  test("--expect that misses sets matches:false and still reports the real target", async () => {
    const client = mockClient({ get: vi.fn(async () => ({ ...DEV, target: "prod", database: "puminet" })) });
    const res = await runDbTargetShow(client, { expect: "dev" });
    expect(res).toMatchObject({ target: "prod", expected: "dev", matches: false });
  });
});

describe("runDbTargetSet", () => {
  test("without --confirm previews and sends NOTHING", async () => {
    const client = mockClient();
    const res = await runDbTargetSet(client, "prod", false);
    expect(client.post).not.toHaveBeenCalled();
    expect(res).toMatchObject({ dryRun: true, from: "dev", to: "prod", wouldFlushCache: true });
  });

  // The backend flushes only when the target actually changes
  // (routes/devRoutes.js `if (result.changed)`), so a same-target preview must
  // not claim a flush it will not perform.
  test("previewing the target you are already on reports no flush", async () => {
    const res = (await runDbTargetSet(mockClient(), "dev", false)) as {
      wouldFlushCache: boolean;
      hint: string;
    };
    expect(res.wouldFlushCache).toBe(false);
    expect(res.hint).toMatch(/no-op/);
  });

  test("--confirm posts the target and does not pre-read", async () => {
    const client = mockClient();
    const res = await runDbTargetSet(client, "dev", true);
    expect(client.post).toHaveBeenCalledWith("/api/dev/db-target", { target: "dev" });
    expect(client.get).not.toHaveBeenCalled();
    expect(res).toMatchObject({ changed: true });
  });
});
