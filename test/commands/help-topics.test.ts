import { describe, test, expect } from "vitest";
import { runHelpList, runHelpTopic } from "../../src/commands/help/index.js";

describe("ib help topics", () => {
  test("list returns topic ids", () => {
    const r = runHelpList();
    expect(r.items.map((t) => t.id)).toContain("roles");
    expect(r.count).toBe(r.items.length);
  });
  test("get returns one topic body", () => {
    const t = runHelpTopic("write-safety");
    expect(t.id).toBe("write-safety");
    expect(t.body.length).toBeGreaterThan(20);
  });
  test("unknown topic throws (mapped to exit 5) and lists glossary terms", () => {
    let caught: unknown;
    try { runHelpTopic("nope"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ exitCode: 5 });
    expect(String((caught as Error).message)).toMatch(/unknown topic/i);
    expect(String((caught as Error).message)).toMatch(/glossary terms/i);
  });
  test("glossary term resolves (ib help tila)", () => {
    const t = runHelpTopic("tila");
    expect(t.title).toMatch(/glossary/i);
    expect(t.body).toMatch(/keikkaTilaId/);
  });
  test("compound glossary term resolves by alias (ib help worksite)", () => {
    const t = runHelpTopic("worksite");
    expect(t.title).toMatch(/glossary/i);
    expect(t.body.length).toBeGreaterThan(10);
  });
});
