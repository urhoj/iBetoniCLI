import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { CliError } from "../../api/errors.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { runCustomerSearch } from "../customer/index.js";
import { runPersonSearch, type PersonSearchHit } from "../person/index.js";
import { runWorksiteSearch } from "../worksite/index.js";
import { runVehicleSearch } from "../vehicle/index.js";
import { runKeikkaSearch, type KeikkaSearchHit } from "../keikka/index.js";

/** Canonical entity order — also the within-tier sort order of merged hits. */
export const SEARCH_ENTITIES = ["customer", "worksite", "person", "vehicle", "keikka"] as const;
export type SearchEntity = (typeof SEARCH_ENTITIES)[number];

/** Uniform hit core + the entity's native id field (asiakasId/tyomaaId/...). */
export interface UnifiedHit extends Record<string, unknown> {
  entity: SearchEntity;
  id: number;
  label: string | null;
  detail: string | null;
}

export interface UnifiedSearchEnvelope {
  items: UnifiedHit[];
  nextCursor: null;
  count: number;
  errors: { entity: SearchEntity; message: string }[];
}

/** One async producer of raw entity results per entity (injectable for tests). */
export type SearchSources = Record<string, () => Promise<unknown>>;

const DEFAULT_LIMIT = 5;

/** Parse `--in customer,person`; undefined → all. Unknown name → exit 4. */
export function parseEntityFilter(input?: string): SearchEntity[] {
  if (!input) return [...SEARCH_ENTITIES];
  const wanted = input.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const w of wanted) {
    if (!(SEARCH_ENTITIES as readonly string[]).includes(w)) {
      throw new CliError(
        `Unknown entity "${w}" — valid: ${SEARCH_ENTITIES.join(", ")}`, 0, null, 4
      );
    }
  }
  return SEARCH_ENTITIES.filter((e) => wanted.includes(e));
}

/* ── per-entity projectors (pure, best-effort fields) ───────────────────── */

function projectCustomer(rows: unknown): UnifiedHit[] {
  const arr = Array.isArray(rows) ? rows : [];
  return arr.map((r: Record<string, unknown>) => ({
    entity: "customer" as const,
    id: Number(r.asiakasId),
    asiakasId: Number(r.asiakasId),
    label: (r.asiakasNimi as string) ?? null,
    detail: (r.ytunnus as string) ?? null,
  }));
}

function projectPersons(items: PersonSearchHit[]): UnifiedHit[] {
  return items.map((p) => ({
    entity: "person" as const,
    id: p.personId,
    personId: p.personId,
    label: p.name || null,
    detail: p.phone ?? p.email ?? null,
  }));
}

interface WorksiteHitLike {
  tyomaaId: number; name: string | null; formattedAddress: string | null;
  address: string | null; city: string | null;
}
function projectWorksites(items: WorksiteHitLike[]): UnifiedHit[] {
  return items.map((w) => ({
    entity: "worksite" as const,
    id: w.tyomaaId,
    tyomaaId: w.tyomaaId,
    label: w.name ?? w.address ?? null,
    detail: w.formattedAddress ?? [w.address, w.city].filter(Boolean).join(", ") ?? null,
  }));
}

/**
 * Vehicle projector with a defensive client-side query filter: the backend
 * `?search=` param is deploy-gated and silently ignored pre-deploy (the whole
 * fleet would come back). Matching mirrors the backend: plate/name/typeName
 * case-insensitive substring.
 */
function projectVehicles(items: Record<string, unknown>[], query: string): UnifiedHit[] {
  const q = query.toLowerCase();
  return items
    .filter((v) =>
      [v.plate, v.name, v.typeName].some(
        (f) => typeof f === "string" && f.toLowerCase().includes(q)
      )
    )
    .map((v) => ({
      entity: "vehicle" as const,
      id: Number(v.vehicleId),
      vehicleId: Number(v.vehicleId),
      label: [v.plate, v.name].filter(Boolean).join(" ") || null,
      detail: (v.typeName as string) ?? null,
    }));
}

function projectKeikkas(items: KeikkaSearchHit[]): UnifiedHit[] {
  return items.map((k) => ({
    entity: "keikka" as const,
    id: k.keikkaId,
    keikkaId: k.keikkaId,
    label: k.title ?? `keikka ${k.keikkaId}`,
    detail: [k.pumppuAika, k.customerName].filter(Boolean).join(" · ") || null,
  }));
}

