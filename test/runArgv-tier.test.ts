import { describe, test, expect, beforeEach } from "vitest";
import { runArgv } from "../src/runArgv.js";
import { getCallerTier, setCallerTier } from "../src/tier.js";

// Pin the ambient tier to the module default before each test so the no-leak
// assertion can't be made flaky by state left over from another test file.
beforeEach(() => setCallerTier("developer"));

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("runArgv applies caller tier to discovery", () => {
  test("standard token hides ai domain from `commands`", async () => {
    const res = await runArgv(["commands"], {
      token: jwt({ globalRoles: {} }),
      endpoint: "http://127.0.0.1:1",
    });
    const out = JSON.parse(res.stdout);
    expect(out.items.map((i: { domain: string }) => i.domain)).not.toContain("ai");
  });
  test("developer token shows dev domain (consolidates ai/schema/changelog/etc.)", async () => {
    const res = await runArgv(["commands"], {
      token: jwt({ globalRoles: { isDeveloper: true } }),
      endpoint: "http://127.0.0.1:1",
    });
    const out = JSON.parse(res.stdout);
    expect(out.items.map((i: { domain: string }) => i.domain)).toContain("dev");
  });
  test("runArgv restores the ambient tier afterwards (no leak)", async () => {
    expect(getCallerTier()).toBe("developer"); // module default
    await runArgv(["commands"], {
      token: jwt({ globalRoles: {} }), // standard
      endpoint: "http://127.0.0.1:1",
    });
    expect(getCallerTier()).toBe("developer"); // restored, not left at "standard"
  });
});
