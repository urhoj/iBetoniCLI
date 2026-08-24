import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../src/program.js";
import {
  DOMAIN_REGISTRARS,
  STATIC_DOMAIN_TOKENS,
  resolveArgvDomain,
} from "../src/domains.js";

const names = (cmd: Command): string[] => cmd.commands.map((c) => c.name()).sort();

/** Full path → Command over a whole tree, so two builds can be compared. */
function paths(root: Command): Set<string> {
  const out = new Set<string>();
  const walk = (cmd: Command, prefix: string[]): void => {
    const full = [...prefix, cmd.name()].join(" ");
    out.add(full);
    for (const sub of cmd.commands) walk(sub, [...prefix, cmd.name()]);
  };
  walk(root, []);
  return out;
}

const full = await buildProgram();

describe("selective domain registration", () => {
  test("every root subcommand is reachable by its own token", () => {
    // A domain missing from the table would still appear in the full build (so
    // `ib --help` looks fine) but `ib <domain> …` would take the unknown-token
    // fallback — silently paying for the full load it is meant to avoid.
    const unmapped = names(full).filter(
      (n) => !DOMAIN_REGISTRARS.has(n) && !STATIC_DOMAIN_TOKENS.has(n)
    );
    expect(unmapped).toEqual([]);
  });

  test("the table registers no token the full build lacks", () => {
    const rooted = new Set(names(full));
    const dangling = [...DOMAIN_REGISTRARS.keys()].filter((k) => !rooted.has(k));
    expect(dangling).toEqual([]);
  });

  test("a selected domain's subtree is identical to its subtree in the full build", async () => {
    const fullPaths = paths(full);
    for (const token of DOMAIN_REGISTRARS.keys()) {
      const lean = await buildProgram([token]);
      const leanPaths = [...paths(lean)].filter((p) => p.startsWith(`ib ${token}`));
      expect(leanPaths.length, `${token} registered nothing`).toBeGreaterThan(0);
      for (const p of leanPaths) expect(fullPaths.has(p), `${p} missing from full build`).toBe(true);
      const expected = [...fullPaths].filter((p) => p.startsWith(`ib ${token}`));
      expect(leanPaths.sort()).toEqual(expected.sort());
    }
  });

  test("a selected domain loads only that domain (plus the always-static ones)", async () => {
    const lean = await buildProgram(["keikka", "list"]);
    expect(names(lean)).toEqual(["commands", "keikka", "reference"]);
  });

  test("the static root commands select no domain at all", async () => {
    for (const token of STATIC_DOMAIN_TOKENS) {
      expect(names(await buildProgram([token]))).toEqual(["commands", "reference"]);
    }
  });
});

describe("resolveArgvDomain", () => {
  test("plain command token", () => {
    expect(resolveArgvDomain(["keikka", "list"])).toBe("keikka");
    expect(resolveArgvDomain(["commands"])).toBe("commands");
  });

  test("value-taking globals swallow their value; booleans do not", () => {
    expect(resolveArgvDomain(["--endpoint", "http://x", "keikka"])).toBe("keikka");
    expect(resolveArgvDomain(["--company", "5", "keikka"])).toBe("keikka");
    expect(resolveArgvDomain(["--request-id", "abc", "keikka"])).toBe("keikka");
    expect(resolveArgvDomain(["--pretty", "--verbose", "--stats", "keikka"])).toBe("keikka");
    // `--flag=value` keeps the value in the same token
    expect(resolveArgvDomain(["--endpoint=http://x", "keikka"])).toBe("keikka");
  });

  test("a global's VALUE is never mistaken for the command", () => {
    // `ib --endpoint keikka` is malformed; it must not select the keikka domain.
    expect(resolveArgvDomain(["--endpoint", "keikka"])).toBeNull();
  });

  test("falls back to the full tree when the tree is what renders the answer", () => {
    expect(resolveArgvDomain(undefined)).toBeNull(); // library/test callers
    expect(resolveArgvDomain([])).toBeNull(); // bare `ib` → root help
    expect(resolveArgvDomain(["--help"])).toBeNull();
    expect(resolveArgvDomain(["nosuchcmd"])).toBeNull(); // unknown-command siblings
    expect(resolveArgvDomain(["--pretty", "nosuchcmd"])).toBeNull();
    expect(resolveArgvDomain(["--"])).toBeNull();
    expect(resolveArgvDomain(["-"])).toBeNull();
  });

  test("hidden top-level aliases select selectively", () => {
    expect(resolveArgvDomain(["feedback", "list"])).toBe("feedback");
    expect(resolveArgvDomain(["weather", "forecast"])).toBe("weather");
    expect(resolveArgvDomain(["dev", "feedback", "list"])).toBe("dev");
  });

  test("plural root aliases resolve to their canonical domain (fb#740)", async () => {
    // The plural selects the SAME domain token, so the selective build loads
    // only the canonical module...
    expect(resolveArgvDomain(["vehicles", "list"])).toBe("vehicle");
    // ...and Commander's `.aliases()` dispatches the spelled-plural argv to it.
    const lean = await buildProgram(["vehicles", "list"]);
    expect(names(lean)).toEqual(["commands", "reference", "vehicle"]);
    const vehicle = lean.commands.find((c) => c.name() === "vehicle");
    expect(vehicle?.aliases()).toContain("vehicles");
  });
});
