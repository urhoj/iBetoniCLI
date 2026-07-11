/**
 * `ib reference dump` — emits the entire CLI command surface as a single JSON
 * document.
 *
 * The dump is what an AI assistant ingests once at session start to know every
 * command, flag, permission, output shape, error code, and example. The same
 * {@link CommandSpec} objects back the `--help` text rendered by
 * `src/output/help.ts`, so the JSON dump and the human help can never drift
 * out of sync — there is exactly one source of truth (`./specs.ts`).
 */
import { COMMAND_SPECS, COMMON_AUTH_ERRORS } from "./specs.js";
import { specMatcherForToken } from "./commandsList.js";
import { DOMAIN_OVERVIEW, FEEDBACK_GUIDANCE, TOPICS, } from "./domain.js";
import { visibleSpecs, isHiddenAtTier } from "../tier.js";
import { emitStdout } from "../output/json.js";
import packageJson from "../../package.json" with { type: "json" };
import { runGlossaryList, projectGlossaryForPrimer } from "../commands/glossary/index.js";
export { projectGlossaryForPrimer };
/**
 * For a non-developer tier, strip cross-references (seeAlso / notes / examples)
 * that name a command hidden at that tier — otherwise the dump's prose teaches a
 * standard caller that the hidden subtrees exist (the dump filters WHICH specs
 * appear, but emits each visible spec's prose verbatim, and ~10 of those strings
 * cross-reference hidden command paths). Developer tier: spec returned unchanged
 * (byte-for-byte parity). `hiddenCommands` are full paths (e.g. `ib ai
 * conversation`), matched as substrings of the backtick-quoted mentions.
 * Only the prose arrays (`seeAlso`/`notes`/`examples`) are scrubbed; `description`
 * and `flags` don't embed backtick command paths in practice.
 */
function scrubSpecForTier(spec, tier, hiddenCommands) {
    if (tier === "developer")
        return spec;
    const mentionsHidden = (s) => hiddenCommands.some((h) => s.includes(h));
    const out = { ...spec };
    if (spec.seeAlso)
        out.seeAlso = spec.seeAlso.filter((r) => !mentionsHidden(r));
    if (spec.notes)
        out.notes = spec.notes.filter((n) => !mentionsHidden(n));
    if (spec.examples)
        out.examples = spec.examples.filter((e) => !mentionsHidden(e));
    return out;
}
/**
 * Best-effort fetch of the DB glossary projected to the primer shape
 * ({term,synonyms} only — strips definition and developer-tier-leaking fields).
 * Returns [] on any failure (offline/tokenless/route-not-deployed). Shared by
 * the root `--help` prefetch (bin/ib.ts) and the `reference dump` action.
 */
export async function fetchPrimerGlossary(client) {
    try {
        const res = await runGlossaryList(client, {});
        return projectGlossaryForPrimer(res.items);
    }
    catch {
        return [];
    }
}
/** True when an error row is one of the hoisted `commonErrors` (401/500). */
function isCommonError(e) {
    return COMMON_AUTH_ERRORS.some((c) => c.http === e.http &&
        c.exit === e.exit &&
        c.meaning === e.meaning &&
        c.remedy === e.remedy);
}
/**
 * Drop the universal 401/500 rows from a spec's `errors` (they're emitted once
 * as the dump's top-level `commonErrors`). Returns the spec unchanged when it
 * carried none, so specs with only command-specific errors are untouched.
 */
function stripCommonErrors(spec) {
    const filtered = (spec.errors ?? []).filter((e) => !isCommonError(e));
    if (filtered.length === (spec.errors?.length ?? 0))
        return spec;
    return { ...spec, errors: filtered };
}
/**
 * Lean mode (`--lean`): drop the per-spec `notes` and `seeAlso` prose. These
 * are the largest low-essential fields across the full surface (~30 KB / ~7.6k
 * tok); `examples` stay because they are invocation-critical (copy-paste
 * correctness). For a whole-surface scan an AI wants what exists + how to call
 * each command; the dropped caveats/cross-references are still one
 * `ib <command> --help` (or a per-domain dump) away when it actually invokes.
 */
