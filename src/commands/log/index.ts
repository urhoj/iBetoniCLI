/**
 * `ib log` — changeTracker (audit trail) reading.
 *
 * All subcommands are read-only GETs against the ALREADY-DEPLOYED
 * /api/changes/* routes (puminet5api/routes/changeTrackingRoutes.js) — no
 * deploy gate. Gates are server-side: entity reads need company membership
 * (personAvailability needs admin); latest/range/by-entity-date need an admin
 * role; user <otherPersonId> needs admin.
 *
 * Spec: docs/superpowers/specs/2026-06-10-ib-changetracker-reading-design.md
 * Rename (changes→log): docs/superpowers/specs/2026-06-11-ib-log-rename-design.md
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith, warnNote } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { parseId, parseOptionalId, cappedInt, addOwnerOption } from "../../targets.js";
import { guarded, jsonAction } from "../_shared/action.js";
import {
  CHANGE_ENTITY_TYPES,
  findEntityType,
  isKnownEntityType,
  runLogTypes,
} from "./entityTypes.js";
import { qs } from "../../api/query.js";
import {
  projectChangeRow,
  type ChangeItem,
  type RawChangeRow,
} from "./changeRow.js";

export type { ChangeItem };

function assertKnownEntityType(entityType: string): void {
  if (!isKnownEntityType(entityType)) {
    failWith(
      `unknown entityType '${entityType}'. Valid: ` +
        CHANGE_ENTITY_TYPES.map((e) => e.entityType).join(", ") +
        ". See `ib log types`.",
      4
    );
  }
  const info = findEntityType(entityType)!;
  if (info.deprecated) {
    // Diagnostic on stderr (stdout stays pure JSON data).
    warnNote(`note: entityType '${entityType}' is deprecated — ${info.notes}`);
  }
}

/** Accepts YYYY-MM-DD or a full ISO datetime; anything else is exit 4. */
function assertIsoDate(value: string, flag: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ||
    isNaN(Date.parse(value))
  ) {
    failWith(`${flag} must be YYYY-MM-DD or an ISO datetime (got '${value}').`, 4);
  }
}

function envelope(items: ChangeItem[], truncated = false): ListEnvelope<ChangeItem> {
  const out: ListEnvelope<ChangeItem> = listEnvelope(items);
  if (truncated) out.truncated = true;
  return out;
}

/**
 * The read every `ib log` subcommand performs: resolve the owner (all five
 * routes are `/:owner`-scoped, defaulting to the active company), GET, and
 * normalise a non-array body to `[]`. `path` is a builder because the owner is
 * part of the route, not a query param.
 */
async function getChanges(
  client: ApiClient,
  path: (owner: number) => string,
  owner?: number
): Promise<RawChangeRow[]> {
  const resolved = owner ?? (await resolveActiveOwnerAsiakasId(client));
  const rows = await client.get<RawChangeRow[]>(path(resolved));
  return Array.isArray(rows) ? rows : [];
}

/**
 * The two date-window routes (`range`, `by-entity-date`) differ only in their
 * route segment and query params: both have NO server row limit, so both slice
 * client-side to protect AI context and flag `truncated` when rows were cut.
 *
 * Each caller keeps its OWN guards — their order differs (`range` validates
 * dates then entityType, `by-entity-date` the reverse), and which error a bad
 * invocation reports is part of the contract.
 */
async function runChangeWindow(
  client: ApiClient,
  segment: string,
  params: Record<string, string | number | undefined>,
  opts: { limit: number; owner?: number }
): Promise<ListEnvelope<ChangeItem>> {
  const rows = await getChanges(
    client,
    (owner) => `/api/changes/${segment}/${owner}${qs(params)}`,
    opts.owner
  );
  const sliced = rows.slice(0, opts.limit);
  return envelope(sliced.map(projectChangeRow), sliced.length < rows.length);
}

