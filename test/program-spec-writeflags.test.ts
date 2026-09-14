import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { Command } from "commander";
import { applySpecErrors, buildProgram } from "../src/program.js";
import { COMMAND_SPECS } from "../src/reference/specs.js";
import { writeError } from "../src/output/json.js";
import { CliError } from "../src/api/errors.js";

/** Collect every leaf+group command in the tree as its full path → Command. */
function collectCommands(root: Command): Map<string, Command> {
  const map = new Map<string, Command>();
  const walk = (cmd: Command, path: string[]): void => {
    const full = [...path, cmd.name()].join(" ");
    map.set(full, cmd);
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(root, []);
  return map;
}

const fullProgram = await buildProgram();
const commands = collectCommands(fullProgram);

/** Whether a command path registers a given long flag. */
function hasLongFlag(path: string, long: string): boolean {
  const cmd = commands.get(path);
  expect(cmd, `command not found: ${path}`).toBeDefined();
  return cmd!.options.some((o) => o.long === long);
}

describe("spec writeFlags ↔ registered --idempotency-key (fb#1585)", () => {
  // The exit-7 remedy now offers --idempotency-key iff the active spec declares
  // writeFlags, so that field is the SOLE authority on whether the advice is
  // true. If it can drift from what the command actually registers, the hint
  // starts recommending a rejected flag again — the original bug. Pin both sides.
  test("every spec's writeFlags agrees with the command registering --idempotency-key", () => {
    const drift: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      if (!cmd) continue; // help-wiring.test.ts owns the orphan case
      const registered = cmd.options.some((o) => o.long === "--idempotency-key");
      if (Boolean(spec.writeFlags) !== registered) {
        drift.push(
          `${spec.command}: writeFlags=${spec.writeFlags ?? false} but --idempotency-key registered=${registered}`
        );
      }
    }
    expect(drift).toEqual([]);
  });

  test("`ib dev feedback create` does NOT declare the trio — it is a META request", () => {
    expect(hasLongFlag("ib dev feedback create", "--idempotency-key")).toBe(false);
  });

  test("`ib dev changelog add` DOES declare the trio", () => {
    expect(hasLongFlag("ib dev changelog add", "--idempotency-key")).toBe(true);
  });
});

describe("applySpecErrors seeds the exit-7 replay clause (fb#1585)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const prevFriction = process.env.IB_FRICTION_OFF;

  beforeEach(() => {
    // Keep the assertion off the real friction log — recordFriction is wired into
    // writeError and would otherwise append these deliberate failures to it.
    process.env.IB_FRICTION_OFF = "1";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (prevFriction === undefined) delete process.env.IB_FRICTION_OFF;
    else process.env.IB_FRICTION_OFF = prevFriction;
  });

  /** Run the wiring, then read the hint `writeError` produced. */
  function hintAfter(path: string): string {
    applySpecErrors(commands.get(path)!);
    writeError(new CliError("Network error: fetch failed", 0, null, 7));
    const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
    return String(parsed.hint ?? "");
  }

  test("a write WITHOUT the trio is told to verify-then-re-run, and not to pass the flag", () => {
    const hint = hintAfter("ib dev feedback create");
    expect(hint).not.toMatch(/--idempotency-key/);
    expect(hint).toMatch(/confirm it did not land/);
  });

  test("a write WITH the trio is still offered --idempotency-key", () => {
    expect(hintAfter("ib dev changelog add")).toMatch(/--idempotency-key/);
  });
});
