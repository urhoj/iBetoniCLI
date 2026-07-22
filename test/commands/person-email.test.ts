import { describe, test, expect, vi } from "vitest";
import { runPersonEmailList, runPersonEmailAdd, runPersonEmailRemove } from "../../src/commands/person/email.js";
import type { ApiClient } from "../../src/api/client.js";

type MockClient = ApiClient & Record<"get" | "put" | "post" | "delete" | "getCurrentToken", ReturnType<typeof vi.fn>>;

function mockClient(over: Partial<Record<string, unknown>> = {}): MockClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
    ...over,
  } as unknown as MockClient;
}

describe("person email", () => {
  test("list projects backend rows into a ListEnvelope", async () => {
    const client = mockClient();
    client.get.mockResolvedValue([{ email: "p@x.com", main: 1 }, { email: "a@x.com", main: 0 }]);
    const out = await runPersonEmailList(client, "5");
    expect(client.get).toHaveBeenCalledWith("/api/person/getPersonEmails/5");
    expect(out).toEqual({
      items: [{ email: "p@x.com", main: 1 }, { email: "a@x.com", main: 0 }],
      nextCursor: null,
      count: 2,
      truncated: false,
    });
  });

  test("add posts the target personId + email with write headers", async () => {
    const client = mockClient();
    client.post.mockResolvedValue({ personId: 5, personEmail: "a@x.com", added: true });
    const out = await runPersonEmailAdd(client, "5", "a@x.com", { reason: "ops" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/person/addPersonEmail",
      { personId: 5, personEmail: "a@x.com" },
      { headers: { "X-Action-Reason": "ops" } }
    );
    expect(out).toEqual({ personId: 5, personEmail: "a@x.com", added: true });
  });

  test("add forwards dry-run header", async () => {
    const client = mockClient();
    client.post.mockResolvedValue({ dryRun: true });
    await runPersonEmailAdd(client, "5", "a@x.com", { dryRun: true, reason: "ops" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/person/addPersonEmail",
      { personId: 5, personEmail: "a@x.com" },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "ops" } }
    );
  });

  test("remove deletes with url-encoded email + write headers", async () => {
    const client = mockClient();
    client.delete.mockResolvedValue({ ok: true });
    await runPersonEmailRemove(client, "5", "a+b@x.com", { reason: "ops" });
    expect(client.delete).toHaveBeenCalledWith(
      "/api/person/deletePersonEmail/5/a%2Bb%40x.com",
      { headers: { "X-Action-Reason": "ops" } }
    );
  });
});
