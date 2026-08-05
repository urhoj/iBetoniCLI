import { writeJson, failWith } from "../../output/json.js";
import { guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
/** Distinct primary sources the caller supplied (exactly one allowed). */
function selectedSources(opts) {
    const sources = [];
    if (opts.kiinteistotunnus !== undefined)
        sources.push("kiinteistotunnus");
    if (opts.sijainti !== undefined)
        sources.push("sijainti");
    if (opts.worksite !== undefined || opts.tyomaa !== undefined)
        sources.push("worksite");
    if (opts.lat !== undefined || opts.lng !== undefined)
        sources.push("coords");
    if (opts.address !== undefined)
        sources.push("address");
    return sources;
}
/**
 * GET /api/cli/opendata/parcel/lookup — resolve a cadastral parcel (kiinteistö /
 * palsta) from EITHER a kiinteistötunnus (direct, no geocode) OR one point
 * source (sijainti / worksite / lat+lng / address). Returns the parcel
 * polygon(s), MML presentation-form id and a computed area (m²).
 */
export async function runParcelLookup(client, opts) {
    return client.get(`/api/cli/opendata/parcel/lookup${qs({
        kiinteistotunnus: opts.kiinteistotunnus,
        sijainti: opts.sijainti,
        worksite: opts.worksite ?? opts.tyomaa,
        lat: opts.lat,
        lng: opts.lng,
        address: opts.address,
        // `1`, not the raw boolean — `qs` would serialise `true` as "true".
        withBuildings: opts.withBuildings ? 1 : undefined,
    })}`);
}
/** Register `ib opendata parcel`. */
export function registerParcelCommands(parent, getClient) {
    parent
        .command("parcel")
        .option("--kiinteistotunnus <tunnus>", "Property identifier, dashed or 14-digit — direct lookup (no geocode)")
        .option("--sijainti <id>", "Resolve coordinates from a sijainti id", Number)
        .option("--worksite <tyomaaId>", "Resolve coordinates from a worksite (tenant-scoped)", Number)
        .option("--tyomaa <tyomaaId>", "Alias for --worksite", Number)
        .option("--lat <n>", "Latitude (WGS84) — pair with --lng", Number)
        .option("--lng <n>", "Longitude (WGS84) — pair with --lat", Number)
        .option("--address <s>", "Street address to geocode")
        .option("--with-buildings", "Also count buildings on the parcel (national Ryhti; permit-based, best-effort)")
        .action(guarded(async (opts) => {
        const sources = selectedSources(opts);
        if (sources.length === 0) {
            failWith("provide exactly one of: --kiinteistotunnus, --sijainti, --worksite, --lat+--lng, or --address", 4);
        }
        if (sources.length > 1) {
            failWith(`provide exactly one source (got: ${sources.join(", ")})`, 4);
        }
        if (sources[0] === "coords" && (opts.lat === undefined || opts.lng === undefined)) {
            failWith("--lat and --lng must be provided together", 4);
        }
        if (opts.worksite !== undefined &&
            opts.tyomaa !== undefined &&
            opts.worksite !== opts.tyomaa) {
            failWith("--worksite and --tyomaa disagree; pass only one", 4);
        }
        const client = await getClient();
        writeJson(await runParcelLookup(client, opts));
    }));
}
//# sourceMappingURL=index.js.map