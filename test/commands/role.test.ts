import { describe, test, expect, vi } from "vitest";
import { explainRole } from "../../src/roles.js";
import type { ApiClient } from "../../src/api/client.js";

/** Sample GET /api/asiakasPersonSettings/getAllTypes payload (active types only). */
const TYPES = [
  {
    asiakasPersonSettingTypeId: 2,
    asiakasPersonSettingTypeDescription: "isAsiakasAdmin",
    asiakasPersonSettingTypeComment:
      "Täydet hallintaoikeudet: käyttäjien hallinta, asetukset, tilaukset ja kaikki yrityksen tiedot",
  },
  {
    asiakasPersonSettingTypeId: 15,
    asiakasPersonSettingTypeDescription: "Lomaseurannassa",
    asiakasPersonSettingTypeComment:
      "Henkilön lomat ja poissaolot seurataan lomaseurannan kautta",
  },
];

function mockClient(get = vi.fn().mockResolvedValue(TYPES)): {
  client: ApiClient;
  get: ReturnType<typeof vi.fn>;
} {
  const client = {
    get,
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
  return { client, get };
}

describe("explainRole", () => {
  test("asiakasAdmin → typeId 2 + tiers (constants) + DB description/comment", async () => {
    const { client, get } = mockClient();
    const r = await explainRole(client, "asiakasAdmin");
    expect(r).toMatchObject({
      role: "asiakasAdmin",
      typeId: 2,
      displayName: "Asiakas Admin",
      description: "isAsiakasAdmin",
      comment:
        "Täydet hallintaoikeudet: käyttäjien hallinta, asetukset, tilaukset ja kaikki yrityksen tiedot",
      deprecated: false,
    });
    expect(r.tiers).toContain("anyAdmin");
    expect(get).toHaveBeenCalledWith("/api/asiakasPersonSettings/getAllTypes");
  });

  test("lomaseurannassa → typeId 15, not an admin tier", async () => {
    const { client } = mockClient();
    const r = await explainRole(client, "lomaseurannassa");
    expect(r.typeId).toBe(15);
    expect(r.tiers).not.toContain("anyAdmin");
    expect(r.comment).toMatch(/lomaseurannan/);
  });

  test("pumppuHandler → deprecated (typeId 20); description/comment null when endpoint omits it", async () => {
    const { client } = mockClient();
    const r = await explainRole(client, "pumppuHandler");
    expect(r.typeId).toBe(20);
    expect(r.deprecated).toBe(true);
    expect(r.description).toBeNull();
    expect(r.comment).toBeNull();
  });

  test("throws a descriptive error on an unknown role name BEFORE any network call", async () => {
    const { client, get } = mockClient();
    await expect(explainRole(client, "notArole")).rejects.toThrow(/unknown role/i);
    expect(get).not.toHaveBeenCalled();
  });
});
