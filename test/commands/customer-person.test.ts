import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runCustomerPersonAdd, runCustomerPersonRemove, runCustomerPersonList } from "../../src/commands/customer/index.js";

const mockClient = mockApiClient();

describe("runCustomerPersonAdd", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("POSTs /api/asiakas/person/add and projects raw result to { added }", async () => {
    // Backend returns the raw mssql result on a real write (feedback #16).
    mockClient.post.mockResolvedValueOnce({
      recordsets: [],
      output: {},
      rowsAffected: [1],
      returnValue: 0,
    });
    const out = await runCustomerPersonAdd(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test add" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/person/add",
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "test add" } }
    );
    expect(out).toEqual({ added: { asiakasId: 26, personId: 5351 } });
  });

  test("forwards --dry-run header and passes the dry-run preview through", async () => {
    mockClient.post.mockResolvedValueOnce({
      dryRun: true,
      wouldCreate: { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
    });
    const out = await runCustomerPersonAdd(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test", dryRun: true }
    );
    const call = mockClient.post.mock.calls[0];
    expect(call[2].headers["X-Dry-Run"]).toBe("1");
    expect(out).toEqual({
      dryRun: true,
      wouldCreate: { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
    });
  });
});

describe("runCustomerPersonRemove", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("POSTs /api/asiakas/person/remove with body and reason header", async () => {
    mockClient.post.mockResolvedValueOnce({ ok: true });
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
    mockClient.get.mockReset();
  });

  test("GETs /api/asiakas/person/list/<asiakasId>/0 when no role filter; roleTypeId null", async () => {
    mockClient.get.mockResolvedValueOnce([
      { personId: 5351, personFirstName: "Juha", personLastName: "Urho", personEmail: "j@example.com" },
    ]);
    const result = await runCustomerPersonList(mockClient, 26);
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakas/person/list/26/0");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ personId: 5351, name: "Juha Urho", roleTypeId: null });
    expect(result.items[0].permissionRoles).toBeUndefined();
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(1);
  });

  test("GETs with role typeId in URL when --role given", async () => {
    mockClient.get.mockResolvedValueOnce([]);
    await runCustomerPersonList(mockClient, 26, "keikkaHandler");
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakas/person/list/26/11");
  });

  test("throws on unknown role", async () => {
    await expect(runCustomerPersonList(mockClient, 26, "notArole")).rejects.toThrow(/unknown role/i);
  });

  test("--include-roles fans out per person and resolves permissionRoles (unnamed typeIds dropped)", async () => {
    const get = mockClient.get;
    // 1st GET = the person list; 2nd GET = that person's asiakasPersonSettings.
    get
      .mockResolvedValueOnce([
        { personId: 63, personFirstName: "Sami", personLastName: "Urho", personEmail: "sami@example.com" },
      ])
      .mockResolvedValueOnce([
        { asiakasPersonSettingId: 10, asiakasPersonSettingTypeId: 2 }, // asiakasAdmin
        { asiakasPersonSettingId: 14, asiakasPersonSettingTypeId: 9 }, // tyosuhteessa
        { asiakasPersonSettingId: 18, asiakasPersonSettingTypeId: 3 }, // unnamed → dropped
      ]);
    const result = await runCustomerPersonList(mockClient, 27, undefined, true);
    expect(get).toHaveBeenNthCalledWith(1, "/api/asiakas/person/list/27/0");
    expect(get).toHaveBeenNthCalledWith(2, "/api/asiakasPersonSettings/get/27/63");
    expect(result.items[0].permissionRoles).toEqual(["asiakasAdmin", "tyosuhteessa"]);
  });
});
