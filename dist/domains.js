import { GLOBAL_VALUE_FLAGS } from "./globals.js";
import { DEV_ALIAS_DOMAINS } from "./reference/aliasPaths.js";
/**
 * The `ib dev` groups. Each is registered twice — canonically under `ib dev`
 * and, driven by `DEV_ALIAS_DOMAINS`, as a hidden top-level back-compat alias —
 * so both uses load through one loader per group. `ib dev` additionally owns
 * `impersonation`, which never had a top-level path.
 */
const DEV_GROUP_LOADERS = {
    feedback: async () => (await import("./commands/feedback/index.js")).registerFeedbackCommands,
    changelog: async () => (await import("./commands/changelog/index.js")).registerChangelogCommands,
    perf: async () => (await import("./commands/perf/index.js")).registerPerfCommands,
    cache: async () => (await import("./commands/cache/index.js")).registerCacheCommands,
    schema: async () => (await import("./commands/schema/index.js")).registerSchemaCommands,
    ai: async () => (await import("./commands/ai/index.js")).registerAiCommands,
    inbox: async () => (await import("./commands/inbox/index.js")).registerInboxCommand,
};
/**
 * First argv token → the modules that token needs. Insertion order is
 * registration order (Map preserves it), so this doubles as the full-build
 * sequence and the selective-build lookup.
 */
export const DOMAIN_REGISTRARS = new Map([
    // `auth` manages credential-store access directly (login/logout/whoami/etc.)
    // and so doesn't take a `getClient` factory.
    ["auth", async (p, d) => (await import("./commands/auth/index.js")).registerAuthCommands(p, d.isReadOnly)],
    // `help` — concept guides + DB glossary fallback. Registered before
    // authenticated commands so the spec catalogue and wiring tests can find it.
    ["help", async (p, d) => (await import("./commands/help/index.js")).registerHelpCommands(p, d.getClient)],
    ["company", async (p, d) => (await import("./commands/company/index.js")).registerCompanyCommands(p, d.getClient, d.isReadOnly)],
    ["fennoa", async (p, d) => (await import("./commands/fennoa/index.js")).registerFennoaCommands(p, d.getClient)],
    ["validate", async (p, d) => (await import("./commands/validate/index.js")).registerValidateCommands(p, d.getClient)],
    ["keikka", async (p, d) => (await import("./commands/keikka/index.js")).registerKeikkaCommands(p, d.getClient)],
    ["betoni", async (p, d) => (await import("./commands/betoni/index.js")).registerBetoniCommands(p, d.getClient)],
    ["customer", async (p, d) => (await import("./commands/customer/index.js")).registerCustomerCommands(p, d.getClient)],
    ["worksite", async (p, d) => (await import("./commands/worksite/index.js")).registerWorksiteCommands(p, d.getClient)],
    ["person", async (p, d) => (await import("./commands/person/index.js")).registerPersonCommands(p, d.getClient, d.getClientForAsiakas)],
    ["vehicle", async (p, d) => (await import("./commands/vehicle/index.js")).registerVehicleCommands(p, d.getClient)],
    ["notification", async (p, d) => (await import("./commands/notification/index.js")).registerNotificationCommands(p, d.getClient)],
    ["sijainti", async (p, d) => (await import("./commands/sijainti/index.js")).registerSijaintiCommands(p, d.getClient)],
    ["ohje", async (p, d) => (await import("./commands/ohje/index.js")).registerOhjeCommands(p, d.getClient)],
    ["legal", async (p, d) => (await import("./commands/legal/index.js")).registerLegalCommands(p, d.getClient)],
    ["jerry", async (p, d) => (await import("./commands/jerry/index.js")).registerJerryCommands(p, d.getClient)],
    ["message", async (p, d) => (await import("./commands/message/index.js")).registerMessageCommands(p, d.getClient)],
    ["schedule", async (p, d) => (await import("./commands/schedule/index.js")).registerScheduleCommands(p, d.getClient)],
    ["stats", async (p, d) => (await import("./commands/stats/index.js")).registerStatsCommands(p, d.getClient)],
    ["log", async (p, d) => (await import("./commands/log/index.js")).registerLogCommands(p, d.getClient)],
    // `ib opendata` (canonical) houses building + weather + prh. The top-level
    // `ib weather` is kept as a HIDDEN back-compat alias (runtime-only; absent
    // from spec-driven discovery and root --help).
    ["opendata", async (p, d) => (await import("./commands/opendata/index.js")).registerOpendataCommands(p, d.getClient)],
    ["weather", async (p, d) => (await import("./commands/weather/index.js")).registerWeatherCommands(p, d.getClient, { hidden: true })],
    ["glossary", async (p, d) => (await import("./commands/glossary/index.js")).registerGlossaryCommands(p, d.getClient)],
    ["task", async (p, d) => (await import("./commands/task/index.js")).registerTaskCommands(p, d.getClient)],
    ["search", async (p, d) => (await import("./commands/search/index.js")).registerSearchCommands(p, d.getClient)],
    ["attachment", async (p, d) => (await import("./commands/attachment/index.js")).registerAttachmentCommands(p, d.getClient)],
    ["version", async (p, d) => (await import("./commands/version/index.js")).registerVersionCommand(p, d.version, d.getEndpoint)],
    ["doctor", async (p, d) => (await import("./commands/doctor/index.js")).registerDoctorCommand(p, d.getClient, d.getEndpoint, d.version, d.isReadOnly)],
    // `ib dev` — developer/maintainer meta umbrella. The 8 groups below are
    // canonical under `ib dev …`; their previous top-level paths stay registered
    // with { hidden: true } as runtime-only back-compat aliases (absent from
    // spec-driven discovery and root --help), mirroring `ib opendata`/`ib weather`.
    [
        "dev",
        async (p, d) => {
            const dev = p
                .command("dev")
                .description("Developer & maintainer tools — CLI feedback, changelog, perf, cache, schema, AI logs, operator inbox. Filing feedback is open to everyone.");
            // Narrow to the ONE group the invocation names (`ib dev changelog add`
            // needs changelog, not all seven — ~120 KB parsed per canonical dev
            // call). Anything else as the next token (absent, a flag, `--help`,
            // `impersonation`, an unknown group) falls back to the full family —
            // `ib dev --help` and the unknown-subcommand envelope need it.
            const next = d.argvRest[0];
            const names = DEV_ALIAS_DOMAINS.includes(next) ? [next] : DEV_ALIAS_DOMAINS;
            const groups = await Promise.all(names.map((name) => DEV_GROUP_LOADERS[name]()));
            for (const register of groups)
                register(dev, d.getClient);
            (await import("./commands/dev/impersonation/index.js")).registerImpersonationCommands(dev, d.getClient);
            // Same shape as impersonation: canonical only under `ib dev`, no hidden
            // top-level alias (it never had a top-level path).
            (await import("./commands/dev/db-target/index.js")).registerDbTargetCommands(dev, d.getClient);
            // Same shape again: canonical only under `ib dev`, no top-level alias.
            (await import("./commands/dev/email-health/index.js")).registerEmailHealthCommand(dev, d.getClient);
        },
    ],
    // Hidden back-compat aliases at the old top-level paths (still executable).
    // Driven by DEV_ALIAS_DOMAINS so the alias set has ONE definition — the same
    // table `canonicalPath` uses to resolve those paths back to their specs.
    // (`dev impersonation` is deliberately absent: it never had a top-level path.)
    ...DEV_ALIAS_DOMAINS.map((name) => [
        name,
        (async (p, d) => (await DEV_GROUP_LOADERS[name]())(p, d.getClient, { hidden: true })),
    ]),
]);
/**
 * Root subcommands wired inline in `program.ts` (they need its closures, not a
 * domain module), so they are always present and select no dynamic import.
 * Listed here so `resolveArgvDomain` still recognises them as known tokens —
 * `ib commands keikka` must not fall back to loading every domain.
 */