/** GET /api/changes/:entityType/:entityId/:owner — generic entity history. */
export async function runLogEntity(
  client: ApiClient,
  entityType: string,
  entityId: number,
  limit: number,
  opts: { owner?: number; field?: string } = {}
): Promise<ListEnvelope<ChangeItem>> {
  assertKnownEntityType(entityType);
  let list = await getChanges(
    client,
    (owner) => `/api/changes/${entityType}/${entityId}/${owner}?limit=${limit}`,
    opts.owner
  );
  if (opts.field) list = list.filter((r) => r.fieldName === opts.field);
  return envelope(list.map(projectChangeRow));
}

/** GET /api/changes/latest/:owner — admin-only, newest first, server cap 500. */
export async function runLogLatest(
  client: ApiClient,
  limit: number,
  opts: { entityType?: string; owner?: number } = {}
): Promise<ListEnvelope<ChangeItem>> {
  if (opts.entityType) assertKnownEntityType(opts.entityType);
  const rows = await getChanges(
    client,
    (owner) =>
      `/api/changes/latest/${owner}${qs({ limit, entityType: opts.entityType || undefined })}`,
    opts.owner
  );
  return envelope(rows.map(projectChangeRow));
}

/** GET /api/changes/range/:owner — admin-only, by change timestamp. */
export async function runLogRange(
  client: ApiClient,
  opts: {
    from: string;
    to: string;
    entityType?: string;
    person?: number;
    limit: number;
    owner?: number;
  }
): Promise<ListEnvelope<ChangeItem>> {
  assertIsoDate(opts.from, "--from");
  assertIsoDate(opts.to, "--to");
  if (opts.entityType) assertKnownEntityType(opts.entityType);
  return runChangeWindow(
    client,
    "range",
    {
      startDate: opts.from,
      endDate: opts.to,
      entityType: opts.entityType || undefined,
      personId: opts.person ?? undefined,
    },
    opts
  );
}

/**
 * GET /api/changes/by-entity-date/:owner — admin-only. Filters by the
 * ENTITY's date (keikka.pumppuAika / grid_palkit.starttime), not the change
 * timestamp: "changes affecting that day's deliveries".
 */
export async function runLogByEntityDate(
  client: ApiClient,
  opts: { entityType: string; from: string; to: string; limit: number; owner?: number }
): Promise<ListEnvelope<ChangeItem>> {
  if (!["keikka", "palkki"].includes(opts.entityType)) {
    failWith(
      `--entity-type must be keikka or palkki for by-entity-date (got '${opts.entityType}').`,
      4
    );
  }
  assertIsoDate(opts.from, "--from");
  assertIsoDate(opts.to, "--to");
  return runChangeWindow(
    client,
    "by-entity-date",
    { startDate: opts.from, endDate: opts.to, entityType: opts.entityType },
    opts
  );
}

/**
 * `ib log user [personId]` — no arg: own recent changes
 * (GET /api/changes/user/recent/:owner); with personId: that person's changes
 * (GET /api/changes/user/:personId/:owner — self or admin).
 */
export async function runLogUser(
  client: ApiClient,
  personId: number | null,
  limit: number,
  opts: { owner?: number } = {}
): Promise<ListEnvelope<ChangeItem>> {
  const rows = await getChanges(
    client,
    (owner) =>
      personId == null
        ? `/api/changes/user/recent/${owner}?limit=${limit}`
        : `/api/changes/user/${personId}/${owner}?limit=${limit}`,
    opts.owner
  );
  return envelope(rows.map(projectChangeRow));
}

/** Registers a thin `log <id>` alias on an entity group, delegating to runLogEntity. */
export function registerLogAlias(
  group: Command,
  getClient: () => Promise<ApiClient>,
  entityType: string,
  idArgName: string,
  fieldExample = "Filter by changeTracker fieldName"
): void {
  addOwnerOption(group.command(`log <${idArgName}>`))
    .option("--limit <n>", "Max rows (default 100, cap 500)", cappedInt(500), 100)
    .option("--field <name>", fieldExample)
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { owner?: number; limit: number; field?: string }) =>
        runLogEntity(client, entityType, parseId(idStr, "entityId"), opts.limit, {
          owner: opts.owner,
          field: opts.field,
        })
      )
    );
}

