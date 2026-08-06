import { describe, test, expect } from "vitest";
import { bothInOrder } from "../src/parallel.js";

const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const rejectAfter = (ms: number, err: unknown) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(err), ms));

describe("bothInOrder", () => {
  test("resolves both values as a tuple", async () => {
    expect(await bothInOrder(after(2, "a"), after(1, 2))).toEqual(["a", 2]);
  });

  test("runs concurrently (total ≈ the slower one, not the sum)", async () => {
    const started = Date.now();
    await bothInOrder(after(30, 1), after(30, 2));
    expect(Date.now() - started).toBeLessThan(55);
  });

  test("when BOTH reject, the FIRST argument's error wins regardless of timing", async () => {
    // This is the whole point: a bare Promise.all would surface `second` here,
    // changing which message the caller sees versus the sequential original.
    await expect(
      bothInOrder(rejectAfter(20, new Error("first")), rejectAfter(1, new Error("second")))
    ).rejects.toThrow("first");
    // …and the same when the first is also the first to fail.
    await expect(
      bothInOrder(rejectAfter(1, new Error("first")), rejectAfter(20, new Error("second")))
    ).rejects.toThrow("first");
  });

  test("a lone rejection on either side surfaces", async () => {
    await expect(bothInOrder(rejectAfter(1, new Error("boom")), after(1, "ok"))).rejects.toThrow("boom");
    await expect(bothInOrder(after(1, "ok"), rejectAfter(1, new Error("bang")))).rejects.toThrow("bang");
  });

  test("an early rejection is never an unhandled rejection", async () => {
    // The losing rejection must be observed by allSettled — otherwise Node
    // tears the process down. Fail the test if the process sees one.
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        bothInOrder(rejectAfter(15, new Error("slow")), rejectAfter(1, new Error("fast")))
      ).rejects.toThrow("slow");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
