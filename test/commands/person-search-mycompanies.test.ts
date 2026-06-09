import { describe, test, expect, vi } from "vitest";
import {
  extractPersonRows,
  runPersonSearchMyCompanies,
} from "../../src/commands/person/index.js";

describe("extractPersonRows", () => {
  test("passes a bare array through", () => {
    const rows = [{ personId: 1 }, { personId: 2 }];
    expect(extractPersonRows(rows)).toEqual(rows);
  });

  test("unwraps an mssql { recordset } result", () => {
    const rows = [{ personId: 7 }];
    expect(extractPersonRows({ recordset: rows })).toEqual(rows);
  });

  test("unwraps a nested { recordsets: [[...]] } result", () => {
    const rows = [{ personId: 9 }];
    expect(extractPersonRows({ recordsets: [rows] })).toEqual(rows);
  });

  test("empty recordset → []", () => {
    expect(extractPersonRows({ recordsets: [[]], recordset: [] })).toEqual([]);
  });

  test("null / unrecognised shape → []", () => {
    expect(extractPersonRows(null)).toEqual([]);
    expect(extractPersonRows({ output: {}, returnValue: 0 })).toEqual([]);
  });
});

describe("runPersonSearchMyCompanies", () => {
  test("searches every company and tags each hit with its company", async () => {
    const listCompanies = vi.fn().mockResolvedValue([
      { asiakasId: 8, name: "Kalle Urho Oy" },
      { asiakasId: 26, name: "PumiNet Oy" },
    ]);
    const searchIn = vi.fn(async (asiakasId: number) => {
      if (asiakasId === 8)
        return {
          recordset: [
            {
              personId: 100,
              personFirstName: "Mikko",
              personLastName: "Ikonen",
              personEmail: "mikko@x.fi",
              personPhone: "040",
            },
          ],
        };
      return { recordset: [] };
    });

    const res = await runPersonSearchMyCompanies(listCompanies, searchIn);

    expect(searchIn).toHaveBeenCalledWith(8);
    expect(searchIn).toHaveBeenCalledWith(26);
    expect(res.count).toBe(1);
    expect(res.items[0]).toEqual({
      personId: 100,
      name: "Mikko Ikonen",
      email: "mikko@x.fi",
      phone: "040",
      asiakasId: 8,
      asiakasName: "Kalle Urho Oy",
    });
  });

  test("merges hits from multiple companies into one flat envelope", async () => {
    const listCompanies = vi.fn().mockResolvedValue([
      { asiakasId: 8, name: "A" },
      { asiakasId: 26, name: "B" },
    ]);
    const searchIn = vi.fn(async (asiakasId: number) => [
      {
        personId: asiakasId * 10,
        personFirstName: "X",
        personLastName: "Y",
        personEmail: null,
        personPhone: null,
      },
    ]);

    const res = await runPersonSearchMyCompanies(listCompanies, searchIn);

    expect(res.count).toBe(2);
    expect(res.items.map((i) => i.asiakasId)).toEqual([8, 26]);
    expect(res.items[0].name).toBe("X Y");
    expect(res.nextCursor).toBeNull();
  });
});
