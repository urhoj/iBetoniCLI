import { describe, test, expect } from "vitest";
import { renderWhoami } from "../../src/auth/whoami.js";

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
});
