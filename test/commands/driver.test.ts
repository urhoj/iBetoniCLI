import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runDriverBoard,
  runDriverGaps,
  runDriverAvailable,
  runDriverWho,
  runDriverAbsences,
} from "../../src/commands/driver/index.js";
import type { ApiClient } from "../../src/api/client.js";

const c = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const LIST = { items: [], nextCursor: null, count: 0 };

describe("ib driver reads", () => {
  beforeEach(() => vi.clearAllMocks());

  test("board resolves date alias to yyyymmdd path", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runDriverBoard(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/board/20260610");
  });

  test("gaps hits the gaps path", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runDriverGaps(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/gaps/20260610");
  });

  test("available hits the available path", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runDriverAvailable(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/available/20260610");
  });

  test("who hits /who/:vehicleId/:yyyymmdd", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ vehicleId: 53, date: "2026-06-10", driver: null });
    await runDriverWho(c, 53, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/who/53/20260610");
  });

  test("absences encodes from/to/personId", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runDriverAbsences(c, { from: "2026-06-01", to: "2026-06-30", person: 555 });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/absences?from=2026-06-01&to=2026-06-30&personId=555");
  });

  test("absences omits personId when absent", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runDriverAbsences(c, { from: "2026-06-01", to: "2026-06-30" });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/absences?from=2026-06-01&to=2026-06-30");
  });
});
