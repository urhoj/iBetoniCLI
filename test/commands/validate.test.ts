import { describe, test, expect, vi } from "vitest";
import { Command } from "commander";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runValidateProfiles,
  runValidateCompany,
  runValidatePerson,
  registerValidateCommands,
} from "../../src/commands/validate/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { captureActionError } from "../helpers/stderr.js";

function mockClient(getImpl: (path: string) => unknown): ApiClient {
  return mockApiClient({
    get: vi.fn(async (path: string) => getImpl(path)),
    getCurrentToken: vi.fn(() => "x.y.z"),
  });
}

describe("ib validate handlers", () => {
  test("runValidateProfiles wraps GET /api/validation/profiles in a ListEnvelope", async () => {
    const rows = [{ id: "onboarding", titleFi: "x", description: "y", entity: "person" }];
    const client = mockClient(() => rows);
    const out = await runValidateProfiles(client);
    expect(client.get).toHaveBeenCalledWith("/api/validation/profiles");
    expect(out).toEqual({ items: rows, nextCursor: null, count: 1 });
  });

  test("runValidateCompany GETs /api/validation/:profile/:asiakasId", async () => {
    const result = { entity: "company", profile: "betoni", asiakasId: 8, ok: true };
    const client = mockClient(() => result);
    const out = await runValidateCompany(client, "betoni", 8);
    expect(client.get).toHaveBeenCalledWith("/api/validation/betoni/8");
    expect(out).toEqual(result);
  });

  test("runValidatePerson GETs /api/validation/person/:profile/:asiakasId/:personId", async () => {
    const result = { entity: "person", profile: "onboarding", asiakasId: 8, personId: 10, ok: true };
    const client = mockClient(() => result);
    const out = await runValidatePerson(client, "onboarding", 8, 10);
    expect(client.get).toHaveBeenCalledWith("/api/validation/person/onboarding/8/10");
    expect(out).toEqual(result);
  });

  test("runValidateCompany rejects non-positive asiakasId with exit 4", async () => {
    const client = mockClient(() => ({}));
    await expect(runValidateCompany(client, "betoni", 0)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });

  test("runValidatePerson rejects non-positive ids with exit 4", async () => {
    const client = mockClient(() => ({}));
    await expect(runValidatePerson(client, "onboarding", 8, 0)).rejects.toMatchObject({ exitCode: 4 });
    await expect(runValidatePerson(client, "onboarding", 0, 10)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });
});

// ─── `validate person <id>` / `validate company <id>` positional form (fb#1407) ─

describe("ib validate person|company <id> — positional alias", () => {
  function program(getImpl: (path: string) => unknown) {
    const client = mockClient(getImpl);
    const p = new Command();
    registerValidateCommands(p, async () => client);
    return { p, client };
  }

  test("`validate person <id>` is an alias for --person, combined with --asiakas", async () => {
    const result = { entity: "person", profile: "onboarding", asiakasId: 8, personId: 10, ok: true };
    const { p, client } = program(() => result);
    await p.parseAsync(["validate", "person", "10", "--asiakas", "8", "--profile", "onboarding"], {
      from: "user",
    });
    expect(client.get).toHaveBeenCalledWith("/api/validation/person/onboarding/8/10");
  });

  test("`validate company <id>` is an alias for --asiakas", async () => {
    const result = { entity: "company", profile: "betoni", asiakasId: 8, ok: true };
    const { p, client } = program(() => result);
    await p.parseAsync(["validate", "company", "8", "--profile", "betoni"], { from: "user" });
    expect(client.get).toHaveBeenCalledWith("/api/validation/betoni/8");
  });

  test("`validate person` with no id exits 4, naming the remedy", async () => {
    const { p, client } = program(() => ({}));
    const { exitCode, envelope } = await captureActionError(() =>
      p.parseAsync(["validate", "person", "--profile", "onboarding"], { from: "user" })
    );
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/validate person <id>/);
    expect(client.get).not.toHaveBeenCalled();
  });

  test("`validate person abc` (non-numeric id) exits 4", async () => {
    const { p, client } = program(() => ({}));
    const { exitCode, envelope } = await captureActionError(() =>
      p.parseAsync(["validate", "person", "abc", "--profile", "onboarding"], { from: "user" })
    );
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/invalid personId/);
    expect(client.get).not.toHaveBeenCalled();
  });

  test("an unrecognized action exits 4, naming the valid ones", async () => {
    const { p, client } = program(() => ({}));
    const { exitCode, envelope } = await captureActionError(() =>
      p.parseAsync(["validate", "foo"], { from: "user" })
    );
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/Unknown validate action "foo"/);
    expect(client.get).not.toHaveBeenCalled();
  });

  test("the flag-driven form is unaffected", async () => {
    const result = { entity: "company", profile: "betoni", asiakasId: 8, ok: true };
    const { p, client } = program(() => result);
    await p.parseAsync(["validate", "--asiakas", "8", "--profile", "betoni"], { from: "user" });
    expect(client.get).toHaveBeenCalledWith("/api/validation/betoni/8");
  });

  test("`validate list` still works with the two-positional signature", async () => {
    const rows = [{ id: "onboarding", titleFi: "x", description: "y", entity: "person" }];
    const { p, client } = program(() => rows);
    await p.parseAsync(["validate", "list"], { from: "user" });
    expect(client.get).toHaveBeenCalledWith("/api/validation/profiles");
  });
});
