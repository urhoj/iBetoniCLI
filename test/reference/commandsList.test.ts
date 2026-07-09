import { describe, test, expect } from "vitest";
import {
  filterCommandSpecs,
  buildCommandsList,
  buildDomainIndex,
  commandDomains,
  assertKnownDomain,
  fullyHiddenDomains,
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

  test("nested dev subgroup token resolves to its canonical command list", () => {
    const env = buildCommandsList({ domain: "changelog" }, "developer");
    const commands = env.items.map((i) => i.command);
    expect(commands).toContain("ib dev changelog add");
    expect(commands).toContain("ib dev changelog list");
    expect(commands.every((c) => c.startsWith("ib dev changelog "))).toBe(true);
  });

  test("nested subgroup token composes with read/write filters", () => {
    const writes = buildCommandsList({ domain: "changelog", mutations: true }, "developer");
    expect(writes.count).toBeGreaterThan(0);
    expect(writes.items.every((i) => i.isWrite)).toBe(true);
    expect(writes.items.map((i) => i.command)).toContain("ib dev changelog add");

    const reads = buildCommandsList({ domain: "changelog", reads: true }, "developer");
    expect(reads.count).toBeGreaterThan(0);
    expect(reads.items.every((i) => !i.isWrite)).toBe(true);
    expect(reads.items.map((i) => i.command)).toContain("ib dev changelog list");
  });

  test("developer-only nested subgroup token returns an empty list at standard tier", () => {
    const env = buildCommandsList({ domain: "schema" }, "standard");
    expect(env.items).toEqual([]);
    expect(env.count).toBe(0);
  });

  test("schema nested subgroup token resolves at developer tier", () => {
    const env = buildCommandsList({ domain: "schema" }, "developer");
    expect(env.items.map((i) => i.command)).toContain("ib dev schema tables");
    expect(env.items.every((i) => i.command.startsWith("ib dev schema "))).toBe(true);
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
    expect(muts).toContain("ib dev feedback create");
    expect(muts).toContain("ib dev feedback resolve");
    const reads = filterCommandSpecs(COMMAND_SPECS, { reads: true }).map((c) => c.command);
    expect(reads).not.toContain("ib dev feedback create");
    expect(reads).not.toContain("ib dev feedback resolve");
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
    // Explicitly pass "developer" so the invariant doesn't depend on ambient tier state.
    const env = buildDomainIndex(COMMAND_SPECS, "developer");
    expect(env.items.reduce((a, i) => a + i.count, 0)).toBe(COMMAND_SPECS.length);
    const keikka = env.items.find((i) => i.domain === "keikka");
    expect(keikka?.description).toMatch(/delivery/i);
    // a domain with no glossary entry degrades to null, not a crash
    const version = env.items.find((i) => i.domain === "version");
    expect(version).toMatchObject({ count: 1, description: null, commands: ["version"] });
    // pin jerry → BetoniJerry blurb from DOMAIN_BLURBS
    const jerry = env.items.find((i) => i.domain === "jerry");
    expect(jerry?.description).toMatch(/BetoniJerry|request-for-quote/i);
    // regression: "ai" must NOT inherit sijainti's blurb via the "ai" ⊂ "sijainti"
    // substring collision. Blurbs now come directly from DOMAIN_BLURBS (no
    // substring matching). All former standalone ai/schema/changelog/etc. groups
    // are now consolidated under the "dev" domain.
    const dev_domain = env.items.find((i) => i.domain === "dev");
    expect(dev_domain?.description).toMatch(/developer|maintainer/i);
    expect(dev_domain?.description).not.toMatch(/geocoded location/i);
  });
});

