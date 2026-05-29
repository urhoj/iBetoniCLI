import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson, writeError } from "../../output/json.js";

export interface PersonListFilter {
  role?: string;
  asiakas?: number;
  limit?: number;
}

/**
 * GET /api/cli/person/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runPersonList(
  client: ApiClient,
  opts: PersonListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.role) params.set("role", opts.role);
  if (opts.asiakas !== undefined) params.set("asiakas", String(opts.asiakas));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/person/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/person/get/:personId. Returns the flat backend record as-is.
 */
export async function runPersonGet(
  client: ApiClient,
  personId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/person/get/${personId}`
  );
}

/**
 * POST /api/person/search — existing (non-/api/cli/) route used by the FE
 * person typeahead. Body is `{ q: <query> }`. Result shape is whatever the
 * backend returns (typically an array of person records).
 */
export async function runPersonSearch(
  client: ApiClient,
  query: string
): Promise<unknown> {
  return client.post<unknown>("/api/person/search", { q: query });
}

/**
 * Register `ib person` read subcommands on the parent commander instance:
 *   - list    filterable by --role/--asiakas/--limit
 *   - get     single person by personId
 *   - search  free-text search (existing POST /api/person/search route)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerPersonCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const p = parent.command("person").description("Person commands");

  p.command("list")
    .description("List persons")
    .option("--role <role>", "Filter by role name")
    .option("--asiakas <id>", "Filter by asiakasId", (v: string) => Number(v))
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .action(async (opts: PersonListFilter) => {
      try {
        const client = await getClient();
        const result = await runPersonList(client, opts);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  p.command("get <personId>")
    .description("Get a single person by personId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runPersonGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  p.command("search <query>")
    .description("Free-text search for persons")
    .action(async (query: string) => {
      try {
        const client = await getClient();
        const result = await runPersonSearch(client, query);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  addWriteFlagsToCommand(
    p
      .command("create")
      .description("Create a person. Body REQUIRED via --body. Requires --reason.")
      .requiredOption("--body <json>", "Person body (JSON). Must include personFirstName, personLastName, personEmail.")
  ).action(async (opts: WriteFlags & { body: string }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(opts.body);
    } catch {
      writeError(new Error("--body must be valid JSON"));
      process.exit(4);
    }
    for (const required of ["personFirstName", "personLastName", "personEmail"]) {
      if (!(required in body)) {
        writeError(new Error(`Body missing required field: ${required}`));
        process.exit(4);
      }
    }
    try {
      const client = await getClient();
      const result = await runPersonCreate(client, body, opts);
      writeJson(result);
    } catch (e) {
      writeError(e);
      process.exit(1);
    }
  });

  addWriteFlagsToCommand(
    p
      .command("update <personId>")
      .description("Update a person. Body REQUIRED via --body. Requires --reason.")
      .requiredOption("--body <json>", "Patch body (JSON)")
  ).action(async (personIdStr: string, opts: WriteFlags & { body: string }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(opts.body);
    } catch {
      writeError(new Error("--body must be valid JSON"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runPersonUpdate(client, Number(personIdStr), patch, opts);
      writeJson(result);
    } catch (e) {
      writeError(e);
      process.exit(1);
    }
  });
}

/**
 * POST /api/person/newPerson — create a new person record.
 * Body must include personFirstName, personLastName, personEmail.
 */
export async function runPersonCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/person/newPerson",
    body,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /api/person/set — partial update for an existing person.
 * `personId` is merged into the body alongside the caller's patch.
 */
export async function runPersonUpdate(
  client: ApiClient,
  personId: number,
  patch: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/person/set",
    { personId, ...patch },
    { headers: writeFlagsToHeaders(flags) }
  );
}
