import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";

describe("entity log subcommands", () => {
  test("keikka/vehicle/worksite groups expose a log leaf; old names are gone", () => {
    const program = buildProgram();
    const paths: string[] = [];
    const walk = (cmd: Command, path: string[]): void => {
      const full = [...path, cmd.name()].join(" ");
      paths.push(full);
      for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
    };
    walk(program, []);
    expect(paths).toContain("ib keikka log");
    expect(paths).toContain("ib vehicle log");
    expect(paths).toContain("ib worksite log");
    expect(paths).toContain("ib customer log");
    expect(paths).toContain("ib person log");
    expect(paths).toContain("ib log entity");
    expect(paths).not.toContain("ib changes entity");
    expect(paths).not.toContain("ib keikka history");
  });
});
