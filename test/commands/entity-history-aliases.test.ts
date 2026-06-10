import { describe, test, expect, vi, beforeEach } from "vitest";
import { runChangesEntity } from "../../src/commands/changes/index.js";
import { buildProgram } from "../../src/program.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const get = () => mockClient.get as ReturnType<typeof vi.fn>;

describe("entity history aliases", () => {
  beforeEach(() => get().mockReset());

  test.each([
    ["keikka", 12345, "/api/changes/keikka/12345/27?limit=100"],
    ["vehicle", 53, "/api/changes/vehicle/53/27?limit=100"],
    ["tyomaa", 7, "/api/changes/tyomaa/7/27?limit=100"],
  ])("alias entityType %s hits %s", async (entityType, id, url) => {
    get().mockResolvedValueOnce([]);
    await runChangesEntity(mockClient, entityType as string, id as number, 100, { owner: 27 });
    expect(get()).toHaveBeenCalledWith(url);
  });

  test("keikka/vehicle/worksite groups expose a history leaf", () => {
    const program = buildProgram();
    const paths: string[] = [];
    const walk = (cmd: any, path: string[]): void => {
      const full = [...path, cmd.name()].join(" ");
      paths.push(full);
      for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
    };
    walk(program, []);
    expect(paths).toContain("ib keikka history");
    expect(paths).toContain("ib vehicle history");
    expect(paths).toContain("ib worksite history");
  });
});
