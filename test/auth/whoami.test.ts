import { describe, test, expect } from "vitest";
import { renderWhoami } from "../../src/auth/whoami.js";
import type { CredentialsProfile } from "../../src/auth/store.js";

const base: CredentialsProfile = {
  jwt: "j", refreshToken: "r", issuedAt: "i", expiresAt: "e",
  personId: 6233, ownerAsiakasId: 1349, ownerAsiakasName: "BetoniJerry", endpoint: "https://x",
};

describe("renderWhoami", () => {
  test("formats credentials into stable shape", () => {
    const out = renderWhoami({
      jwt: "...",
      refreshToken: "...",
      issuedAt: "",
      expiresAt: "",
      personId: 42,
      ownerAsiakasId: 1349,
      ownerAsiakasName: "Example Oy",
      endpoint: "https://api.ibetoni.fi",
    });
    expect(out).toEqual({
      personId: 42,
      activeCompany: { asiakasId: 1349, name: "Example Oy" },
      endpoint: "https://api.ibetoni.fi",
    });
  });

  test("omits impersonating for a normal session", () => {
    expect(renderWhoami(base).impersonating).toBeUndefined();
  });
  test("includes impersonating when the profile carries the marker", () => {
    const out = renderWhoami({ ...base, impersonation: { actorPersonId: 10, sessionId: "sid" } });
    expect(out.impersonating).toEqual({ actorPersonId: 10, sessionId: "sid" });
  });
});
