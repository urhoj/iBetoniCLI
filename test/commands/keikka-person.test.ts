import { describe, test, expect, beforeEach } from "vitest";
import { Command } from "commander";
import { mockApiClient } from "../helpers/mockClient.js";
import { captureActionError } from "../helpers/stderr.js";
import {
  runKeikkaPersonList,
  registerKeikkaCommands,
  type KeikkaPersonListItem,
  type KeikkaPersonCollapsedItem,
} from "../../src/commands/keikka/index.js";
import type { ListEnvelope } from "../../src/api/envelopes.js";

const mockClient = mockApiClient();

// The return union is mode-keyed by design (fb#833): list modes yield an
// envelope, --count a { summary }. List-shaped tests narrow through these
// guards (fb#857) — a summary reaching one is a real failure, not a type hole.
type PersonListResult = Awaited<ReturnType<typeof runKeikkaPersonList>>;
function asList(result: PersonListResult): ListEnvelope<KeikkaPersonListItem> {
  if ("summary" in result) throw new Error("expected a list envelope, got a --count summary");
  return result as ListEnvelope<KeikkaPersonListItem>;
}
function asCollapsed(result: PersonListResult): ListEnvelope<KeikkaPersonCollapsedItem> {
  if ("summary" in result) throw new Error("expected a list envelope, got a --count summary");
  return result as ListEnvelope<KeikkaPersonCollapsedItem>;
}

function program() {
  const p = new Command();
  p.exitOverride();
  registerKeikkaCommands(p, async () => mockClient);
  return p;
}

// Two rows for the SAME person (per-source multiplicity — the point of the
// command, fb#833) plus one row for a second person whose source has no text.
const RAW_ROWS = [
  {
    keikkaPersonId: 101,
    personId: 5351,
    personFirstName: "Juha",
    personLastName: "Urho",
    personEmail: "j@example.com",
    personPhone: "0401234567",
    keikkaPersonSourceId: 10,
    keikkaPersonSourceText: "AsiakasPerson",
    contactPersonTypeId: 1,
    entryTime: "2026-08-01T07:00:00.000Z",
    authRead: true,
    authEdit: false,
    authListPersons: false,
    authAddPerson: false,
    authEditPerson: false,
  },
  {
    keikkaPersonId: 102,
    personId: 5351,
    personFirstName: "Juha",
    personLastName: "Urho",
    personEmail: "j@example.com",
    personPhone: "0401234567",
    keikkaPersonSourceId: 30,
    keikkaPersonSourceText: "Manuaalinen",
    contactPersonTypeId: 0,
    entryTime: "2026-08-02T07:00:00.000Z",
    authRead: true,
    authEdit: true,
    authListPersons: false,
    authAddPerson: false,
    authEditPerson: false,
  },
  {
    keikkaPersonId: 103,
    personId: 5352,
    personFirstName: "Matti",
    personLastName: "Meikalainen",
    personEmail: null,
    personPhone: null,
    keikkaPersonSourceId: 0,
    keikkaPersonSourceText: null,
    contactPersonTypeId: 0,
    entryTime: "2026-08-03T07:00:00.000Z",
    authRead: true,
    authEdit: false,
    authListPersons: true,
    authAddPerson: false,
    authEditPerson: false,
  },
];

describe("runKeikkaPersonList", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("GETs /api/cli/keikka/persons/<id> and projects RAW rows (default)", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    const result = asList(await runKeikkaPersonList(mockClient, 9096));
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/keikka/persons/9096");
    expect(result.count).toBe(3);
    expect(result.items[0]).toMatchObject({
      keikkaPersonId: 101,
      personId: 5351,
      name: "Juha Urho",
      email: "j@example.com",
      phone: "0401234567",
      sourceId: 10,
      sourceText: "AsiakasPerson",
      contactType: 1,
      authRead: true,
      authEdit: false,
    });
    // Per-source multiplicity preserved: person 5351 holds TWO rows.
    expect(result.items.filter((i) => i.personId === 5351)).toHaveLength(2);
  });

  test("--source filters rows by keikkaPersonSourceId", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    const result = asList(await runKeikkaPersonList(mockClient, 9096, { source: 30 }));
    expect(result.count).toBe(1);
    expect(result.items[0]).toMatchObject({ keikkaPersonId: 102, sourceId: 30 });
  });

  test("--by-person collapses per person, OR-ing auth and collecting sources", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    const result = asCollapsed(await runKeikkaPersonList(mockClient, 9096, { byPerson: true }));
    expect(result.count).toBe(2);
    const juha = result.items.find((i) => i.personId === 5351);
    expect(juha).toMatchObject({
      name: "Juha Urho",
      rowCount: 2,
      auth: { read: true, edit: true, listPersons: false, addPerson: false, editPerson: false },
    });
    expect(juha?.sources).toEqual([
      { sourceId: 10, sourceText: "AsiakasPerson" },
      { sourceId: 30, sourceText: "Manuaalinen" },
    ]);
    expect(juha?.contactTypes).toEqual([1, 0]);
    const matti = result.items.find((i) => i.personId === 5352);
    expect(matti?.rowCount).toBe(1);
    // authListPersons rides Matti's only row.
    expect(matti?.auth.listPersons).toBe(true);
  });

  test("--count summarizes totals grouped by source", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    const result = await runKeikkaPersonList(mockClient, 9096, { count: true });
    expect(result).toEqual({
      summary: {
        total: 3,
        distinctPersons: 2,
        bySource: [
          { sourceId: 0, sourceText: null, count: 1 },
          { sourceId: 10, sourceText: "AsiakasPerson", count: 1 },
          { sourceId: 30, sourceText: "Manuaalinen", count: 1 },
        ],
      },
    });
  });

  test("--source combines with --count (filtered summary)", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    const result = await runKeikkaPersonList(mockClient, 9096, { source: 10, count: true });
    expect(result).toEqual({
      summary: {
        total: 1,
        distinctPersons: 1,
        bySource: [{ sourceId: 10, sourceText: "AsiakasPerson", count: 1 }],
      },
    });
  });

  test("an empty keikka returns an empty envelope", async () => {
    mockClient.get.mockResolvedValueOnce([]);
    const result = asList(await runKeikkaPersonList(mockClient, 9096));
    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
  });

  test("--by-person and --count together exit 4", async () => {
    const { exitCode, envelope } = await captureActionError(() =>
      program().parseAsync(
        ["keikka", "person", "list", "9096", "--by-person", "--count"],
        { from: "user" }
      )
    );
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/mutually exclusive/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});

describe("ib keikka person list (wiring)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("positional keikkaId reaches the persons route", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    await program().parseAsync(["keikka", "person", "list", "9096"], { from: "user" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/keikka/persons/9096");
  });

  test("--keikka flag is an alias for the positional", async () => {
    mockClient.get.mockResolvedValueOnce(RAW_ROWS);
    await program().parseAsync(["keikka", "person", "list", "--keikka", "9096"], { from: "user" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/keikka/persons/9096");
  });

  test("missing target exits 4 with the dual-target remedy", async () => {
    const { exitCode, envelope } = await captureActionError(() =>
      program().parseAsync(["keikka", "person", "list"], { from: "user" })
    );
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/missing or invalid target/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});
