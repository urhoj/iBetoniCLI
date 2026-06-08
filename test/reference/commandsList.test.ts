import { describe, test, expect } from "vitest";
import {
  filterCommandSpecs,
  buildCommandsList,
} from "../../src/reference/commandsList.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import type { CommandSpec } from "../../src/output/help.js";

const SAMPLE: CommandSpec[] = [
  {
    command: "ib x read",
    description: "a read",
    permissions: ["auth.page.vehicle.read"],
    flags: [],
    outputShape: "{}",
    errors: [],
    examples: [],
  },
  {
    command: "ib x write",
    description: "a write",
    permissions: ["auth.page.vehicle.edit"],
    flags: [],
    writeFlags: true,
    outputShape: "{}",
    errors: [],
    examples: [],
  },
  {
    command: "ib y read",
    description: "another read",
    flags: [],
    outputShape: "{}",
    errors: [],
    examples: [],
  },
];

describe("filterCommandSpecs", () => {
  test("--mutations keeps only commands with writeFlags", () => {
    expect(filterCommandSpecs(SAMPLE, { mutations: true }).map((c) => c.command)).toEqual([
      "ib x write",
    ]);
  });

  test("--reads keeps only commands without writeFlags", () => {
    expect(filterCommandSpecs(SAMPLE, { reads: true }).map((c) => c.command)).toEqual([
      "ib x read",
      "ib y read",
    ]);
  });

  test("--permission matches a case-insensitive substring", () => {
    expect(
      filterCommandSpecs(SAMPLE, { permission: "VEHICLE.EDIT" }).map((c) => c.command)
    ).toEqual(["ib x write"]);
  });

  test("no filters returns every command, mapped to the compact shape", () => {
    const out = filterCommandSpecs(SAMPLE, {});
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      command: "ib x read",
      description: "a read",
      permissions: ["auth.page.vehicle.read"],
      writeFlags: false,
    });
    // permissions defaults to [] when the spec has none
    expect(out[2].permissions).toEqual([]);
  });

  test("--mutations + --reads is a validation error (exit 4)", () => {
    expect(() => filterCommandSpecs(SAMPLE, { mutations: true, reads: true })).toThrow();
    try {
      filterCommandSpecs(SAMPLE, { mutations: true, reads: true });
    } catch (e) {
      expect(e).toMatchObject({ exitCode: 4 });
    }
  });
});

describe("buildCommandsList", () => {
  test("wraps the live COMMAND_SPECS in the list envelope", () => {
    const env = buildCommandsList({});
    expect(env.nextCursor).toBeNull();
    expect(env.count).toBe(env.items.length);
    expect(env.count).toBe(COMMAND_SPECS.length);
  });

  test("--mutations over the real catalogue yields only write commands", () => {
    const env = buildCommandsList({ mutations: true });
    expect(env.count).toBeGreaterThan(0);
    expect(env.items.every((c) => c.writeFlags)).toBe(true);
  });
});
