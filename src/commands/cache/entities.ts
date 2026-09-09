/**
 * Offline entity vocabulary for `ib dev cache entities` and `ib dev cache invalidate`.
 *
 * A CURATED SUBSET of the backend's VALID_ENTITIES allowlist (derived there from
 * UniversalCacheManager's BASE_TTL keys, 60+ of them) — the commonly-targeted
 * ones, not a mirror. The backend stays authoritative: an entity missing here is
 * still accepted, and an unknown one returns 400.
 *
 * ⚠ Keep it in step anyway when an entity becomes newly targetable. The backend's
 * rejection message is `Unknown entityType '<x>'. See \`ib cache entities\`.`, so
 * this list is where a stuck operator is sent — an omission reads to them as
 * "that entity does not exist". fb#1545: asiakasPersonSetting was made
 * invalidatable by fb#1538 but left off here, which reproduced the very failure
 * fb#1538 fixed, one layer up.
 *
 * `cascade: true` marks entities supporting related-family fan-out via --cascade.
 * `developerOnly: true` marks cross-tenant entities whose invalidate requires
 * developer access (the backend forces everyone else to their own tenant).
 */
export interface CacheEntity {
  entityType: string;
  /** Which params narrow the clear: "id" (entity id) and/or "asiakasId" (tenant). */
  params: Array<"id" | "asiakasId">;
  cascade?: boolean;
  /** True when this entity's keys span all tenants → invalidate requires developer access. */
  developerOnly?: boolean;
  example: string;
}

export const CACHE_ENTITIES: CacheEntity[] = [
  { entityType: "keikka", params: ["id"], cascade: true, developerOnly: true, example: "ib dev cache invalidate keikka --id 123 --cascade --confirm" },
  { entityType: "asiakas", params: ["asiakasId"], example: "ib dev cache invalidate asiakas --asiakas 8 --confirm" },
  { entityType: "vehicle", params: ["asiakasId"], example: "ib dev cache invalidate vehicle --asiakas 8 --confirm" },
  { entityType: "person", params: ["asiakasId"], example: "ib dev cache invalidate person --asiakas 8 --confirm" },
  // Per-company role grants (fb#1538/fb#1545). Clear this after granting or
  // revoking a role out-of-band, when `ib person role list` still disagrees with SQL.
  { entityType: "asiakasPersonSetting", params: ["asiakasId"], example: "ib dev cache invalidate asiakasPersonSetting --asiakas 27 --confirm" },
  { entityType: "tyomaa", params: ["asiakasId"], example: "ib dev cache invalidate tyomaa --asiakas 8 --confirm" },
  { entityType: "sijainti", params: ["asiakasId"], example: "ib dev cache invalidate sijainti --asiakas 8 --confirm" },
  { entityType: "grid", params: [], developerOnly: true, example: "ib dev cache invalidate grid --confirm" },
  { entityType: "attachment", params: ["asiakasId"], developerOnly: true, example: "ib dev cache invalidate attachment --asiakas 8 --confirm" },
  { entityType: "weather", params: ["asiakasId"], example: "ib dev cache invalidate weather --asiakas 8 --confirm" },
  { entityType: "lasku", params: ["asiakasId"], example: "ib dev cache invalidate lasku --asiakas 8 --confirm" },
  { entityType: "stat", params: [], developerOnly: true, example: "ib dev cache invalidate stat --confirm" },
];