export function registerLogCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const c = parent.command("log").description("ChangeTracker (audit trail) reads");

  addOwnerOption(c.command("entity <entityType> <entityId>"))
    .option(
      "--limit <n>",
      "Max rows (default 100, cap 500)",
      cappedInt(500),
      100
    )
    .option("--field <name>", "Filter by changeTracker fieldName (client-side)")
    .action(
      jsonAction(getClient, (client, entityType: string, entityIdStr: string, opts: { owner?: number; limit: number; field?: string }) =>
        runLogEntity(client, entityType, parseId(entityIdStr, "entityId"), opts.limit, { owner: opts.owner, field: opts.field })
      )
    );

  addOwnerOption(
    c.command("latest").option("--entity-type <type>", "Filter to one entityType")
  )
    .option(
      "--limit <n>",
      "Max rows (default 100, server cap 500)",
      cappedInt(500),
      100
    )
    .action(
      jsonAction(getClient, (client, opts: { entityType?: string; owner?: number; limit: number }) =>
        runLogLatest(client, opts.limit, {
          entityType: opts.entityType,
          owner: opts.owner,
        })
      )
    );

  addOwnerOption(
    c
      .command("range")
      .requiredOption(
        "--from <iso>",
        "Window start YYYY-MM-DD or ISO datetime (or today/yesterday/tomorrow)"
      )
      .requiredOption(
        "--to <iso>",
        "Window end YYYY-MM-DD or ISO datetime (or today/yesterday/tomorrow)"
      )
      .option("--entity-type <type>", "Filter to one entityType")
      .option("--person <personId>", "Filter to one actor", (v: string) => Number(v))
  )
    .option(
      "--limit <n>",
      "Max rows kept client-side (default 200, cap 2000)",
      cappedInt(2000),
      200
    )
    .action(
      jsonAction(
        getClient,
        (
          client,
          opts: {
            from: string;
            to: string;
            entityType?: string;
            person?: number;
            owner?: number;
            limit: number;
          }
        ) =>
          runLogRange(client, {
            from: resolveDate(opts.from) ?? opts.from,
            to: resolveDate(opts.to) ?? opts.to,
            entityType: opts.entityType,
            person: opts.person,
            owner: opts.owner,
            limit: opts.limit,
          })
      )
    );

  addOwnerOption(
    c
      .command("by-entity-date")
      .requiredOption("--entity-type <type>", "keikka or palkki")
      .requiredOption(
        "--from <iso>",
        "Entity-date window start YYYY-MM-DD (or today/yesterday/tomorrow)"
      )
      .requiredOption(
        "--to <iso>",
        "Entity-date window end YYYY-MM-DD (or today/yesterday/tomorrow)"
      )
  )
    .option(
      "--limit <n>",
      "Max rows kept client-side (default 200, cap 2000)",
      cappedInt(2000),
      200
    )
    .action(
      jsonAction(
        getClient,
        (
          client,
          opts: {
            entityType: string;
            from: string;
            to: string;
            owner?: number;
            limit: number;
          }
        ) =>
          runLogByEntityDate(client, {
            entityType: opts.entityType,
            from: resolveDate(opts.from) ?? opts.from,
            to: resolveDate(opts.to) ?? opts.to,
            owner: opts.owner,
            limit: opts.limit,
          })
      )
    );

  addOwnerOption(c.command("user [personId]"))
    .option(
      "--limit <n>",
      "Max rows (default 100)",
      cappedInt(500),
      100
    )
    .action(
      jsonAction(getClient, (client, personIdStr: string | undefined, opts: { owner?: number; limit: number }) =>
        runLogUser(client, parseOptionalId(personIdStr, "personId") ?? null, opts.limit, { owner: opts.owner })
      )
    );

  c.command("types")
    .action(guarded(() => {
      writeJson(runLogTypes());
    }));
}
