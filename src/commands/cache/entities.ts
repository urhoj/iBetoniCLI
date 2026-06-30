/**
 * Offline entity vocabulary for `ib dev cache entities` and `ib dev cache invalidate`.
 * Mirrors the backend VALID_ENTITIES allowlist (UniversalCacheManager BASE_TTL).
 * The backend is authoritative — unknown entities return 400. `cascade: true`
 * marks entities that support related-family fan-out via --cascade.
 * `developerOnly: true` marks cross-tenant entities whose invalidate requires developer access.
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
  { entityType: "asiakas", params: ["asiakasId"], example: "ib dev cache invalidate asiakas --asiakas-id 8 --confirm" },
  { entityType: "vehicle", params: ["asiakasId"], example: "ib dev cache invalidate vehicle --asiakas-id 8 --confirm" },
  { entityType: "person", params: ["asiakasId"], example: "ib dev cache invalidate person --asiakas-id 8 --confirm" },
  { entityType: "tyomaa", params: ["asiakasId"], example: "ib dev cache invalidate tyomaa --asiakas-id 8 --confirm" },
  { entityType: "sijainti", params: ["asiakasId"], example: "ib dev cache invalidate sijainti --asiakas-id 8 --confirm" },
  { entityType: "grid", params: [], developerOnly: true, example: "ib dev cache invalidate grid --confirm" },
  { entityType: "attachment", params: ["asiakasId"], developerOnly: true, example: "ib dev cache invalidate attachment --asiakas-id 8 --confirm" },
  { entityType: "weather", params: ["asiakasId"], example: "ib dev cache invalidate weather --asiakas-id 8 --confirm" },
  { entityType: "lasku", params: ["asiakasId"], example: "ib dev cache invalidate lasku --asiakas-id 8 --confirm" },
  { entityType: "stat", params: [], developerOnly: true, example: "ib dev cache invalidate stat --confirm" },
];