function stripProse(spec) {
    if (spec.notes == null && spec.seeAlso == null)
        return spec;
    const out = { ...spec };
    delete out.notes;
    delete out.seeAlso;
    return out;
}
/**
 * Build the reference object. Pure — no I/O — so tests can assert on it
 * directly. Commands are keyed by their full path (e.g. `ib keikka list`),
 * matching what an AI assistant sees from `--help`. When one or more `domain`s
 * are given, the commands map is narrowed to those groups (the token after
 * `ib`) while the primer (overview/glossary/topics/feedbackGuidance) is kept in
 * full — it is small, high-value context that keeps a filtered dump
 * self-contained, and emitted ONCE no matter how many domains are passed (so
 * `dump ai attachment` beats two single-domain dumps). Each `domain` may be a
 * top-level domain OR a bare nested-subgroup alias (`changelog` → `dev
 * changelog`), resolved via {@link specMatcherForToken} exactly like `ib
 * commands` (feedback #137). Unknown domain → exit-4 CliError. At a
 * non-developer tier each surviving
 * spec's prose is run through `scrubSpecForTier` so no cross-reference leaks a
 * hidden command path.
 */
export function buildReference(domain, tier = "developer", glossary = [], lean = false) {
    let specs = visibleSpecs(COMMAND_SPECS, tier);
    const domains = domain == null ? [] : Array.isArray(domain) ? domain : [domain];
    if (domains.length) {
        // Resolve each token the same way `ib commands` does — a top-level domain OR
        // a bare nested-subgroup alias (e.g. `changelog` → `dev changelog`), so
        // `reference dump changelog` mirrors `ib commands changelog` (feedback #137).
        // Unknown token still throws exit-4 via the shared resolver.
        const matchers = domains.map((d) => specMatcherForToken(COMMAND_SPECS, d, tier));
        specs = specs.filter((s) => matchers.some((m) => m(s)));
    }
    const hiddenCommands = COMMAND_SPECS.filter((s) => isHiddenAtTier(s, tier)).map((s) => s.command);
    // The `notice` steer rides only on the FULL surface (no domain filter) — a
    // filtered dump is already the cheap path, so it needs no nudge.
    const notice = domains.length === 0
        ? `Full command surface (${specs.length} commands) — large. For one area prefer \`ib reference dump <domain>\`${lean ? "" : " (or add `--lean` to drop per-command notes/seeAlso)"}; \`ib commands\` lists the domains. \`commonErrors\` applies to every command.${lean ? " LEAN: notes/seeAlso dropped — see `ib <command> --help` for those." : ""}`
        : undefined;
    return {
        version: packageJson.version,
        generatedAt: new Date().toISOString(),
        commonErrors: COMMON_AUTH_ERRORS,
        ...(notice ? { notice } : {}),
        overview: DOMAIN_OVERVIEW,
        glossary,
        feedbackGuidance: FEEDBACK_GUIDANCE,
        topics: TOPICS,
        commands: Object.fromEntries(specs.map((spec) => {
            let s = stripCommonErrors(scrubSpecForTier(spec, tier, hiddenCommands));
            if (lean)
                s = stripProse(s);
            return [spec.command, s];
        })),
    };
}
/**
 * Write the reference dump as SINGLE-LINE JSON to stdout (the CLI's stdout
 * contract: one machine-parseable line). Used by the `ib reference dump`
 * subcommand (optionally narrowed to one or more `domain`s). Pretty-printing was
 * dropped 2026-06-10: it was ~30% of the dump's bytes (pure indentation) and
 * pushed the customer domain over the 10k-token audit threshold.
 *
 * `commandsOnly` strips the primer (overview/glossary/topics/feedbackGuidance)
 * and emits only `{ version, generatedAt, commonErrors, commands }` — the
 * static discovery scaffolding is pure overhead for a caller (e.g. the
 * optimize-ib-summaries cron) that already knows the domain context and just
 * needs the command specs. `commonErrors` is RETAINED (it is not part of the
 * primer): each spec's `errors` has had the universal 401/500 stripped, so the
 * contract must travel with the commands map or it would be lost. The caller
 * also skips the glossary DB fetch in that mode (no token needed), so this is
 * both fewer bytes and one fewer round-trip.
 *
 * `lean` drops each spec's `notes`/`seeAlso` (kept `examples`) — composes with
 * `commandsOnly` and domain filters; see {@link stripProse}.
 */
export function runReferenceDump(domain, tier = "developer", glossary = [], commandsOnly = false, lean = false) {
    const ref = buildReference(domain, tier, glossary, lean);
    const out = commandsOnly
        ? {
            version: ref.version,
            generatedAt: ref.generatedAt,
            commonErrors: ref.commonErrors,
            commands: ref.commands,
        }
        : ref;
    emitStdout(JSON.stringify(out) + "\n");
}
//# sourceMappingURL=dump.js.map