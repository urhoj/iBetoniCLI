import { describe, test, expect, vi } from "vitest";
import { runHelpList, runHelpTopic } from "../../src/commands/help/index.js";
import { CliError } from "../../src/api/errors.js";
import type { ApiClient } from "../../src/api/client.js";

function makeClient(
  response: unknown | Error
): () => Promise<ApiClient> {
  const client = {
    get: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
  return () => Promise.resolve(client);
}

describe("ib help topics", () => {
  test("list returns topic ids", () => {
    const r = runHelpList();
    expect(r.items.map((t) => t.id)).toContain("roles");
    expect(r.count).toBe(r.items.length);
  });

  test("known topic returns body without network call", async () => {
    // getClient should never be called for known topics
    const getClient = vi.fn();
    const t = await runHelpTopic("write-safety", getClient as never);
    expect(t.id).toBe("write-safety");
    expect(t.body.length).toBeGreaterThan(20);
    expect(getClient).not.toHaveBeenCalled();
  });

  test("unknown topic falls back to DB glossary lookup (mocked)", async () => {
    const entry = {
      term: "tila",
      synonyms: ["status"],
      definition: "keikkaTilaId — the delivery status.",
      relatedCommands: [],
      relatedEntity: null,
    };
    const getClient = makeClient(entry);
    const t = await runHelpTopic("tila", getClient);
    expect(t.title).toMatch(/glossary/i);
    expect(t.body).toContain("keikkaTilaId");
  });

  test("unknown topic + DB 404 throws exit-5 with topic list hint", async () => {
    const notFound = new CliError("not found", 404, null, 5);
    const getClient = makeClient(notFound);
    let caught: unknown;
    try {
      await runHelpTopic("nope", getClient);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ exitCode: 5 });
    expect(String((caught as Error).message)).toMatch(/unknown topic/i);
    expect(String((caught as Error).message)).toMatch(/ib glossary lookup/i);
  });

  test("unknown topic + auth error re-throws without wrapping", async () => {
    const authErr = new CliError("not logged in", 0, null, 2);
    const getClient = makeClient(authErr);
    let caught: unknown;
    try {
      await runHelpTopic("nope", getClient);
    } catch (e) {
      caught = e;
    }
    expect((caught as CliError).exitCode).toBe(2);
  });
});
