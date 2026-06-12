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
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import {
  CHANGE_ENTITY_TYPES,
  findEntityType,
  isKnownEntityType,
  runLogTypes,
} from "./entityTypes.js";

/** Raw wire row from /api/changes/* (superset across the five routes). */
interface RawChangeRow {
  changeId: number;
  entityType?: string | null;
  entityId?: number | null;
  changeType?: string | null;
  fieldName?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  personId?: number | null;
  personFullName?: string | null;
  timestamp?: string | null;
  description?: string | null;
  reason?: string | null;
  impersonatedByPersonName?: string | null;
  keikkaTilaContext?: number | null;
  deviceType?: string | null;
  entityDisplayName?: string | null;
  palkkiText?: string | null;
  palkkiVehicleRegNo?: string | null;
}

export interface ChangeItem {
  changeId: number;
  entityType: string | null;
  entityId: number | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changeType: string | null;
  personId: number | null;
  personName: string | null;
  at: string | null;
  description: string | null;
  /** null until the 2026-06 aggregate-procs migration is deployed (aggregate views). */
  reason: string | null;
  impersonatedByPersonName: string | null;
  keikkaTilaContext?: number | null;
  deviceType?: string | null;
  entityDisplayName?: string;
  palkkiText?: string;
  palkkiVehicleRegNo?: string;
}

function projectRow(r: RawChangeRow): ChangeItem {
  const item: ChangeItem = {
    changeId: r.changeId,
    entityType: r.entityType ?? null,
    entityId: r.entityId ?? null,
    field: r.fieldName ?? null,
    oldValue: r.oldValue ?? null,
    newValue: r.newValue ?? null,
    changeType: r.changeType ?? null,
    personId: r.personId ?? null,
    personName: r.personFullName ?? null,
    at: r.timestamp ?? null,
    description: r.description ?? null,
    reason: r.reason ?? null,
    impersonatedByPersonName: r.impersonatedByPersonName ?? null,
    keikkaTilaContext: r.keikkaTilaContext ?? null,
    deviceType: r.deviceType ?? null,
  };
  if (r.entityDisplayName != null) item.entityDisplayName = r.entityDisplayName;
  if (r.palkkiText != null) item.palkkiText = r.palkkiText;
  if (r.palkkiVehicleRegNo != null) item.palkkiVehicleRegNo = r.palkkiVehicleRegNo;
  return item;
}


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
    process.stderr.write(
      `note: entityType '${entityType}' is deprecated — ${info.notes}\n`
    );
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
  const out: ListEnvelope<ChangeItem> = { items, nextCursor: null, count: items.length };
  if (truncated) out.truncated = true;
  return out;
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
  const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
  const rows = await client.get<RawChangeRow[]>(
    `/api/changes/${entityType}/${entityId}/${owner}?limit=${limit}`
  );
  let list = Array.isArray(rows) ? rows : [];
  if (opts.field) list = list.filter((r) => r.fieldName === opts.field);
  return envelope(list.map(projectRow));
}

/** GET /api/changes/latest/:owner — admin-only, newest first, server cap 500. */
export async function runLogLatest(
  client: ApiClient,
  limit: number,
  opts: { entityType?: string; owner?: number } = {}
): Promise<ListEnvelope<ChangeItem>> {
  if (opts.entityType) assertKnownEntityType(opts.entityType);
  const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
  const qs = new URLSearchParams({ limit: String(limit) });
  if (opts.entityType) qs.set("entityType", opts.entityType);
  const rows = await client.get<RawChangeRow[]>(`/api/changes/latest/${owner}?${qs}`);
  return envelope((Array.isArray(rows) ? rows : []).map(projectRow));
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
  const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
  const qs = new URLSearchParams({ startDate: opts.from, endDate: opts.to });
  if (opts.entityType) qs.set("entityType", opts.entityType);
  if (opts.person != null) qs.set("personId", String(opts.person));
  const rows = await client.get<RawChangeRow[]>(`/api/changes/range/${owner}?${qs}`);
  const list = Array.isArray(rows) ? rows : [];
  // The route/proc has NO row limit — slice client-side to protect AI context.
  const sliced = list.slice(0, opts.limit);
  return envelope(sliced.map(projectRow), sliced.length < list.length);
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
  const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
  const qs = new URLSearchParams({
    startDate: opts.from,
    endDate: opts.to,
    entityType: opts.entityType,
  });
  const rows = await client.get<RawChangeRow[]>(`/api/changes/by-entity-date/${owner}?${qs}`);
  const list = Array.isArray(rows) ? rows : [];
  const sliced = list.slice(0, opts.limit);
  return envelope(sliced.map(projectRow), sliced.length < list.length);
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
  const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
  const path =
    personId == null
      ? `/api/changes/user/recent/${owner}?limit=${limit}`
      : `/api/changes/user/${personId}/${owner}?limit=${limit}`;
  const rows = await client.get<RawChangeRow[]>(path);
  return envelope((Array.isArray(rows) ? rows : []).map(projectRow));
}

