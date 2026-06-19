import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  parseJsonObject,
  resolvePersonRef,
  runNotificationFcmSend,
} from "../../src/commands/notification/index.js";
import type { ApiClient } from "../../src/api/client.js";

const c = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const post = () => c.post as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("parseJsonObject", () => {
  test("parses a JSON object", () => {
    expect(parseJsonObject('{"url":"/grid"}')).toEqual({ url: "/grid" });
  });
  test("rejects invalid JSON with exit 4", () => {
    expect(() => parseJsonObject("{nope")).toThrow();
    try {
      parseJsonObject("{nope");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
    }
  });
  test("rejects a JSON array", () => {
    expect(() => parseJsonObject("[1,2]")).toThrow(/object/);
  });
  test("rejects a scalar", () => {
    expect(() => parseJsonObject('"hi"')).toThrow(/object/);
  });
});

describe("resolvePersonRef", () => {
  test("passes a numeric id straight through (no search call)", async () => {
    expect(await resolvePersonRef(c, "6233")).toBe(6233);
    expect(c.post).not.toHaveBeenCalled();
  });

  test("resolves a unique name via company-scoped person search", async () => {
    post().mockResolvedValueOnce([
      { personId: 6233, personFirstName: "Juha", personLastName: "Urho" },
    ]);
    expect(await resolvePersonRef(c, "Juha Urho")).toBe(6233);
    expect(c.post).toHaveBeenCalledWith(
      "/api/person/search",
      { searchString: "Juha Urho" },
      { read: true }
    );
  });

  test("zero matches → exit 5", async () => {
    post().mockResolvedValueOnce([]);
    await expect(resolvePersonRef(c, "Nobody")).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  test("ambiguous match → exit 4", async () => {
    post().mockResolvedValueOnce([
      { personId: 1, personFirstName: "Juha", personLastName: "Urho" },
      { personId: 2, personFirstName: "Juha", personLastName: "Urhonen" },
    ]);
    await expect(resolvePersonRef(c, "Juha")).rejects.toMatchObject({
      exitCode: 4,
    });
  });
});

describe("runNotificationFcmSend", () => {
  test("posts to the cli notification route with write headers (numeric person)", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runNotificationFcmSend(
      c,
      { person: "6233", title: "T", body: "B" },
      { reason: "test" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/notification/fcm/send",
      { title: "T", body: "B", personId: 6233 },
      { headers: { "X-Action-Reason": "test" } }
    );
  });

  test("resolves a name, then sends, and includes --data on dry-run", async () => {
    post()
      .mockResolvedValueOnce([
        { personId: 6233, personFirstName: "Juha", personLastName: "Urho" },
      ]) // search
      .mockResolvedValueOnce({ dryRun: true }); // send
    await runNotificationFcmSend(
      c,
      { person: "Juha Urho", title: "T", body: "B", data: { url: "/grid" } },
      { dryRun: true }
    );
    expect(c.post).toHaveBeenLastCalledWith(
      "/api/cli/notification/fcm/send",
      { title: "T", body: "B", personId: 6233, data: { url: "/grid" } },
      { headers: { "X-Dry-Run": "1" } }
    );
  });
});
