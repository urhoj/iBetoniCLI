import { describe, test, expect, afterEach } from "vitest";
import {
  commandPathOf,
  setAmbientCommandPath,
  getAmbientCommandPath,
} from "../src/commandContext.js";

type Node = { name(): string; parent: Node | null };
const node = (name: string, parent: Node | null = null): Node => ({ name: () => name, parent });

afterEach(() => setAmbientCommandPath(null));

describe("commandPathOf", () => {
  test("walks the Commander chain excluding the root program", () => {
    const root = node("ib");
    const get = node("get", node("feedback", node("dev", root)));
    expect(commandPathOf(get)).toBe("dev feedback get");
  });

  test("single-level command", () => {
    expect(commandPathOf(node("doctor", node("ib")))).toBe("doctor");
  });

  test("null-safe: no command -> empty string", () => {
    expect(commandPathOf(null)).toBe("");
    expect(commandPathOf(undefined)).toBe("");
  });
});

describe("ambient holder", () => {
  test("set/get roundtrip; empty string clears to null; default null", () => {
    expect(getAmbientCommandPath()).toBeNull();
    setAmbientCommandPath("keikka list");
    expect(getAmbientCommandPath()).toBe("keikka list");
    setAmbientCommandPath("");
    expect(getAmbientCommandPath()).toBeNull();
  });
});
