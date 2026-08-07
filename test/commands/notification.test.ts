import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  resolvePersonRef,
  runNotificationFcmSend,
  runNotificationEmailSend,
  resolveEmailHtml,
} from "../../src/commands/notification/index.js";
import { parseJsonBodyFlag } from "../../src/api/parseBody.js";

const c = mockApiClient();

const post = () => c.post;

beforeEach(() => vi.clearAllMocks());

// `--data <json>` is parsed by the shared parseJsonBodyFlag (the local
// parseJsonObject twin is gone); these cover the `--data`-named variant, since
// naming the wrong flag in the error is what a shared parser risks getting wrong.
describe("--data JSON parsing", () => {
  const parseData = (raw: string) => parseJsonBodyFlag(raw, "--data");
  test("parses a JSON object", () => {
    expect(parseData('{"url":"/grid"}')).toEqual({ url: "/grid" });
  });
  test("rejects invalid JSON with exit 4, naming --data", () => {
    expect(() => parseData("{nope")).toThrow(/--data/);
    try {
      parseData("{nope");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
      expect((e as { statusCode: number }).statusCode).toBe(0);
    }
  });
  test("rejects a JSON array", () => {
    expect(() => parseData("[1,2]")).toThrow(/--data must be a JSON object/);
  });
  test("rejects a scalar", () => {
    expect(() => parseData('"hi"')).toThrow(/--data must be a JSON object/);
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

describe("runNotificationEmailSend", () => {
  test("raw email recipient posts {email} with default brand + reason header", async () => {
    post().mockResolvedValueOnce({ sent: true });
    await runNotificationEmailSend(
      c,
      { recipient: "test@srv1.mail-tester.com", subject: "S", text: "B", fromBrand: "betoni" },
      { reason: "spam-test" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/notification/email/send",
      { subject: "S", fromBrand: "betoni", text: "B", email: "test@srv1.mail-tester.com" },
      { headers: { "X-Action-Reason": "spam-test" } }
    );
  });

  test("name recipient resolves then posts {personId}; html + dry-run", async () => {
    post()
      .mockResolvedValueOnce([
        { personId: 6233, personFirstName: "Juha", personLastName: "Urho" },
      ]) // search
      .mockResolvedValueOnce({ sent: true }); // send
    await runNotificationEmailSend(
      c,
      { recipient: "Juha Urho", subject: "S", html: "<p>hi</p>", fromBrand: "betonijerry" },
      { dryRun: true }
    );
    expect(c.post).toHaveBeenLastCalledWith(
      "/api/cli/notification/email/send",
      { subject: "S", fromBrand: "betonijerry", html: "<p>hi</p>", personId: 6233 },
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("numeric recipient passes straight through (no search) and defaults brand", async () => {
    post().mockResolvedValueOnce({ sent: true });
    await runNotificationEmailSend(c, { recipient: "6233", subject: "S", text: "B" }, {});
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/notification/email/send",
      { subject: "S", fromBrand: "betoni", text: "B", personId: 6233 },
      { headers: {} }
    );
  });
});

describe("resolveEmailHtml", () => {
  test("returns inline --html-body verbatim (no file read)", () => {
    expect(resolveEmailHtml({ htmlBody: "<h1>Hi ä ö</h1>" })).toBe("<h1>Hi ä ö</h1>");
  });

  test("returns undefined when neither is given", () => {
    expect(resolveEmailHtml({})).toBeUndefined();
  });

  test("both --html and --html-body → exit 4 (mutually exclusive)", () => {
    try {
      resolveEmailHtml({ html: "./x.html", htmlBody: "<p>y</p>" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
      expect((e as Error).message).toMatch(/mutually exclusive/i);
    }
  });

  test("unreadable --html file → exit 4", () => {
    try {
      resolveEmailHtml({ html: "C:/nope/does-not-exist-xyz.html" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
      expect((e as Error).message).toMatch(/cannot read/i);
    }
  });
});
