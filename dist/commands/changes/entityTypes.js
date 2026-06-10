export const CHANGE_ENTITY_TYPES = [
    {
        entityType: "asiakas",
        entityIdMeaning: "asiakasId",
        gate: "member",
        notes: "Customer companies. Same data as `ib customer history`.",
    },
    {
        entityType: "dayDriver",
        entityIdMeaning: "vehicleId",
        gate: "member",
        notes: "Day-driver assignments (driver reassign / personPvm writes).",
    },
    {
        entityType: "keikka",
        entityIdMeaning: "keikkaId",
        gate: "member",
        notes: "Delivery orders. The history read FOLDS IN keikkaBetoni rows for the same keikka. Driver changes use fieldName 'kuskit'; invoice-memo edits use fieldName 'laskuMemo'.",
    },
    {
        entityType: "keikkaBetoni",
        entityIdMeaning: "keikkaBetoniId",
        gate: "member",
        notes: "Concrete lines of a keikka. Also visible inside `changes entity keikka <keikkaId>`.",
    },
    {
        entityType: "kuski",
        entityIdMeaning: "keikkaId (legacy)",
        gate: "member",
        notes: "RETIRED 2026-04: new driver changes write entityType 'keikka' fieldName 'kuskit'. Only historical rows exist.",
        deprecated: true,
    },
    {
        entityType: "palkki",
        entityIdMeaning: "grid_palkki_id (plain integer)",
        gate: "member",
        notes: "Grid bars. Use the numeric id, not the 'p123' display form.",
    },
    {
        entityType: "person",
        entityIdMeaning: "personId",
        gate: "member",
        notes: "Same data as `ib person history`. Role grants/revokes have fieldName 'asiakasPersonSetting'.",
    },
    {
        entityType: "personAvailability",
        entityIdMeaning: "personId (the affected person)",
        gate: "admin",
        notes: "Vacation/availability changes. Server requires an admin role to read.",
    },
    {
        entityType: "pumppuRequest",
        entityIdMeaning: "pumppuRequestId",
        gate: "member",
        notes: "BetoniJerry RFQ/offer lifecycle (created / offer sent / accepted / confirmed). One row per involved company, so requester and provider each see it under their own tenant.",
    },
    {
        entityType: "sijainti",
        entityIdMeaning: "sijaintiId",
        gate: "member",
        notes: "Locations (geocode module writes coordinate/address changes).",
    },
    {
        entityType: "tuote",
        entityIdMeaning: "tuoteId",
        gate: "member",
        notes: "Products.",
    },
    {
        entityType: "tyomaa",
        entityIdMeaning: "tyomaaId",
        gate: "member",
        notes: "Worksites. Same data as `ib worksite history`.",
    },
    {
        entityType: "vehicle",
        entityIdMeaning: "vehicleId",
        gate: "member",
        notes: "Vehicles. Same data as `ib vehicle history`.",
    },
];
export function findEntityType(t) {
    return CHANGE_ENTITY_TYPES.find((e) => e.entityType === t);
}
export function isKnownEntityType(t) {
    return findEntityType(t) !== undefined;
}
/** `ib changes types` — offline, no network, no auth. */
export function runChangesTypes() {
    return {
        items: [...CHANGE_ENTITY_TYPES],
        nextCursor: null,
        count: CHANGE_ENTITY_TYPES.length,
    };
}
//# sourceMappingURL=entityTypes.js.map