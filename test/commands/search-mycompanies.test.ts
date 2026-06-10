import { test, expect, vi, beforeEach } from "vitest";
import { runCustomerSearch } from "../../src/commands/customer/index.js";
import { runWorksiteSearch } from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mock = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;

beforeEach(() => {
  (mock.get as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
  // runWorksiteSearch expects a raw array from the backend (not an envelope)
  (mock.post as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
});

test("runCustomerSearch adds myCompanies=1 when requested", async () => {
  await runCustomerSearch(mock, "x", 5, true);
  const path = (mock.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  expect(path).toContain("myCompanies=1");
});

test("runCustomerSearch omits myCompanies by default", async () => {
  await runCustomerSearch(mock, "x", 5);
  const path = (mock.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  expect(path).not.toContain("myCompanies");
});

test("runWorksiteSearch puts myCompanies in the POST body when requested", async () => {
  await runWorksiteSearch(mock, "x", 5, true);
  const body = (mock.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
  expect(body).toMatchObject({ searchString: "x", myCompanies: true });
});
