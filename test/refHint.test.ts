import { describe, test, expect, vi } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import { CliError } from "../src/api/errors.js";
import { siblingRefHint, runWithSiblingHint } from "../src/refHint.js";

/** A minimal ApiClient whose `get` is a controllable vi.fn(). */
const mockClient = (get: ReturnType<typeof vi.fn>): ApiClient =>
  ({ get } as unknown as ApiClient);

const notFound = () => new CliError("Feedback not found", 404, null, 5);

describe("siblingRefHint", () => {
  test("sibling row exists → 'did you mean' hint naming the table + command + id", async () => {
    const get = vi.fn().mockResolvedValue({ changelogId: 858 });
    const hint = await siblingRefHint(mockClient(get), 858, "changelog");
    expect(get).toHaveBeenCalledWith("/api/changelog/858");
    expect(hint).toBe("858 exists in devChangelog — did you mean: ib dev changelog get 858");
  });

  test("probing the feedback table names the feedback command", async () => {
    const get = vi.fn().mockResolvedValue({ feedbackId: 12 });
    expect(await siblingRefHint(mockClient(get), 12, "feedback")).toBe(
      "12 exists in cliFeedback — did you mean: ib dev feedback get 12"
    );
  });

  test("sibling probe error/404 → null (never masks the original failure)", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("nope", 404, null, 5));
    expect(await siblingRefHint(mockClient(get), 858, "changelog")).toBeNull();
  });
});

describe("runWithSiblingHint", () => {
  test("op succeeds → passes the value through, no sibling probe", async () => {
    const get = vi.fn();
    const out = await runWithSiblingHint(mockClient(get), 42, "changelog", async () => ({ ok: 1 }));
    expect(out).toEqual({ ok: 1 });
    expect(get).not.toHaveBeenCalled();
  });

  test("op 404s AND the id exists in the sibling table → error gains the hint, exit code preserved", async () => {
    const get = vi.fn().mockResolvedValue({ changelogId: 858 });
    const err = await runWithSiblingHint(mockClient(get), 858, "changelog", async () => {
      throw notFound();
    }).catch((e) => e as CliError);
    expect(err).toBeInstanceOf(CliError);
    expect(err.statusCode).toBe(404);
    expect(err.exitCode).toBe(5);
    expect(err.hint).toBe("858 exists in devChangelog — did you mean: ib dev changelog get 858");
  });

  test("op 404s but the id is NOT in the sibling table → original error rethrown, no hint", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("nope", 404, null, 5));
    const original = notFound();
    const err = await runWithSiblingHint(mockClient(get), 999, "changelog", async () => {
      throw original;
    }).catch((e) => e as CliError);
    expect(err).toBe(original);
    expect(err.hint).toBeUndefined();
  });

  test("a non-404 error is rethrown untouched, without probing", async () => {
    const get = vi.fn();
    const forbidden = new CliError("denied", 403, null, 3);
    const err = await runWithSiblingHint(mockClient(get), 5, "feedback", async () => {
      throw forbidden;
    }).catch((e) => e as CliError);
    expect(err).toBe(forbidden);
    expect(get).not.toHaveBeenCalled();
  });
});