/** Registers a thin `log <id>` alias on an entity group, delegating to runLogEntity. */
export function registerLogAlias(
  group: Command,
  getClient: () => Promise<ApiClient>,
  entityType: string,
  idArgName: string,
  description: string,
  fieldExample = "Filter by changeTracker fieldName"
): void {
  group
    .command(`log <${idArgName}>`)
    .description(description)
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option("--limit <n>", "Max rows (default 100, cap 500)", (v: string) => Math.min(Number(v), 500), 100)
    .option("--field <name>", fieldExample)
    .action(async (idStr: string, opts: { owner?: number; limit: number; field?: string }) => {
      try {
        const client = await getClient();
        writeJson(
          await runLogEntity(client, entityType, Number(idStr), opts.limit, {
            owner: opts.owner,
            field: opts.field,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    });
}

export function registerLogCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const c = parent.command("log").description("ChangeTracker (audit trail) reads");

  c.command("entity <entityType> <entityId>")
    .description(
      "Audit trail for ONE entity — who changed which field, when, old→new, with --reason. " +
        "Valid entityTypes: `ib log types`."
    )
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option(
      "--limit <n>",
      "Max rows (default 100, cap 500)",
      (v: string) => Math.min(Number(v), 500),
      100
    )
    .option("--field <name>", "Filter by changeTracker fieldName (client-side)")
    .action(
      async (
        entityType: string,
        entityIdStr: string,
        opts: { owner?: number; limit: number; field?: string }
      ) => {
        try {
          const client = await getClient();
          writeJson(
            await runLogEntity(client, entityType, Number(entityIdStr), opts.limit, {
              owner: opts.owner,
              field: opts.field,
            })
          );
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  c.command("latest")
    .description(
      "Newest changes across the whole company (admin), optionally one entityType."
    )
    .option("--entity-type <type>", "Filter to one entityType")
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option(
      "--limit <n>",
      "Max rows (default 100, server cap 500)",
      (v: string) => Math.min(Number(v), 500),
      100
    )
    .action(async (opts: { entityType?: string; owner?: number; limit: number }) => {
      try {
        const client = await getClient();
        writeJson(
          await runLogLatest(client, opts.limit, {
            entityType: opts.entityType,
            owner: opts.owner,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("range")
    .description("Changes MADE within a time window (admin). Filter by entityType/person.")
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
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option(
      "--limit <n>",
      "Max rows kept client-side (default 200, cap 2000)",
      (v: string) => Math.min(Number(v), 2000),
      200
    )
    .action(
      async (opts: {
        from: string;
        to: string;
        entityType?: string;
        person?: number;
        owner?: number;
        limit: number;
      }) => {
        try {
          const client = await getClient();
          writeJson(
            await runLogRange(client, {
              from: resolveDate(opts.from) ?? opts.from,
              to: resolveDate(opts.to) ?? opts.to,
              entityType: opts.entityType,
              person: opts.person,
              owner: opts.owner,
              limit: opts.limit,
            })
          );
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  c.command("by-entity-date")
    .description(
      "Changes affecting deliveries DATED in the window (admin) — filters by " +
        "keikka.pumppuAika / palkki starttime, not change time."
    )
    .requiredOption("--entity-type <type>", "keikka or palkki")
    .requiredOption(
      "--from <iso>",
      "Entity-date window start YYYY-MM-DD (or today/yesterday/tomorrow)"
    )
    .requiredOption(
      "--to <iso>",
      "Entity-date window end YYYY-MM-DD (or today/yesterday/tomorrow)"
    )
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option(
      "--limit <n>",
      "Max rows kept client-side (default 200, cap 2000)",
      (v: string) => Math.min(Number(v), 2000),
      200
    )
    .action(
      async (opts: {
        entityType: string;
        from: string;
        to: string;
        owner?: number;
        limit: number;
      }) => {
        try {
          const client = await getClient();
          writeJson(
            await runLogByEntityDate(client, {
              entityType: opts.entityType,
              from: resolveDate(opts.from) ?? opts.from,
              to: resolveDate(opts.to) ?? opts.to,
              owner: opts.owner,
              limit: opts.limit,
            })
          );
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  c.command("user [personId]")
    .description(
      "Changes MADE BY a person (no arg = yourself; another personId needs admin)."
    )
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option(
      "--limit <n>",
      "Max rows (default 100)",
      (v: string) => Math.min(Number(v), 500),
      100
    )
    .action(
      async (personIdStr: string | undefined, opts: { owner?: number; limit: number }) => {
        try {
          const client = await getClient();
          writeJson(
            await runLogUser(client, personIdStr ? Number(personIdStr) : null, opts.limit, {
              owner: opts.owner,
            })
          );
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  c.command("types")
    .description(
      "Offline catalog of changeTracker entityTypes (id meaning, read gate, notes)."
    )
    .action(() => {
      try {
        writeJson(runLogTypes());
      } catch (e) {
        exitWithError(e);
      }
    });
}
