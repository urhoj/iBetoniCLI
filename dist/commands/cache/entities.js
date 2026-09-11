export const CACHE_ENTITIES = [
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
    // fb#1542: cached by the API for years but unregistered in BASE_TTL, so the
    // backend answered "Unknown entityType" — targetable since @ibetoni/cache 2026-09-11.
    { entityType: "holidays", params: ["asiakasId"], example: "ib dev cache invalidate holidays --asiakas 8 --confirm" },
    { entityType: "ilmoitustaulu", params: ["asiakasId"], example: "ib dev cache invalidate ilmoitustaulu --asiakas 8 --confirm" },
    { entityType: "subscription", params: ["asiakasId"], example: "ib dev cache invalidate subscription --asiakas 8 --confirm" },
    // --asiakas reaches the customer:/pricing: families; the tier-keyed
    // subscriptionItems:available:<tierId> family has no tenant slot and needs a
    // developer sweep with no --asiakas.
    { entityType: "subscriptionItems", params: ["asiakasId"], example: "ib dev cache invalidate subscriptionItems --asiakas 8 --confirm" },
    { entityType: "inventory", params: ["asiakasId"], example: "ib dev cache invalidate inventory --asiakas 8 --confirm" },
];
//# sourceMappingURL=entities.js.map