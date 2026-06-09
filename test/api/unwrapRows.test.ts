import { describe, test, expect } from "vitest";
import { unwrapRows } from "../../src/api/envelopes.js";

describe("unwrapRows", () => {
  test("passes a bare array through", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    expect(unwrapRows(rows)).toEqual(rows);
  });
  test("unwraps an mssql { recordset } result", () => {
    expect(unwrapRows({ recordset: [{ id: 7 }] })).toEqual([{ id: 7 }]);
  });
  test("unwraps a nested { recordsets: [[...]] } result", () => {
    expect(unwrapRows({ recordsets: [[{ id: 9 }]] })).toEqual([{ id: 9 }]);
  });
  test("empty recordset → []", () => {
    expect(unwrapRows({ recordsets: [[]], recordset: [] })).toEqual([]);
  });
  test("null / unrecognised shape → []", () => {
    expect(unwrapRows(null)).toEqual([]);
    expect(unwrapRows({ output: {}, returnValue: 0 })).toEqual([]);
  });
});