describe("tier filtering — flat list", () => {
  test("standard hides developer leaves; developer keeps them", () => {
    // All former standalone ai/schema/etc. groups consolidated under "dev".
    const dev = buildCommandsList({ domain: "dev" }, "developer");
    expect(dev.items.map((i) => i.command)).toContain("ib dev ai conversation");
    const std = buildCommandsList({ domain: "dev" }, "standard");
    // developer-only commands (ai, schema, etc.) are hidden at standard,
    // but standard-visible dev commands (feedback create, cache invalidate) remain.
    expect(std.items.map((i) => i.command)).not.toContain("ib dev ai conversation");
    expect(std.items.map((i) => i.command)).toContain("ib dev feedback create");
  });
  test("feedback create stays visible at standard; triage drops", () => {
    const std = buildCommandsList({ domain: "dev" }, "standard");
    const cmds = std.items.map((i) => i.command);
    expect(cmds).toContain("ib dev feedback create");
    expect(cmds).not.toContain("ib dev feedback list");
  });
  test("default tier is developer (back-compat)", () => {
    const def = buildCommandsList({ domain: "dev" });
    expect(def.count).toBeGreaterThan(0);
  });
});

describe("fullyHiddenDomains", () => {
  test("standard has no fully-hidden domains (all dev-only groups consolidated under 'dev' which has standard-visible leaves)", () => {
    const hidden = fullyHiddenDomains("standard");
    // dev domain has standard-visible specs (feedback create, cache invalidate)
    expect(hidden.has("dev")).toBe(false);
    // old standalone domains no longer exist in COMMAND_SPECS — not present, so not hidden
    expect(hidden.has("ai")).toBe(false);
    expect(hidden.has("schema")).toBe(false);
    expect(hidden.has("changelog")).toBe(false);
    // other visible domains must NOT be fully hidden
    expect(hidden.has("jerry")).toBe(false);
    expect(hidden.has("keikka")).toBe(false);
  });
  test("developer hides nothing", () => {
    expect(fullyHiddenDomains("developer").size).toBe(0);
  });
});

describe("assertKnownDomain tier-filtered error list", () => {
  test("unknown domain error lists only visible domains at standard", () => {
    let msg = "";
    try { assertKnownDomain(COMMAND_SPECS, "bogusxyz", "standard"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("unknown domain: bogusxyz");
    // old standalone domains no longer exist in COMMAND_SPECS → not in error list
    expect(msg).not.toContain("schema");
    expect(msg).not.toContain("changelog");
    expect(msg).toContain("keikka"); // a visible domain is still suggested
  });
  test("a known domain validates without throwing", () => {
    // dev is the new umbrella — it is a known domain and does not throw
    expect(() => assertKnownDomain(COMMAND_SPECS, "dev", "standard")).not.toThrow();
  });
  test("developer error lists all domains incl. dev", () => {
    let msg = "";
    try { assertKnownDomain(COMMAND_SPECS, "bogusxyz", "developer"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("dev");
  });
});

describe("tier filtering — domain index", () => {
  test("standard drops old top-level developer domains; dev umbrella still shows (has standard-visible leaves)", () => {
    const domains = buildDomainIndex(undefined, "standard").items.map(
      (i) => i.domain
    );
    // old standalone domains no longer exist in COMMAND_SPECS
    expect(domains).not.toContain("ai");
    expect(domains).not.toContain("schema");
    expect(domains).not.toContain("changelog");
    // dev appears because it has standard-visible specs (feedback create, cache invalidate)
    expect(domains).toContain("dev");
  });
  test("developer index keeps dev umbrella (containing ai, schema, changelog, etc.)", () => {
    const domains = buildDomainIndex(undefined, "developer").items.map(
      (i) => i.domain
    );
    // consolidated under dev
    expect(domains).toContain("dev");
    expect(domains).not.toContain("ai");
    expect(domains).not.toContain("schema");
  });
  test("standard dev row lists only standard-visible leaves (incl. feedback create, not feedback list)", () => {
    const dev = buildDomainIndex(undefined, "standard").items.find(
      (i) => i.domain === "dev"
    )!;
    expect(dev).toBeDefined();
    expect(dev.commands).toContain("dev feedback create");
    expect(dev.commands).not.toContain("dev feedback list");
    expect(dev.count).toBe(dev.commands.length);
  });
});
