import { writeJson } from "../../output/json.js";
import { guarded } from "../_shared/action.js";
import { addPointSourceOptions, assertSinglePointSource, pointSourceParams, selectedPointSources, } from "../_shared/pointSource.js";
import { qs } from "../../api/query.js";
/**
 * GET /api/cli/opendata/parcel/lookup — resolve a cadastral parcel (kiinteistö /
 * palsta) from EITHER a kiinteistötunnus (direct, no geocode) OR one point
 * source (sijainti / worksite / lat+lng / address). Returns the parcel
 * polygon(s), MML presentation-form id and a computed area (m²).
 */
export async function runParcelLookup(client, opts) {
    return client.get(`/api/cli/opendata/parcel/lookup${qs({
        kiinteistotunnus: opts.kiinteistotunnus,
        ...pointSourceParams(opts),
        // `1`, not the raw boolean — `qs` would serialise `true` as "true".
        withBuildings: opts.withBuildings ? 1 : undefined,
    })}`);
}
/** Register `ib opendata parcel`. */
export function registerParcelCommands(parent, getClient) {
    addPointSourceOptions(parent
        .command("parcel")
        .option("--kiinteistotunnus <tunnus>"))
        .option("--with-buildings")
        .action(guarded(async (opts) => {
        // kiinteistotunnus is a DIRECT lookup, not a point source, so it is added
        // here rather than inside selectedPointSources — it is still mutually
        // exclusive with the four, and it leads the reported list.
        const sources = [
            ...(opts.kiinteistotunnus !== undefined ? ["kiinteistotunnus"] : []),
            ...selectedPointSources(opts),
        ];
        assertSinglePointSource(opts, sources, {
            none: "provide exactly one of: --kiinteistotunnus, --sijainti, --worksite, --lat+--lng, or --address",
            multiple: (got) => `provide exactly one source (got: ${got})`,
        });
        const client = await getClient();
        writeJson(await runParcelLookup(client, opts));
    }));
}
//# sourceMappingURL=index.js.map