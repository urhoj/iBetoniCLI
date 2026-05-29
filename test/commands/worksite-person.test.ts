import { describe, test, expect, vi, beforeEach } from "vitest";
import { runWorksitePersonAdd, runWorksitePersonRemove, runWorksitePersonList } from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runWorksitePersonAdd", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs /api/tyomaa/person/add with body and reason header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runWorksitePersonAdd(
      mockClient,
      { tyomaaId: 99, personId: 5351, contactPersonTypeId: 1 },
      { reason: "lifecycle add" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/person/add",
      { tyomaaId: 99, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "lifecycle add" } }
    );
  });
});

describe("runWorksitePersonRemove", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs /api/tyomaa/person/remove with body and reason", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runWorksitePersonRemove(
      mockClient,
      { tyomaaId: 99, personId: 5351, contactPersonTypeId: 1 },
      { reason: "lifecycle remove" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/person/remove",
      { tyomaaId: 99, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "lifecycle remove" } }
    );
  });
});

describe("runWorksitePersonList", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });

  test("GETs /api/tyomaa/person/list/<tyomaaId>/0 (second segment ignored)", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personId: 5351, personFirstName: "Juha", personLastName: "Urho", personEmail: "j@example.com" },
    ]);
    const result = await runWorksitePersonList(mockClient, 99);
    expect(mockClient.get).toHaveBeenCalledWith("/api/tyomaa/person/list/99/0");
    expect(result.items[0]).toMatchObject({ personId: 5351, name: "Juha Urho" });
    expect(result.count).toBe(1);
  });
});
