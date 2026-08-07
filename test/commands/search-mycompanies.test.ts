import { test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runCustomerSearch } from "../../src/commands/customer/index.js";
import { runWorksiteSearch } from "../../src/commands/worksite/index.js";

const mock = mockApiClient();

beforeEach(() => {
  mock.get.mockReset().mockResolvedValue([]);
  // runWorksiteSearch expects a raw array from the backend (not an envelope)
  mock.post.mockReset().mockResolvedValue([]);
});

test("runCustomerSearch adds myCompanies=1 when requested", async () => {
  await runCustomerSearch(mock, "x", 5, true);
  const path = mock.get.mock.calls[0][0] as string;
  expect(path).toContain("myCompanies=1");
});

test("runCustomerSearch omits myCompanies by default", async () => {
  await runCustomerSearch(mock, "x", 5);
  const path = mock.get.mock.calls[0][0] as string;
  expect(path).not.toContain("myCompanies");
});

test("runWorksiteSearch puts myCompanies in the POST body when requested", async () => {
  await runWorksiteSearch(mock, "x", 5, true);
  const body = mock.post.mock.calls[0][1];
  expect(body).toMatchObject({ searchString: "x", myCompanies: true });
});
