import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runKeikkaTilat } from "../../src/commands/keikka/index.js";

const mockClient = mockApiClient();

/**
 * Rows as dbo.keikkaTila returns them (GET /api/tila/list is a bare SELECT *),
 * deliberately NOT in orderNumber order: the catalogue's ids grew by accretion,
 * which is the reason the command sorts (fb#1914).
 */
const ROWS = [
  {
    keikkaTilaId: 100,
    keikkaTilaSelite: "Valmis",
    keikkaTilaCategory: "valmis",
    successTilaId: null,
    errorTilaId: null,
    isSelectable: false,
    keikkaTilaSelite2: "Tilaus on valmis",
    orderNumber: 14,
    keikkaTilaSelite3: null,
    iconName: "valmis",
    iconColor: "success",
    mainAction: null,
    mainAdminAction: null,
  },
  {
    keikkaTilaId: 8,
    keikkaTilaSelite: "Peruttu",
    keikkaTilaCategory: "peruttu",
    successTilaId: 0,
    errorTilaId: 0,
    isSelectable: true,
    keikkaTilaSelite2: "Tilaus on peruttu",
    orderNumber: 8,
    keikkaTilaSelite3: "Asiakas on perunut tilauksen",
    iconName: "peruttu",
    iconColor: "error",
    mainAction: "palauta",
    mainAdminAction: "palauta",
  },
  {
    keikkaTilaId: -1,
    keikkaTilaSelite: "Uusi tilaus",
    keikkaTilaCategory: "kesken",
    successTilaId: 0,
    errorTilaId: 0,
    isSelectable: false,
    keikkaTilaSelite2: "Odottaa tilaustietoja",
    orderNumber: -1,
    keikkaTilaSelite3: "Käyttäjä on luonut uuden tilauksen",
    iconName: "luonnos",
    iconColor: "secondary",
    mainAction: "lähetä",
    mainAdminAction: "vastaanota",
  },
];

describe("ib keikka tilat", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("reads the global catalogue and projects the slim shape in lifecycle order", async () => {
    mockClient.get.mockResolvedValueOnce(ROWS);

    const out = await runKeikkaTilat(mockClient);

    expect(mockClient.get).toHaveBeenCalledWith("/api/tila/list");
    expect(out).toEqual({
      items: [
        { tilaId: -1, name: "Uusi tilaus", category: "kesken", selectable: false, orderNumber: -1, icon: "luonnos" },
        { tilaId: 8, name: "Peruttu", category: "peruttu", selectable: true, orderNumber: 8, icon: "peruttu" },
        { tilaId: 100, name: "Valmis", category: "valmis", selectable: false, orderNumber: 14, icon: "valmis" },
      ],
      nextCursor: null,
      count: 3,
    });
  });

  test("--full adds the lifecycle wiring and UI strings", async () => {
    mockClient.get.mockResolvedValueOnce([ROWS[1]]);

    const out = await runKeikkaTilat(mockClient, { full: true });

    expect(out.items[0]).toEqual({
      tilaId: 8,
      name: "Peruttu",
      category: "peruttu",
      selectable: true,
      orderNumber: 8,
      icon: "peruttu",
      subtitle: "Tilaus on peruttu",
      description: "Asiakas on perunut tilauksen",
      successTilaId: 0,
      errorTilaId: 0,
      iconColor: "error",
      mainAction: "palauta",
      mainAdminAction: "palauta",
    });
  });

  test("a missing orderNumber sorts last instead of ahead of everything", async () => {
    // Number(null) is 0, so a naive comparator ranks an unordered row AHEAD of
    // every positively-ordered status — a new catalogue row would silently jump
    // to the front of the lifecycle.
    mockClient.get.mockResolvedValueOnce([
      { ...ROWS[1], keikkaTilaId: 42, orderNumber: null },
      ROWS[1],
    ]);

    const out = await runKeikkaTilat(mockClient);

    expect(out.items.map((r) => r.tilaId)).toEqual([8, 42]);
    expect(out.items[1].orderNumber).toBeNull();
  });
});