/* ── fan-out + merge ────────────────────────────────────────────────────── */

/** Items from a list envelope, defensively. */
function envItems<T>(env: unknown): T[] {
  return Array.isArray((env as { items?: T[] })?.items)
    ? ((env as { items: T[] }).items)
    : [];
}

/** Dispatch a source's raw result to its projector (accepts native row shapes). */
function projectFor(entity: SearchEntity, value: unknown, query: string): UnifiedHit[] {
  switch (entity) {
    case "customer": return projectCustomer(value);
    case "person": return projectPersons(envItems(value));
    case "worksite": return projectWorksites(envItems(value));
    case "vehicle": return projectVehicles(envItems(value), query);
    case "keikka": return projectKeikkas(envItems(value));
  }
}

/**
 * Fan out to the selected entity sources in parallel and merge.
 * Sources return raw entity shapes — `projectFor` is the single projection point.
 */
export async function runUnifiedSearch(
  query: string,
  rawSources: SearchSources,
  entities: SearchEntity[] = [...SEARCH_ENTITIES]
): Promise<UnifiedSearchEnvelope> {
  const selected = SEARCH_ENTITIES.filter((e) => entities.includes(e));
  const settled = await Promise.allSettled(selected.map((e) => rawSources[e]()));

  const items: UnifiedHit[] = [];
  const errors: { entity: SearchEntity; message: string }[] = [];
  let firstFailure: unknown = null;

  settled.forEach((res, i) => {
    const entity = selected[i];
    if (res.status === "rejected") {
      if (firstFailure === null) firstFailure = res.reason;
      errors.push({
        entity,
        message: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
      return;
    }
    items.push(...projectFor(entity, res.value, query));
  });

  if (items.length === 0 && errors.length === selected.length && firstFailure !== null) {
    throw firstFailure; // every entity failed — surface the first error (mapped exit code)
  }

  const q = query.toLowerCase();
  const tier = (h: UnifiedHit) => (h.label?.toLowerCase().startsWith(q) ? 0 : 1);
  const order = (h: UnifiedHit) => SEARCH_ENTITIES.indexOf(h.entity);
  items.sort((a, b) => tier(a) - tier(b) || order(a) - order(b));

  return { items, nextCursor: null, count: items.length, errors };
}

/**
 * Build the real per-entity sources for a client. Returns RAW results so
 * `projectFor` in `runUnifiedSearch` is the single projection point.
 *
 * When `myCompanies` is true, customer/worksite/person fan out across all
 * companies the caller belongs to (backend-side fan-out or the cross-company
 * person endpoint). Vehicle and keikka are always active-company only.
 */
export function buildSearchSources(
  client: ApiClient,
  query: string,
  limit: number,
  myCompanies = false
): SearchSources {
  return {
    customer: () => runCustomerSearch(client, query, limit, myCompanies),
    worksite: () => runWorksiteSearch(client, query, limit, myCompanies),
    person: () => {
      if (myCompanies) {
        const qs = new URLSearchParams({ q: query, limit: String(limit) });
        return client.get(`/api/cli/person/search?${qs.toString()}`);
      }
      return runPersonSearch(client, query, limit);
    },
    vehicle: () => runVehicleSearch(client, query, limit), // active company only
    keikka: async () => {
      const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken());
      return runKeikkaSearch(client, query, ownerAsiakasId, limit); // active company only
    },
  };
}

/* ── Commander wiring ───────────────────────────────────────────────────── */

/**
 * Register `ib search` — read-only cross-entity unified search. Client-side
 * fan-out over the existing per-entity search endpoints; no backend changes.
 */
export function registerSearchCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("search <query>")
    .description("Cross-entity search: customers, worksites, persons, vehicles, keikkas (one flat ranked list)")
    .option("--in <entities>", `Comma-separated subset of: ${SEARCH_ENTITIES.join(",")}`)
    .option("--limit <n>", "Max hits per entity", (v: string) => Number(v), DEFAULT_LIMIT)
    .option("--my-companies", "Also search every company you belong to (customer/worksite/person only; vehicle & keikka stay active-company)")
    .action(async (query: string, opts: { in?: string; limit: number; myCompanies?: boolean }) => {
      try {
        const entities = parseEntityFilter(opts.in);
        const client = await getClient();
        const srcs = buildSearchSources(client, query, opts.limit, !!opts.myCompanies);
        const result = await runUnifiedSearch(query, srcs, entities);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });
}
