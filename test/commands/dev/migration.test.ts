import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "../../helpers/mockClient.js";
import { runMigrationRun } from "../../../src/commands/dev/migration/index.js";

const NAME = "run-2026-09-18-restore-lost-push-optouts";

describe("runMigrationRun", () => {
  test("a dry run posts the basename with X-Dry-Run and the reason", async () => {
    const client = mockApiClient({ post: vi.fn(async () => ({ exitCode: 0 })) });
    await runMigrationRun(client, NAME, { dryRun: true, reason: "check" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/cli/migration/run",
      { basename: NAME, expectDb: undefined },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "check" } }
    );
  });

  test("an apply sends --expect-db in the body", async () => {
    const client = mockApiClient({ post: vi.fn(async () => ({ exitCode: 0 })) });
    await runMigrationRun(client, NAME, { expectDb: "puminet", reason: "apply" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/cli/migration/run",
      { basename: NAME, expectDb: "puminet" },
      { headers: { "X-Action-Reason": "apply" } }
    );
  });

  test("neither --dry-run nor --expect-db is refused before any request", async () => {
    const client = mockApiClient();
    await expect(runMigrationRun(client, NAME, { reason: "x" })).rejects.toThrow("pass --dry-run first");
    expect(client.post).not.toHaveBeenCalled();
  });
});
