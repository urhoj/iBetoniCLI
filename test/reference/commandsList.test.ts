import { describe, test, expect } from "vitest";
import {
  filterCommandSpecs,
  buildCommandsList,
  buildDomainIndex,
  commandDomains,
  assertKnownDomain,
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
      isWrite: false,
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
    expect(env.items.every((c) => c.isWrite)).toBe(true);
  });

  test("flat list never carries a hint (the domain index owns discovery)", () => {
    expect(buildCommandsList({}).hint).toBeUndefined();
    expect(buildCommandsList({ domain: "keikka" }).hint).toBeUndefined();
  });
});

describe("commandDomains", () => {
  test("derives the unique, sorted set of tokens after `ib`", () => {
    expect(commandDomains(SAMPLE)).toEqual(["x", "y"]);
  });

  test("real catalogue contains the core domains", () => {
    const domains = commandDomains(COMMAND_SPECS);
    for (const d of ["auth", "keikka", "jerry", "vehicle", "commands"]) {
      expect(domains).toContain(d);
    }
    // sorted + unique
    expect(domains).toEqual([...new Set(domains)].sort());
  });
});

describe("assertKnownDomain", () => {
  test("passes silently for a known domain", () => {
    expect(() => assertKnownDomain(SAMPLE, "x")).not.toThrow();
  });

  test("unknown domain throws exit-4 CliError listing valid domains", () => {
    try {
      assertKnownDomain(SAMPLE, "nope");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toMatchObject({ exitCode: 4 });
      expect((e as Error).message).toContain("unknown domain: nope");
      expect((e as Error).message).toContain("x, y");
    }
  });
});

describe("filterCommandSpecs — domain filter", () => {
  test("domain keeps only that group's commands", () => {
    expect(
      filterCommandSpecs(SAMPLE, { domain: "x" }).map((c) => c.command)
    ).toEqual(["ib x read", "ib x write"]);
  });

  test("domain composes with --mutations", () => {
    expect(
      filterCommandSpecs(SAMPLE, { domain: "x", mutations: true }).map((c) => c.command)
    ).toEqual(["ib x write"]);
  });

  test("unknown domain is a validation error (exit 4)", () => {
    try {
      filterCommandSpecs(SAMPLE, { domain: "zzz" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toMatchObject({ exitCode: 4 });
    }
  });
});

describe("ib commands classification", () => {
  test("auth/company switch are writes (persist a rotated JWT, gated under read-only)", () => {
    const muts = filterCommandSpecs(COMMAND_SPECS, { mutations: true }).map((c) => c.command);
    expect(muts).toContain("ib auth switch");
    expect(muts).toContain("ib company switch");
  });

  test("feedback create/resolve are mutations despite writeFlags:false", () => {
    const muts = filterCommandSpecs(COMMAND_SPECS, { mutations: true }).map((c) => c.command);
    expect(muts).toContain("ib feedback create");
    expect(muts).toContain("ib feedback resolve");
    const reads = filterCommandSpecs(COMMAND_SPECS, { reads: true }).map((c) => c.command);
    expect(reads).not.toContain("ib feedback create");
    expect(reads).not.toContain("ib feedback resolve");
  });
});

describe("buildDomainIndex", () => {
  test("one row per domain: count + runnable leaf paths (relative to `ib`)", () => {
    const env = buildDomainIndex(SAMPLE);
    expect(env.count).toBe(2);
    expect(env.items[0]).toMatchObject({
      domain: "x",
      count: 2,
      commands: ["x read", "x write"],
    });
    expect(env.items[1]).toMatchObject({ domain: "y", count: 1, commands: ["y read"] });
  });

  test("hint advertises the next steps and is the FIRST key", () => {
    const env = buildDomainIndex(SAMPLE);
    expect(env.hint).toContain("ib commands <domain>");
    expect(env.hint).toContain("--all");
    expect(Object.keys(env)[0]).toBe("hint");
  });

  test("real catalogue: every leaf counted once; keikka gets its glossary blurb", () => {
    const env = buildDomainIndex();
    expect(env.items.reduce((a, i) => a + i.count, 0)).toBe(COMMAND_SPECS.length);
    const keikka = env.items.find((i) => i.domain === "keikka");
    expect(keikka?.description).toMatch(/delivery/i);
    // a domain with no glossary entry degrades to null, not a crash
    const version = env.items.find((i) => i.domain === "version");
    expect(version).toMatchObject({ count: 1, description: null, commands: ["version"] });
  });
});
