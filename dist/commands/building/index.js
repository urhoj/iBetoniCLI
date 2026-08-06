import { writeJson } from "../../output/json.js";
import { guarded } from "../_shared/action.js";
import { addPointSourceOptions, assertSinglePointSource, pointSourceParams, selectedPointSources, } from "../_shared/pointSource.js";
import { qs } from "../../api/query.js";
/**
 * GET /api/cli/opendata/building/lookup — resolve a single point (from a
 * sijainti / worksite / lat+lng / address) to multi-city building-registry
 * data. The caller passes exactly one source; the backend derives or auto-tries
 * the city when --city is omitted.
 */
export async function runBuildingLookup(client, opts) {
    return client.get(`/api/cli/opendata/building/lookup${qs({
        ...pointSourceParams(opts),
        city: opts.city,
    })}`);
}
/** Register `ib opendata building`. */
export function registerBuildingCommands(parent, getClient) {
    addPointSourceOptions(parent.command("building"))
        .option("--city <name>", "Helsinki | Vantaa | Espoo | HSY | Ryhti (override; otherwise derived/auto-tried then national Ryhti fallback)")
        .action(guarded(async (opts) => {
        assertSinglePointSource(opts, selectedPointSources(opts), {
            none: "provide exactly one of: --sijainti, --worksite, --lat+--lng, or --address",
            multiple: (got) => `provide exactly one primary source (got: ${got})`,
        });
        const client = await getClient();
        writeJson(await runBuildingLookup(client, opts));
    }));
}
//# sourceMappingURL=index.js.map