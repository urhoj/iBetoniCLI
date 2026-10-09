import { describe, test, expect, vi } from "vitest";
import { Command } from "commander";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import { captureActionError } from "../helpers/stderr.js";
import { registerPersonCommands } from "../../src/commands/person/index.js";

/**
 * fb#1735/fb#1511: `person day *` required `--person` while `person role *` and
 * `person activity` took a positional `<personId>`. Every one of them now
 * accepts both spellings (resolvePersonTarget).
 */
const JWT =
  "e30." + Buffer.from(JSON.stringify({ ownerAsiakasId: 1349, personId: 1 })).toString("base64url") + ".sig";

function makeClient(): MockApiClient {
  const c = mockApiClient({ getCurrentToken: vi.fn().mockReturnValue(JWT) });
  c.get.mockResolvedValue([]);
  c.post.mockResolvedValue({ dryRun: true });
  return c;
}

async function parse(c: MockApiClient, args: string[]): Promise<void> {
  const program = new Command("ib").exitOverride();
  registerPersonCommands(program, async () => c, async () => c);
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await program.parseAsync(["node", "ib", "person", ...args]);
  } finally {
    out.mockRestore();
  }
}

const DAY_PATH = "/api/personPvm/list/1349?startDate=2026-06-10&endDate=2026-06-10&personId=555";

describe("person target: positional OR --person (fb#1735)", () => {
  test.each([
    ["day get", ["day", "get", "555", "--from", "2026-06-10"], ["day", "get", "--person", "555", "--from", "2026-06-10"], DAY_PATH],
    ["day clear", ["day", "clear", "555", "--date", "2026-06-10", "--dry-run"], ["day", "clear", "--person", "555", "--date", "2026-06-10", "--dry-run"], DAY_PATH],
    ["role list", ["role", "list", "5351", "--asiakas", "26"], ["role", "list", "--person", "5351", "--asiakas", "26"], "/api/asiakasPersonSettings/get/26/5351"],
    ["activity", ["activity", "63"], ["activity", "--person", "63"], "/api/cli/person/63/activity"],
  ])("%s: both spellings hit the same path", async (_label, positional, flag, path) => {
    for (const args of [positional, flag]) {
      const c = makeClient();
      await parse(c, args);
      expect(c.get).toHaveBeenCalledWith(path);
    }
  });

  test.each([
    ["positional", ["role", "grant", "5351"]],
    ["--person", ["role", "grant", "--person", "5351"]],
  ])("role grant via %s → POSTs for that person", async (_label, args) => {
    const c = makeClient();
    await parse(c, [...args, "--role", "keikkaHandler", "--asiakas", "26", "--dry-run"]);
    expect(c.post.mock.calls[0][0]).toMatch(/^\/api\/asiakasPersonSettings\/add\/26\/5351\//);
  });

  test.each([
    ["neither", ["day", "set", "--date", "2026-06-10", "--status", "2", "--dry-run"], "missing or invalid target"],
    ["both, disagreeing", ["role", "list", "5351", "--person", "6", "--asiakas", "26"], "differ"],
    ["bad positional", ["activity", "abc"], "missing or invalid target"],
  ])("%s → exit 4, no request", async (_label, args, msg) => {
    const c = makeClient();
    const { exitCode, envelope } = await captureActionError(() => parse(c, args));
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toContain(msg);
    expect(c.get).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
  });
});
