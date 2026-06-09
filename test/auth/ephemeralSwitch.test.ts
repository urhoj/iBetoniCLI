import { describe, test, expect, vi } from "vitest";
import { resolveEphemeralSwitch } from "../../src/cliContext.js";
import { CliError } from "../../src/api/errors.js";

describe("resolveEphemeralSwitch", () => {
  test("no target → returns the base token unchanged, never calls switchFn", async () => {
    const switchFn = vi.fn();
    const r = await resolveEphemeralSwitch({
      baseToken: "base",
      baseOwnerAsiakasId: 8,
      targetAsiakasId: undefined,
      switchFn,
    });
    expect(r).toEqual({ token: "base", ownerAsiakasId: 8, switched: false });
    expect(switchFn).not.toHaveBeenCalled();
  });

  test("target equal to the active company → no switch (avoids a needless round-trip)", async () => {
    const switchFn = vi.fn();
    const r = await resolveEphemeralSwitch({
      baseToken: "base",
      baseOwnerAsiakasId: 8,
      targetAsiakasId: 8,
      switchFn,
    });
    expect(r.switched).toBe(false);
    expect(r.token).toBe("base");
    expect(switchFn).not.toHaveBeenCalled();
  });

  test("different target → mints an ephemeral token via switchFn", async () => {
    const switchFn = vi.fn().mockResolvedValue({
      jwt: "ephemeral",
      ownerAsiakasId: 26,
      ownerAsiakasName: "PumiNet Oy",
    });
    const r = await resolveEphemeralSwitch({
      baseToken: "base",
      baseOwnerAsiakasId: 8,
      targetAsiakasId: 26,
      switchFn,
    });
    expect(switchFn).toHaveBeenCalledExactlyOnceWith(26);
    expect(r).toEqual({
      token: "ephemeral",
      ownerAsiakasId: 26,
      ownerAsiakasName: "PumiNet Oy",
      switched: true,
    });
  });

  test("propagates a switch failure (e.g. no access → CliError exit 3)", async () => {
    const switchFn = vi
      .fn()
      .mockRejectedValue(new CliError("no access", 403, null, 3));
    const err = await resolveEphemeralSwitch({
      baseToken: "base",
      baseOwnerAsiakasId: 8,
      targetAsiakasId: 999,
      switchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
  });
});
