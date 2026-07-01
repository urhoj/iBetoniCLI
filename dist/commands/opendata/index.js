import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { registerBuildingCommands } from "../building/index.js";
import { registerParcelCommands } from "../parcel/index.js";
import { registerWeatherCommands } from "../weather/index.js";
import { runPrhById, runPrhSearch } from "../../prh.js";
/**
 * `ib opendata` — FREE / OPEN external-data APIs, distinct from tenant business
 * data. Each leaf queries a public source (city building registries via WFS,
 * FMI weather, PRH business registry) and may resolve a coordinate/identifier
 * from a betoni.online entity for convenience.
 *
 * The home for future open-data sources (e.g. Digitraffic). Weather and PRH are
 * re-homed here (canonical); their previous paths (`ib weather`, `ib customer
 * prh`) remain as hidden back-compat aliases registered elsewhere.
 */
export function registerOpendataCommands(parent, getClient) {
    const od = parent
        .command("opendata")
        .description("Free/open external-data APIs — city building registries, FMI weather, PRH business registry");
    registerBuildingCommands(od, getClient);
    registerParcelCommands(od, getClient);
    registerWeatherCommands(od, getClient);
    od.command("prh [ytunnus]")
        .description("Look up a company in the Finnish business registry (PRH) by <ytunnus>, or --search <name>")
        .option("--search <name>", "Search by company name instead of business ID")
        .option("--page <n>", "Result page for --search (default 1)", (v) => Number(v), 1)
        .action(async (ytunnus, opts) => {
        try {
            const client = await getClient();
            if (opts.search) {
                writeJson(await runPrhSearch(client, opts.search, opts.page));
                return;
            }
            if (!ytunnus) {
                failWith("provide a business-ID positional or --search <name>", 4);
            }
            writeJson(await runPrhById(client, ytunnus));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map