export const STATIC_DOMAIN_TOKENS = new Set(["reference", "commands"]);
/**
 * The domain an argv is asking for, or `null` to build the whole tree.
 *
 * Scans past the root flags to the first bare token: a value-taking global
 * (`--endpoint <url>`) also swallows the token after it, unless it was written
 * `--flag=value`. Returns `null` — i.e. register everything — for an empty or
 * flag-only argv, for a bare `-`/`--`, and for any token that is not a known
 * root command, because those are exactly the shapes whose output depends on
 * the full tree (root help, unknown-command siblings).
 */
export function resolveArgvDomain(argv) {
    return scanArgv(argv)?.token ?? null;
}
/**
 * The argv tokens after the resolved domain token — what {@link DomainDeps}
 * `argvRest` carries. `[]` when no domain resolves (full build).
 */
export function argvRestAfterDomain(argv) {
    return scanArgv(argv)?.rest ?? [];
}
/** The one scan behind {@link resolveArgvDomain} and {@link argvRestAfterDomain}. */
function scanArgv(argv) {
    if (!argv)
        return null;
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === "-" || token === "--")
            return null;
        if (!token.startsWith("-")) {
            return DOMAIN_REGISTRARS.has(token) || STATIC_DOMAIN_TOKENS.has(token)
                ? { token, rest: argv.slice(i + 1) }
                : null;
        }
        if (!token.includes("=") && GLOBAL_VALUE_FLAGS.has(token))
            i++;
    }
    return null;
}
//# sourceMappingURL=domains.js.map