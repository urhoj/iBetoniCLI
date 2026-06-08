import { writeJson } from "../../output/json.js";
/** Coerce an unknown JSON value to a string field, preserving null/absent as null. */
function asStr(v) {
    if (typeof v === "string")
        return v;
    return v == null ? null : String(v);
}
/**
 * Fetch `GET <endpoint>/api/version` (no auth) and fold it into a VersionReport.
 * Never throws: a non-2xx or network failure returns `reachable: false` with the
 * detail in `error`, so the local `cli` version is always reported. Pure /
 * injectable (`fetchImpl`) so it is unit-testable without spawning the CLI.
 */
export async function runVersion(opts) {
    const { endpoint, cliVersion } = opts;
    const doFetch = opts.fetchImpl ?? fetch;
    const url = `${endpoint.replace(/\/+$/, "")}/api/version`;
    try {
        const res = await doFetch(url, {
            headers: { "User-Agent": `ib-cli/${cliVersion}`, Accept: "application/json" },
        });
        if (!res.ok) {
            return {
                cli: cliVersion,
                endpoint,
                reachable: false,
                server: null,
                error: `HTTP ${res.status}`,
            };
        }
        const body = (await res.json());
        return {
            cli: cliVersion,
            endpoint,
            reachable: true,
            server: {
                app: asStr(body.app),
                version: asStr(body.version),
                commit: asStr(body.commit),
                release: asStr(body.release),
                slot: asStr(body.slot),
            },
        };
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return { cli: cliVersion, endpoint, reachable: false, server: null, error: detail };
    }
}
/**
 * Register `ib version`. Unlike domain commands it takes no `getClient` (the
 * endpoint is public) — just the CLI version and an endpoint resolver that
 * mirrors the normal `--endpoint` → active-profile → default chain. Exits 7
 * (network) when the endpoint can't be reached, but still prints the report.
 */
export function registerVersionCommand(parent, cliVersion, getEndpoint) {
    parent
        .command("version")
        .description("Show the local CLI version + the deployed iB version (commit SHA + slot) at the active endpoint")
        .action(async () => {
        const endpoint = await getEndpoint();
        const report = await runVersion({ endpoint, cliVersion });
        writeJson(report);
        if (!report.reachable)
            process.exit(7);
    });
}
//# sourceMappingURL=index.js.map