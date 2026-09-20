/**
 * fb#1443: `ib auth logout` revokes a refresh token SERVER-SIDE before it
 * touches the local credentials file — unlike every other write command, it
 * carried no --dry-run. Driven through the real command tree (like
 * auth-switch.test.ts) with the credentials store and the revoke call mocked,
 * so the test never touches the real filesystem or network.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProgram, enableParserThrow, handleParseRejection } from "../../src/program.js";

const performLogout = vi.fn(async (_opts: unknown) => {});

vi.mock("../../src/auth/logout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auth/logout.js")>()),
  performLogout: (opts: unknown) => performLogout(opts),
}));

const PROFILE = {
  jwt: "j",
  refreshToken: "r",
  issuedAt: new Date().toISOString(),
  endpoint: "https://api.ibetoni.fi",
};

vi.mock("../../src/auth/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/store.js")>();
  return {
    ...actual,
    createStore: () =>
      ({
        load: async () => PROFILE,
        loadFor: async () => PROFILE,
      }) as never,
  };
});

async function parse(argv: string[]) {
  const program = await buildProgram(argv);
  const hooks = enableParserThrow(program);
  await program.parseAsync(["node", "ib", ...argv]).catch((err) => handleParseRejection(err, hooks));
}

describe("ib auth logout --dry-run (fb#1443)", () => {
  let out: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    performLogout.mockClear();
    out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => out.mockRestore());

  const printed = () => out.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  test("--dry-run previews without revoking or touching the credentials file", async () => {
    await parse(["auth", "logout", "--dry-run"]);
    expect(performLogout).not.toHaveBeenCalled();
    expect(printed()).toContain('"dryRun":true');
    expect(printed()).toContain('"wouldRevoke":true');
    expect(printed()).toContain(PROFILE.endpoint);
  });

  test("without --dry-run the real revoke still runs (no regression)", async () => {
    await parse(["auth", "logout"]);
    expect(performLogout).toHaveBeenCalledTimes(1);
  });
});
