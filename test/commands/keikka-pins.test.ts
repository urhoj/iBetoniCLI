import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runKeikkaPins } from "../../src/commands/keikka/index.js";
import { todayHelsinki, addDaysISO } from "../../src/dates.js";

const client = mockApiClient();

describe("ib keikka pins", () => {
  beforeEach(() => client.get.mockReset().mockResolvedValue({ pins: [{ keikkaId: 1 }, { keikkaId: 2 }], truncated: false }));

  test("tenant read hits /api/stat/keikka-pins with the window and echoes count + range", async () => {
    const r = await runKeikkaPins(client, { start: "2026-01-01", end: "2026-10-10" });
    expect(client.get).toHaveBeenCalledWith("/api/stat/keikka-pins?start=2026-01-01&end=2026-10-10");
    expect(r).toMatchObject({ count: 2, truncated: false, range: { start: "2026-01-01", end: "2026-10-10" } });
  });
  test("defaults to the last 365 Helsinki days", async () => {
    const r = await runKeikkaPins(client, {});
    const end = todayHelsinki();
    expect(r.range).toEqual({ start: addDaysISO(end, -365), end });
  });
  test("--person reads the person route with the token's owner", async () => {
    client.getCurrentToken.mockReturnValue(
      "x." + Buffer.from(JSON.stringify({ sub: 10, ownerAsiakasId: 27 })).toString("base64url") + ".y"
    );
    await runKeikkaPins(client, { start: "2026-01-01", end: "2026-10-10", person: 6387 });
    expect(String(client.get.mock.calls[0][0])).toMatch(/^\/api\/user-history\/keikka-pins\/6387\/27\?start=/);
  });
});
