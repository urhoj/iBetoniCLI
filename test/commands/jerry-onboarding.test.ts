import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runJerryOnboardingList,
  runJerryOnboardingAdd,
  runJerryOnboardingSet,
  runJerryOnboardingLog,
  ONBOARDING_EVENT_TYPES,
  ONBOARDING_EVENT_TYPES_ALL,
} from "../../src/commands/jerry/index.js";
import { assertEnum } from "../../src/targets.js";

const mockClient = mockApiClient();

const g = mockClient.get;
const p = mockClient.post;
const u = mockClient.put;

describe("jerry admin onboarding", () => {
  beforeEach(() => { g.mockReset(); p.mockReset(); u.mockReset(); });

  test("list GETs /api/admin/jerry-onboarding with filters and envelopes the array", async () => {
    g.mockResolvedValueOnce([{ asiakasId: 1389, muistutusDue: true }, { asiakasId: 65, muistutusDue: false }]);
    const env = await runJerryOnboardingList(mockClient, { status: "email1_lahetetty", tier: 2 });
    expect(g).toHaveBeenCalledWith("/api/admin/jerry-onboarding?status=email1_lahetetty&tier=2");
    expect(env.count).toBe(2);
  });

  test("list --due filters client-side on muistutusDue", async () => {
    g.mockResolvedValueOnce([{ asiakasId: 1389, muistutusDue: true }, { asiakasId: 65, muistutusDue: false }]);
    const env = await runJerryOnboardingList(mockClient, { due: true });
    expect(env.items).toEqual([{ asiakasId: 1389, muistutusDue: true }]);
    expect(env.count).toBe(1);
  });

  test("list --search matches company name / contact fields case-insensitively", async () => {
    g.mockResolvedValueOnce([
      { asiakasId: 1, asiakasNimi: "Transsinkko Oy", muistutusDue: false },
      { asiakasId: 2, asiakasNimi: "Betoni Ab", contactPersonEmail: "info@transsinkko.fi", muistutusDue: false },
      { asiakasId: 3, asiakasNimi: "Muu Oy", muistutusDue: false },
    ]);
    const env = await runJerryOnboardingList(mockClient, { search: "TRANSSINKKO" });
    expect(env.items.map((r) => r.asiakasId)).toEqual([1, 2]);
    expect(env.count).toBe(2);
  });

  test("list --search composes with --due", async () => {
    g.mockResolvedValueOnce([
      { asiakasId: 1, asiakasNimi: "Transsinkko Oy", muistutusDue: true },
      { asiakasId: 2, asiakasNimi: "Transsinkko Ab", muistutusDue: false },
    ]);
    const env = await runJerryOnboardingList(mockClient, { search: "transsinkko", due: true });
    expect(env.items.map((r) => r.asiakasId)).toEqual([1]);
    expect(env.count).toBe(1);
  });

  test("add POSTs body + write-flag headers", async () => {
    p.mockResolvedValueOnce({ jerryOnboardingId: 7 });
    await runJerryOnboardingAdd(mockClient, 65, { tier: 1, alue: "Oulu", source: "scheduled" },
      { reason: "uusi yritys", dryRun: true });
    expect(p).toHaveBeenCalledWith(
      "/api/admin/jerry-onboarding",
      { asiakasId: 65, tier: 1, alue: "Oulu", source: "scheduled" },
      { headers: expect.objectContaining({ "X-Action-Reason": "uusi yritys", "X-Dry-Run": "1" }) }
    );
  });

  test("set PUTs partial fields", async () => {
    u.mockResolvedValueOnce({ success: true });
    await runJerryOnboardingSet(mockClient, 65, { status: "vastasi_kylla" }, { reason: "puhelu" });
    expect(u).toHaveBeenCalledWith(
      "/api/admin/jerry-onboarding/65",
      { status: "vastasi_kylla" },
      { headers: expect.objectContaining({ "X-Action-Reason": "puhelu" }) }
    );
  });

  // fb#690. The backend has written self_apply since /apply-jerry shipped, but
  // the READ filter validated --type against a list that omitted it — so the
  // one call that isolates inbound applications exited 4 client-side and never
  // reached the server. The docs half of the drift was the visible symptom.
  test("--type self_apply is accepted by the read filter (fb#690)", () => {
    expect(ONBOARDING_EVENT_TYPES_ALL).toContain("self_apply");
    expect(() => assertEnum("self_apply", ONBOARDING_EVENT_TYPES_ALL, "--type")).not.toThrow();
  });

  // The WRITE half must stay short by three: the backend rejects a caller-sent
  // self_apply/status_change/email_sent with a 400, so widening the read list
  // must not widen `onboarding note`.
  test("the writable event set stays call/response/note only", () => {
    expect([...ONBOARDING_EVENT_TYPES]).toEqual(["call", "response", "note"]);
    expect(() => assertEnum("self_apply", ONBOARDING_EVENT_TYPES, "--type")).toThrow();
  });

  test("log POSTs an event with optional setStatus", async () => {
    p.mockResolvedValueOnce({ jerryOnboardingEventId: 3 });
    await runJerryOnboardingLog(mockClient, 65,
      { eventType: "response", eventText: "kylla, kiinnostaa", setStatus: "vastasi_kylla" }, {});
    expect(p).toHaveBeenCalledWith(
      "/api/admin/jerry-onboarding/65/events",
      { eventType: "response", eventText: "kylla, kiinnostaa", setStatus: "vastasi_kylla" },
      { headers: {} }
    );
  });
});
