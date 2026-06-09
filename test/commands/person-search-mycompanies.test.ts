import { describe, test, expect, vi } from "vitest";
import { runPersonSearchMyCompanies } from "../../src/commands/person/index.js";

describe("runPersonSearchMyCompanies", () => {
  test("searches every company and tags each hit with its company (authoritative)", async () => {
    const listCompanies = vi.fn().mockResolvedValue([
      { asiakasId: 8, name: "Kalle Urho Oy" },
      { asiakasId: 26, name: "PumiNet Oy" },
    ]);
    const searchIn = vi.fn(async (asiakasId: number) =>
      asiakasId === 8
        ? {
            items: [
              {
                personId: 100,
                name: "Mikko Ikonen",
                email: "mikko@x.fi",
                phone: "040",
                asiakasId: 8,
              },
            ],
            nextCursor: null,
            count: 1,
          }
        : { items: [], nextCursor: null, count: 0 }
    );

    const res = await runPersonSearchMyCompanies(listCompanies, searchIn);

    expect(searchIn).toHaveBeenCalledWith(8);
    expect(searchIn).toHaveBeenCalledWith(26);
    expect(res.count).toBe(1);
    expect(res.items[0]).toEqual({
      personId: 100,
      name: "Mikko Ikonen",
      email: "mikko@x.fi",
      phone: "040",
      asiakasId: 8,
      asiakasName: "Kalle Urho Oy",
    });
  });

  test("merges hits across companies and overrides asiakasId/name from the company", async () => {
    const listCompanies = vi.fn().mockResolvedValue([
      { asiakasId: 8, name: "A" },
      { asiakasId: 26, name: "B" },
    ]);
    const searchIn = vi.fn(async (asiakasId: number) => ({
      items: [
        {
          personId: asiakasId * 10,
          name: "X Y",
          email: null,
          phone: null,
          asiakasId: 999,
        },
      ],
      nextCursor: null,
      count: 1,
    }));

    const res = await runPersonSearchMyCompanies(listCompanies, searchIn);

    expect(res.count).toBe(2);
    expect(res.items.map((i) => i.asiakasId)).toEqual([8, 26]);
    expect(res.items.map((i) => i.asiakasName)).toEqual(["A", "B"]);
    expect(res.nextCursor).toBeNull();
  });
});
