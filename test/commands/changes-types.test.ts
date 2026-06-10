import { describe, test, expect } from "vitest";
import {
  CHANGE_ENTITY_TYPES,
  isKnownEntityType,
  runChangesTypes,
} from "../../src/commands/changes/entityTypes.js";

describe("changes entityType catalog", () => {
  test("contains all live entityTypes plus pumppuRequest and retired kuski", () => {
    const names = CHANGE_ENTITY_TYPES.map((e) => e.entityType);
    expect(names).toEqual([
      "asiakas",
      "dayDriver",
      "keikka",
      "keikkaBetoni",
      "kuski",
      "palkki",
      "person",
      "personAvailability",
      "pumppuRequest",
      "sijainti",
      "tuote",
      "tyomaa",
      "vehicle",
    ]);
  });

  test("personAvailability is the only admin-gated type", () => {
    const adminGated = CHANGE_ENTITY_TYPES.filter((e) => e.gate === "admin");
    expect(adminGated.map((e) => e.entityType)).toEqual(["personAvailability"]);
  });

  test("kuski is marked deprecated", () => {
    expect(CHANGE_ENTITY_TYPES.find((e) => e.entityType === "kuski")?.deprecated).toBe(true);
  });

  test("isKnownEntityType accepts catalog members, rejects others", () => {
    expect(isKnownEntityType("keikka")).toBe(true);
    expect(isKnownEntityType("kuski")).toBe(true);
    expect(isKnownEntityType("banana")).toBe(false);
  });

  test("runChangesTypes returns a ListEnvelope of the catalog", () => {
    const result = runChangesTypes();
    expect(result.count).toBe(CHANGE_ENTITY_TYPES.length);
    expect(result.items[0]).toHaveProperty("entityType");
    expect(result.items[0]).toHaveProperty("entityIdMeaning");
    expect(result.items[0]).toHaveProperty("gate");
    expect(result.items[0]).toHaveProperty("notes");
    expect(result.nextCursor).toBeNull();
  });
});
