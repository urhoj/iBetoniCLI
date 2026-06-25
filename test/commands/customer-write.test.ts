import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runCustomerCreate,
  runCustomerUpdate,
  runCustomerByYtunnus,
  runCustomerUpsert,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const mGet = () => mockClient.get as ReturnType<typeof vi.fn>;
const mPost = () => mockClient.post as ReturnType<typeof vi.fn>;

describe("ib customer create/update", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runCustomerCreate forwards body + all three write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      asiakasId: 9999,
    });
    const body = { asiakasNimi: "Acme Oy", ytunnus: "1234567-8" };
    const result = await runCustomerCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-acme-2026-05-28",
      reason: "imported from external CRM",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/createY",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "create-acme-2026-05-28",
          "X-Action-Reason": "imported from external CRM",
        },
      }
    );
    expect((result as { asiakasId: number }).asiakasId).toBe(9999);
  });

  test("runCustomerUpdate posts to /api/asiakas/set/:asiakasId with body + flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    const body = { asiakasNimi: "Acme Group Oy" };
    await runCustomerUpdate(mockClient, 9999, body, {
      reason: "renamed after acquisition",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/set/9999",
      body,
      {
        headers: { "X-Action-Reason": "renamed after acquisition" },
      }
    );
  });
});

describe("runCustomerByYtunnus", () => {
  beforeEach(() => mGet().mockReset());

  test("GETs the by-ytunnus route and returns items[]", async () => {
    mGet().mockResolvedValueOnce({ items: [{ asiakasId: 1, name: "X" }], count: 1 });
    const r = await runCustomerByYtunnus(mockClient, "1234567-8");
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/by-ytunnus/1234567-8");
    expect(r).toEqual([{ asiakasId: 1, name: "X" }]);
  });
});

describe("runCustomerUpsert", () => {
  beforeEach(() => {
    mGet().mockReset();
    mPost().mockReset();
  });

  test("no match → create (resolves owner, creates, returns action:created)", async () => {
    mGet()
      .mockResolvedValueOnce({ items: [], count: 0 }) // by-ytunnus
      .mockResolvedValueOnce({ currentCompanyId: 8 }) // company-selection/available
      .mockResolvedValueOnce({ asiakasId: 5000, name: "Example Oy" }); // re-fetch
    mPost().mockResolvedValueOnce({ returnValue: 5000 }); // createY

    const res = await runCustomerUpsert(
      mockClient,
      { ytunnus: "1234567-8", name: "Example Oy" },
      { reason: "onboard" }
    );

    expect(res).toMatchObject({ asiakasId: 5000, action: "created" });
    const [path, body] = mPost().mock.calls[0];
    expect(path).toBe("/api/asiakas/createY");
    expect(body).toMatchObject({ ownerAsiakasId: 8, yTunnus: "1234567-8", asiakasNimi: "Example Oy" });
  });

  test("1 match → update (read-merge, returns action:updated)", async () => {
    mGet()
      .mockResolvedValueOnce({
        items: [
          {
            asiakasId: 5000, name: "Old", yTunnus: "1234567-8", type: 1,
            email: null, contactPersonId: 0, shortName: null, comment: null,
          },
        ],
        count: 1,
      }) // by-ytunnus
      .mockResolvedValueOnce({ asiakasId: 5000, name: "New name" }); // re-fetch
    mPost().mockResolvedValueOnce({ success: true }); // set/:id

    const res = await runCustomerUpsert(
      mockClient,
      { ytunnus: "1234567-8", name: "New name" },
      { reason: "rename" }
    );

    expect(res).toMatchObject({ asiakasId: 5000, action: "updated" });
    expect(mPost().mock.calls[0][0]).toBe("/api/asiakas/set/5000");
  });

  test(">1 match → throws ambiguous", async () => {
    mGet().mockResolvedValueOnce({ items: [{ asiakasId: 1 }, { asiakasId: 2 }], count: 2 });
    await expect(
      runCustomerUpsert(mockClient, { ytunnus: "1234567-8" }, { reason: "x" })
    ).rejects.toThrow(/ambiguous/);
  });

  test("no ytunnus key → throws before any lookup", async () => {
    await expect(runCustomerUpsert(mockClient, {}, {})).rejects.toThrow(/requires/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});

describe("runCustomerUpsert reconciles createY-dropped email/comment", () => {
  beforeEach(() => {
    mGet().mockReset();
    mPost().mockReset();
  });

  const flat = {
    asiakasId: 5000, name: "Example Oy", yTunnus: "1234567-8", type: 1,
    address: null, postalCode: null, city: null, email: null, phone: null,
    contactPersonId: 0, shortName: null, comment: null,
  };

  test("create with --email/--comment → follow-up update when createY drops them (pre-059)", async () => {
    mGet()
      .mockResolvedValueOnce({ items: [], count: 0 }) // by-ytunnus
      .mockResolvedValueOnce({ currentCompanyId: 8 }) // company-selection/available
      .mockResolvedValueOnce(flat) // re-fetch after create — email/comment dropped by createY
      .mockResolvedValueOnce({ ...flat, email: "a@b.fi", comment: "vip" }); // re-fetch after reconcile
    mPost()
      .mockResolvedValueOnce({ returnValue: 5000 }) // createY
      .mockResolvedValueOnce({ success: true }); // follow-up set/:id

    const res = await runCustomerUpsert(
      mockClient,
      { ytunnus: "1234567-8", name: "Example Oy", email: "a@b.fi", comment: "vip" },
      { reason: "onboard", idempotencyKey: "k1" }
    );

    expect(res).toMatchObject({ asiakasId: 5000, action: "created", email: "a@b.fi", comment: "vip" });
    // The follow-up update wrote laskutusEmail + kommentti to set/:id…
    expect(mPost().mock.calls[1][0]).toBe("/api/asiakas/set/5000");
    expect(mPost().mock.calls[1][1]).toMatchObject({ laskutusEmail: "a@b.fi", kommentti: "vip" });
    // …and did NOT reuse the create's idempotency key (would look like a dup create).
    expect(mPost().mock.calls[1][2].headers["Idempotency-Key"]).toBeUndefined();
    expect(mPost().mock.calls[1][2].headers["X-Action-Reason"]).toBe("onboard");
  });

  test("create with --email → no follow-up update when createY already persisted it (post-059)", async () => {
    mGet()
      .mockResolvedValueOnce({ items: [], count: 0 }) // by-ytunnus
      .mockResolvedValueOnce({ currentCompanyId: 8 }) // available
      .mockResolvedValueOnce({ ...flat, email: "a@b.fi" }); // re-fetch already shows email
    mPost().mockResolvedValueOnce({ returnValue: 5000 }); // createY only

    const res = await runCustomerUpsert(
      mockClient,
      { ytunnus: "1234567-8", name: "Example Oy", email: "a@b.fi" },
      { reason: "onboard" }
    );

    expect(res).toMatchObject({ asiakasId: 5000, action: "created", email: "a@b.fi" });
    expect(mPost()).toHaveBeenCalledTimes(1); // createY only — read-back matched, no reconcile
  });
});
