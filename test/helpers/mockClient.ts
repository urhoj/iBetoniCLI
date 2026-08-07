import { vi } from "vitest";
import type { Mock } from "vitest";
import type { ApiClient } from "../../src/api/client.js";

/**
 * Shared ApiClient mock factory.
 *
 * Before this existed, ~70 test files hand-rolled the same
 * `{ get: vi.fn(), post: vi.fn(), … } as unknown as ApiClient` scaffold, so a
 * change to the client's method surface meant ~70 edits and a mock drifting
 * from the real ApiClient shape was invisible. This factory is the single
 * point that mirrors the client shape — add a new client method HERE (type +
 * impl) and every test picks it up. The returned methods are typed as `Mock`,
 * so tests need no `as ReturnType<typeof vi.fn>` casts.
 */
export type MockApiClient = ApiClient & {
  get: Mock;
  post: Mock;
  put: Mock;
  patch: Mock;
  delete: Mock;
  getCurrentToken: Mock;
};

/**
 * Accepted by {@link mockApiClient}; exported for test-local wrapper factories.
 * Values accept both `Mock` (bare `vi.fn()`) and the wider
 * `ReturnType<typeof vi.fn>` (`Mock<Procedure | Constructable>`) that
 * explicitly-annotated test params carry.
 */
export type MockApiClientOverrides = Partial<
  Record<
    "get" | "post" | "put" | "patch" | "delete" | "getCurrentToken",
    Mock | ReturnType<typeof vi.fn>
  >
> & { endpoint?: string };

/**
 * Fresh all-`vi.fn()` ApiClient mock. Pass overrides for methods that need a
 * canned implementation (e.g. `mockApiClient({ getCurrentToken: vi.fn(() => JWT) })`).
 * `endpoint` is deliberately absent unless overridden — matching the historical
 * scaffolds — so endpoint-guard tests must opt in explicitly.
 */
export function mockApiClient(overrides?: MockApiClientOverrides): MockApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
    ...overrides,
  } as unknown as MockApiClient;
}
