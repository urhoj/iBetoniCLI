import { writeJson, exitWithError, failWith } from "../../output/json.js";
/** Distinct primary coordinate sources the caller supplied (exactly one allowed). */
function selectedSources(opts) {
    const sources = [];
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
 * GET /api/cli/opendata/building/lookup — resolve a single point (from a
 * sijainti / worksite / lat+lng / address) to multi-city building-registry
 * data. The caller passes exactly one source; the backend derives or auto-tries
 * the city when --city is omitted.
 */
export async function runBuildingLookup(client, opts) {
    const params = new URLSearchParams();
    const worksite = opts.worksite ?? opts.tyomaa;
    if (opts.sijainti !== undefined)
        params.set("sijainti", String(opts.sijainti));
    if (worksite !== undefined)
        params.set("worksite", String(worksite));
    if (opts.lat !== undefined)
        params.set("lat", String(opts.lat));
    if (opts.lng !== undefined)
        params.set("lng", String(opts.lng));
    if (opts.address !== undefined)
        params.set("address", opts.address);
    if (opts.city !== undefined)
        params.set("city", opts.city);
    return client.get(`/api/cli/opendata/building/lookup?${params.toString()}`);
}
/** Register `ib opendata building`. */
export function registerBuildingCommands(parent, getClient) {
    parent
        .command("building")
        .description("Building-registry lookup (Helsinki/Vantaa/Espoo/HSY open data) for a sijainti, worksite, address, or lat/lng")
        .option("--sijainti <id>", "Resolve coordinates from a sijainti id", Number)
        .option("--worksite <tyomaaId>", "Resolve coordinates from a worksite (tenant-scoped)", Number)
        .option("--tyomaa <tyomaaId>", "Alias for --worksite", Number)
        .option("--lat <n>", "Latitude (WGS84) — pair with --lng", Number)
        .option("--lng <n>", "Longitude (WGS84) — pair with --lat", Number)
        .option("--address <s>", "Street address to geocode")
        .option("--city <name>", "Helsinki | Vantaa | Espoo | HSY (override; otherwise derived/auto-tried)")
        .action(async (opts) => {
        const sources = selectedSources(opts);
        if (sources.length === 0) {
            failWith("provide exactly one of: --sijainti, --worksite, --lat+--lng, or --address", 4);
        }
        if (sources.length > 1) {
            failWith(`provide exactly one primary source (got: ${sources.join(", ")})`, 4);
        }
        if (sources[0] === "coords" && (opts.lat === undefined || opts.lng === undefined)) {
            failWith("--lat and --lng must be provided together", 4);
        }
        if (opts.worksite !== undefined &&
            opts.tyomaa !== undefined &&
            opts.worksite !== opts.tyomaa) {
            failWith("--worksite and --tyomaa disagree; pass only one", 4);
        }
        try {
            const client = await getClient();
            writeJson(await runBuildingLookup(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map