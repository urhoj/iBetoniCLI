import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runValidationDismiss,
  runValidationUndismiss,
} from "../../src/commands/keikka/index.js";

// ib keikka validation dismiss|undismiss (fb#2802): the CLI never invents a fingerprint —
// it takes the one `ib keikka validate` (the backend validator) reports for the issue.
const validated = {
  keikkaId: 13053,
  issues: [
    { id: "MISSING_FACTORY", type: "MISSING_FACTORY", message: "Tehdas puuttuu", fingerprint: "Tehdas puuttuu" },
  ],
  dismissed: [
    {
      id: "MISSING_CONTACT_PERSON",
      type: "MISSING_CONTACT_PERSON",
      message: "Yhteyshenkilö puuttuu",
      fingerprint: "Yhteyshenkilö puuttuu",
      stepLogId: 661409,
      personName: "Juha Urho",
      entryTime: "2026-10-23T08:09:00.000Z",
    },
  ],
};

describe("runValidationDismiss", () => {
  test("posts exactly the fingerprint validate reported, with the write-flag headers", async () => {
    const client = mockApiClient({
      get: vi.fn().mockResolvedValue(validated),
      post: vi.fn().mockResolvedValue({ changed: true, stepLogId: 661410 }),
    });
    const out = await runValidationDismiss(
      client,
      { keikkaId: 13053, issueId: "MISSING_FACTORY" },
      { reason: "ei tehdasta", dryRun: true }
    );
    expect(client.get).toHaveBeenCalledWith("/api/cli/keikka/validate/13053");
    expect(client.post).toHaveBeenCalledWith(
      "/api/keikka-validation/dismiss",
      { keikkaId: 13053, issueId: "MISSING_FACTORY", fingerprint: "Tehdas puuttuu", message: "Tehdas puuttuu" },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "ei tehdasta" } }
    );
    expect(out).toEqual({ changed: true, stepLogId: 661410 });
  });

  test("an issue that is not active on the keikka exits 5 without posting", async () => {
    const client = mockApiClient({ get: vi.fn().mockResolvedValue(validated), post: vi.fn() });
    await expect(
      runValidationDismiss(client, { keikkaId: 13053, issueId: "SEVERE_COLD_WARNING" }, {})
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("runValidationUndismiss", () => {
  test("maps the dismissed issue id to its stepLogId", async () => {
    const client = mockApiClient({
      get: vi.fn().mockResolvedValue(validated),
      post: vi.fn().mockResolvedValue({ changed: true }),
    });
    await runValidationUndismiss(client, { keikkaId: 13053, issueId: "MISSING_CONTACT_PERSON" }, {});
    expect(client.post).toHaveBeenCalledWith(
      "/api/keikka-validation/undismiss",
      { keikkaId: 13053, stepLogId: 661409 },
      { headers: {} }
    );
  });

  test("an issue that is not dismissed exits 5 without posting", async () => {
    const client = mockApiClient({ get: vi.fn().mockResolvedValue(validated), post: vi.fn() });
    await expect(
      runValidationUndismiss(client, { keikkaId: 13053, issueId: "MISSING_FACTORY" }, {})
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(client.post).not.toHaveBeenCalled();
  });
});
