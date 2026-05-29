import { describe, test, expect, vi, beforeEach } from "vitest";
import { runCustomerPersonAdd, runCustomerPersonRemove, runCustomerPersonList } from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runCustomerPersonAdd", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("POSTs /api/asiakas/person/add with body and reason header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runCustomerPersonAdd(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test add" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/person/add",
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "test add" } }
    );
  });

  test("forwards --dry-run header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: true });
    await runCustomerPersonAdd(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test", dryRun: true }
    );
    const call = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2].headers["X-Dry-Run"]).toBe("1");
  });
});

describe("runCustomerPersonRemove", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("POSTs /api/asiakas/person/remove with body and reason header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runCustomerPersonRemove(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test remove" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/person/remove",
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "test remove" } }
    );
  });
});

describe("runCustomerPersonList", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("GETs /api/asiakas/person/list/<asiakasId>/0 when no role filter", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personId: 5351, personFirstName: "Juha", personLastName: "Urho", personEmail: "j@example.com" },
    ]);
    const result = await runCustomerPersonList(mockClient, 26);
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakas/person/list/26/0");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ personId: 5351, name: "Juha Urho" });
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(1);
  });

  test("GETs with role typeId in URL when --role given", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runCustomerPersonList(mockClient, 26, "keikkaHandler");
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakas/person/list/26/11");
  });

  test("throws on unknown role", async () => {
    await expect(runCustomerPersonList(mockClient, 26, "notArole")).rejects.toThrow(/unknown role/i);
  });
});
