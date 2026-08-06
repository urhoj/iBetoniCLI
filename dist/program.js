/**
 * Builds the wired `ib` Commander program.
 *
 * Extracted from `bin/ib.ts` so the command tree — including the rich `--help`
 * wiring — is importable by tests without triggering argv parsing. `bin/ib.ts`
 * is now just a thin shell: build, then `parseAsync`.
 *
 * WHICH commands get registered depends on the argv hint — see `domains.ts`.
 * Only `reference` and `commands` are wired here, because they close over this
 * function's helpers rather than living in a `commands/<domain>` module.
 */
import { Command, Help } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { addGlobalOptions, getGlobalOptions } from "./globals.js";
import { defaultCredentialsPath } from "./auth/store.js";
import { createCliContext } from "./cliContext.js";
import { recordFriction } from "./friction.js";
import { DOMAIN_REGISTRARS, resolveArgvDomain } from "./domains.js";
import { runReferenceDump, fetchPrimerGlossary } from "./reference/dump.js";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList, runReferenceDetailEdit, runReferenceDetailDelete, runReferenceDetailLint } from "./reference/detail.js";
import { addEditFlags, parseEditOp } from "./textEdit.js";
import { addWriteFlagsToCommand, requireReason } from "./api/writeFlags.js";
import { assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "./assess.js";
import { buildCommandsList, buildDomainIndex, fullyHiddenDomains, assertKnownDomain } from "./reference/commandsList.js";
import { renderDomainHelp } from "./reference/domain.js";
import { attachRichHelp, firstSentence } from "./output/help.js";
import { COMMAND_SPECS } from "./reference/specs.js";
import { canonicalPath } from "./reference/aliasPaths.js";
import { writeJson, exitWithError, failWith, failUsage, emitStdout, emitStderr, writeErrorEnvelope, setActiveCommandErrors, setExitCode as setExit, errorMessage } from "./output/json.js";
import { guarded, jsonAction } from "./commands/_shared/action.js";
import { buildValidationEnvelope } from "./output/validationEnvelope.js";
import { buildUnknownCommandEnvelope, buildUnknownOptionEnvelope, buildExcessArgumentsEnvelope, dateFlagSuggestion, excessPositionals, commandPath } from "./output/unknownCommand.js";
import { getEmbeddedCtx } from "./embedded.js";
import { CliError } from "./api/errors.js";
import { getCallerTier } from "./tier.js";
/**
 * Construct the `ib` program with rich (`CommandSpec`-driven) `--help` attached.
 * Does not parse argv.
 *
 * `argv` is a HINT (the caller's arguments, without node/script): when its first
 * bare token names a known domain, only that domain's modules are imported and
 * registered — the rest of the ~40 command modules are never loaded. Omit it, or
 * pass an argv that starts with a flag or names something unknown, and the whole
 * tree is registered as before; every surface that needs all the commands (root
 * help, unknown-command siblings) is reached only through that path. Tests and
 * library callers that want the full tree simply omit the argument.
 */
export async function buildProgram(argv) {
    const program = new Command();
    program
        .name("ib")
        .description("iBetoni CLI — AI-driven command-line interface for betoni.online and betoniJerry")
        .version(packageJson.version);
    // Domain primer (what betoni.online is + glossary) on the root `--help`, so an
    // AI inspecting top-level help gets the same context `ib reference dump`
    // embeds. Sourced from reference/domain.ts — one source of truth, no drift.
    program.addHelpText("after", () => renderDomainHelp());
    // Root command list is a table of contents: first sentence only (same
    // truncation formatGroupHelp applies to group listings); the full
    // description stays in each command's `--help`.
    // The root command has no CommandSpec, so `attachRichHelp` does not override
    // its help — Commander's DEFAULT listing renders ALL registered subcommands,
    // including developer-only groups (ai/schema/changelog) that are hidden at
    // standard tier. Override `visibleCommands` so fully-hidden SPEC domains drop
    // from the "Commands:" section at render time. Meta commands (commands,
    // reference, help, doctor, version, auth) and partial domains are never in
    // `fullyHiddenDomains`, so they stay; at developer tier the set is empty →
    // identical to today (no snapshot drift).
    program.configureHelp({
        subcommandDescription: (cmd) => firstSentence(cmd.description()),
        visibleCommands(cmd) {
            const hidden = fullyHiddenDomains(getCallerTier());
            return Help.prototype.visibleCommands
                .call(this, cmd)
                .filter((sub) => !hidden.has(sub.name()));
        },
    });
    addGlobalOptions(program);
    // The acting context of this invocation: the parsed root globals, plus the
    // EMBEDDED caller's identity when this process is serving an in-process
    // `/api/cli/exec` call. This is the ONE place `getEmbeddedCtx()` is consulted,
    // and every factory below resolves through it — so `getClient`,
    // `getClientForAsiakas`, `getEndpoint` and `isReadOnly` all act with the
    // caller's endpoint / token / write-lock. (Only `getClient` used to special-
    // case the embedded context, which left an in-process call probing the
    // SERVER's endpoint, minting per-company clients from the SERVER's credentials
    // file, and slipping past the `isReadOnly()` gate.)
    //
    // Embedded values WIN over argv: the endpoint is the server's own base URL, so
    // an argv `--endpoint` from a remote caller cannot redirect their JWT to a host
    // of their choosing, and the write-lock can only be tightened. `quiet` is
    // forced because the acting-as write diagnostic writes to `process.stderr` —
    // the HOST's, which the embedded caller never sees.
    function invocation() {
        const global = getGlobalOptions(program);
        const emb = getEmbeddedCtx();
        if (!emb)
            return { global };
        return {
            global: {
                ...global,
                endpoint: emb.endpoint,
                readOnly: global.readOnly || emb.readOnly,
                quiet: true,
            },
            embeddedToken: emb.token,
        };
    }
    // One CLI context per distinct company lens, memoized for the invocation.
    // Building it reads+parses the credentials file and decodes the JWT, and under
    // `--company <id>` it mints an ephemeral switch JWT via a NETWORK POST — so a
    // command needing both a client and the endpoint (e.g. `ib doctor`) otherwise
    // paid for all of that twice, including a redundant round-trip. Keyed by
    // `asiakas` because `getClientForAsiakas` deliberately wants a different
    // context per target company.
    const ctxCache = new Map();
    function contextFor(inv) {
        const key = inv.global.asiakas ?? null;
        let pending = ctxCache.get(key);
        if (!pending) {
            pending = createCliContext({
                credentialsPath: defaultCredentialsPath(),
                version: packageJson.version,
                global: inv.global,
                embeddedToken: inv.embeddedToken,
            });
            ctxCache.set(key, pending);
        }
        return pending;
    }
    // Build an authenticated client from a resolved invocation. Exits 2 with
    // "Not logged in" when no auth resolves — so command actions never deal with
    // the unauthenticated case. The two factories below differ only in the
    // invocation they pass in.
    async function clientFrom(inv) {
        const ctx = await contextFor(inv);
        if (!ctx.client) {
            // throw (not process.exit) — safe post-fetch on Windows; lands in the
            // action's exitWithError catch (or the bin catch) as envelope + exit 2.
            failWith("Not logged in. Run `ib auth login` first.", 2);
        }
        return ctx.client;
    }
    const getClient = () => clientFrom(invocation());
    // A client bound to a SPECIFIC company via an ephemeral switch (never
    // persisted). Reuses the same tested switch path and inherits
    // read-only/endpoint/version — and, in embedded mode, derives from the
    // caller's JWT. Powers `person search --my-companies` fan-out.
    const getClientForAsiakas = (asiakasId) => {
        const inv = invocation();
        return clientFrom({ ...inv, global: { ...inv.global, asiakas: asiakasId } });
    };
    // Resolve the active endpoint WITHOUT requiring auth — `createCliContext`
    // returns a usable `endpoint` (--endpoint → active profile → default) even
    // when no credentials resolve. Powers `ib version`, which queries the public
    // `/api/version` and so must work logged out.
    async function getEndpoint() {
        return (await contextFor(invocation())).endpoint;
    }
    // Disable Commander's built-in `help` command so `ib help [topic]` can
    // register our own offline concept-guide action without conflict.
    // `ib --help` (the --help OPTION) is unaffected and still renders the domain
    // primer via `program.addHelpText("after", renderDomainHelp())` above.
    program.helpCommand(false);
    // Session write-lock resolver, evaluated at action time (after argv parse).
    // Passed to commands that mutate OUTSIDE the API client (persisted company
    // switch) so read-only mode covers them too, and to `doctor` for reporting.
    const isReadOnly = () => invocation().global.readOnly;
    // Load + register the domains this invocation needs — one of them when argv
    // names a known command, otherwise all of them. `DOMAIN_REGISTRARS` iterates
    // in registration order, which is what `ib --help` lists.
    const deps = {
        getClient,
        getClientForAsiakas,
        isReadOnly,
        getEndpoint,
        version: packageJson.version,
    };
    const selected = resolveArgvDomain(argv);
    for (const [domain, register] of DOMAIN_REGISTRARS) {
        if (selected === null || selected === domain)
            await register(program, deps);
    }
    const reference = program
        .command("reference")
        .description("Reference / meta commands (machine-readable CLI catalogue)");
    reference
        .command("dump")
        .argument("[domain...]", "Restrict the commands map to one or more domains — the token after `ib` (e.g. keikka). Multiple domains share a single primer.")
        .option("--glossary", "Include the term+synonyms vocabulary index (DB fetch). Off by default to keep the dump small; look up definitions on demand with `ib glossary lookup`/`list`")
        .option("--commands-only", "Emit only { version, generatedAt, commonErrors, commands } — drop the overview/topics/feedbackGuidance primer (and skip the glossary fetch)")
        .option("--lean", "Drop each command's notes/seeAlso prose (keeps examples) — ~7.6k fewer tokens on the full surface; fetch the dropped prose per-command via `ib <command> --help`")
        .action(guarded(async (domains, opts) => {
        let glossary = [];
        // The glossary is now OPT-IN: only fetch it when --glossary is asked
        // for (and never under --commands-only, which has no primer). The
        // fetch is this command's only network call, so the default dump is
        // also offline + token-free.
        if (opts.glossary && !opts.commandsOnly) {
            try {
                glossary = await fetchPrimerGlossary(await getClient());
            }
            catch {
                glossary = [];
            }
        }
        runReferenceDump(domains, getCallerTier(), glossary, opts.commandsOnly ?? false, opts.lean ?? false);
    }));
    // `detail` is a PURE GROUP (no action of its own) with three explicit leaves.
    // A variadic action on the group AND `list`/`set` subcommands would make
    // commander mis-route `ib reference detail keikka list` to the `list` leaf —
    // so the read is an explicit `get <command...>` leaf instead.
    const detail = reference
        .command("detail")
        .description("On-demand command catalog: get/set business-context detail + summary, or list entries (DB-backed)");
    detail
        .command("get")
        .argument("<command...>", "Command path after `ib` (e.g. keikka latest)")
        .action(jsonAction(getClient, (client, commandParts) => runReferenceDetail(client, commandParts)));
    addNeedsReviewFlags(detail
        .command("list")
        .option("--stalest <n>", "Return up to N entries sorted by least-recently reviewed", (v) => Number(v))
        .option("--domain <d>", "Only commands in this ib domain (e.g. attachment) — narrows BEFORE --stalest")
        .option("--with-detail", "Include each entry's full detail text, folding the per-command `reference detail get` into one call (needs the backend deployed)")
        .option("--search <substr>", "Only rows whose command PATH contains this substring (case-insensitive; client-side)")
        .option("--orphans", "Only orphan rows — keys whose command no longer exists in the live catalogue (the discover half of discover→`reference detail delete`)")).action(guarded(async (opts) => {
        // Validate the domain offline (exit 4 on unknown) before any network call,
        // mirroring `ib commands <domain>`.
        if (opts.domain)
            assertKnownDomain(COMMAND_SPECS, opts.domain);
        const client = await getClient();
        writeJson(await runReferenceDetailList(client, opts));
    }));
    const detailSet = detail
        .command("set")
        .argument("<command...>", "Command path after `ib` (e.g. keikka latest)")
        .option("--summary <text>", "Short one-line summary stored in the catalog")
        .option("--detail <text>", "Full markdown business-context detail")
        .option("--field <name>", "Edit-mode target field: summary | detail (default detail)");
    addEditFlags(detailSet);
    addWriteFlagsToCommand(addAssessWriteFlags(detailSet)).action(guarded(async (commandParts, opts) => {
        const editOp = parseEditOp(opts);
        if (opts.field !== undefined && !editOp) {
            failUsage("--field only applies in edit mode (--replace / --append / --prepend)");
        }
        if (editOp) {
            if (opts.summary !== undefined || opts.detail !== undefined) {
                failUsage("edit mode (--replace/--append/--prepend) cannot be combined with --summary/--detail");
            }
            const field = (opts.field ?? "detail");
            if (field !== "summary" && field !== "detail") {
                failUsage("--field must be one of: summary, detail");
            }
            requireReason(opts, { allowDryRun: true });
            try {
                const client = await getClient();
                writeJson(await runReferenceDetailEdit(client, commandParts, field, editOp, opts));
            }
            catch (e) {
                exitWithError(e);
            }
            return;
        }
        assertAiConfidence(opts.aiConfidence);
        const client = await getClient();
        const result = await runReferenceDetailSet(client, commandParts, { summary: opts.summary, detail: opts.detail, aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview }, opts);
        writeJson(result);
    }));
    // `delete` — prune one catalog row by its EXACT key. Deliberately NOT gated by
    // the command registry (unlike get/set): its purpose is removing orphans whose
    // command path no longer resolves. --reason required for a real delete.
    const detailDelete = detail
        .command("delete")
        .argument("<command...>", "The exact stored command key after `ib` (e.g. ai conversation)");
    addWriteFlagsToCommand(detailDelete).action(guarded(async (commandParts, opts) => {
        requireReason(opts, { allowDryRun: true });
        const client = await getClient();
        writeJson(await runReferenceDetailDelete(client, commandParts, opts));
    }));
    // `lint` — audit the catalog for orphan rows (keys with no live command left
    // by a rename/re-home). Read-only (one GET + local diff); --strict is a CI gate.
    detail
        .command("lint")
        .option("--strict", "Exit 1 if any orphan row exists (for CI)")
        .action(guarded(async (opts) => {
        const res = await runReferenceDetailLint(await getClient());
        writeJson(res);
        if (opts.strict && res.items.length > 0)
            process.exitCode = 1;
    }));
    // `ib commands` — filtered, offline discovery over the same spec catalogue.
    // Note: the filter is `--reads` (not `--read-only`) because `--read-only` is
    // a GLOBAL write-lock flag; reusing the name here would be ambiguous.
    program
        .command("commands")
        .argument("[domain]", "Only commands in this domain — the token after `ib` (e.g. keikka)")
        .option("--mutations", "Only commands that write (carry write-safety flags)")
        .option("--reads", "Only read-only commands (no writes)")
        .option("--permission <substr>", "Only commands whose required permissions contain this substring")
        .option("--all", "Full flat list of every command (default is the domain index)")
        .action(guarded((domain, opts) => {
        // Bare `ib commands` = cheap domain index; any narrowing argument
        // (domain, filter flag, or explicit --all) = flat leaf list.
        const wantsFlatList = opts.all || domain || opts.mutations || opts.reads || opts.permission !== undefined;
        writeJson(wantsFlatList
            ? buildCommandsList({
                domain,
                mutations: opts.mutations,
                reads: opts.reads,
                permission: opts.permission,
            })
            : buildDomainIndex());
    }));
    // Replace each subcommand's `--help` with its rich CommandSpec rendering.
    attachRichHelp(program, COMMAND_SPECS);
    return program;
}
/**
 * Resolve the running command's `CommandSpec.errors` and stash them so error
 * envelopes can echo the command's OWN documented remedy as `hint` (feedback
 * #25). Walks the command up its `.parent` chain to reconstruct the full
 * space-joined command path, matches it against {@link COMMAND_SPECS}, and
 * sets the active errors (`null` when no spec matches → generic hints only).
 *
 * Shared by `bin/ib.ts` and `runArgv` so both resolve hints identically — the
 * path-join logic must NOT drift between the two entry points.
 */
export function applySpecErrors(actionCommand) {
    // canonicalPath so invoking a back-compat alias still resolves the command's
    // OWN documented remedies; without it hintForError fell back to the generic
    // per-status hint on every aliased path.
    const path = canonicalPath(commandPath(actionCommand));
    const spec = COMMAND_SPECS.find((s) => s.command === path);
    setActiveCommandErrors(spec?.errors ?? null);
}
export function enableParserThrow(program) {
    let captured = "";
    let erroringCmd = null;
    const output = {
        writeErr: (s) => {
            captured += s;
        },
        // Commander writes --help / --version display through writeOut. Route it
        // through the ctx-aware emitStdout so in-process (embedded) `ib … --help`
        // is captured into ctx.stdout instead of leaking to the real stdout. In
        // normal CLI mode emitStdout falls back to process.stdout — unchanged.
        writeOut: (s) => {
            emitStdout(s);
        },
    };
    const walk = (cmd) => {
        // A callback that closes over `cmd` captures WHICH command threw, then
        // throws (Windows-safe: never reaches Commander's internal process.exit).
        cmd.exitOverride((err) => {
            erroringCmd = cmd;
            throw err;
        });
        cmd.configureOutput(output);
        cmd.commands.forEach(walk);
    };
    walk(program);
    return { parserText: () => captured, erroringCommand: () => erroringCmd };
}
function isCommanderError(err) {
    return (typeof err === "object" &&
        err !== null &&
        typeof err.code === "string" &&
        err.code.startsWith("commander."));
}
function missingMandatoryOptions(cmd) {
    const missing = [];
    for (let c = cmd; c; c = c.parent) {
        for (const option of c.options) {
            if (option.mandatory && c.getOptionValue(option.attributeName()) === undefined) {
                missing.push(option.flags);
            }
        }
    }
    return missing;
}
/** Extract the long flag from a Commander flags string: `-t, --type <t>` → `--type`. */
function longFlag(flags) {
    const m = flags.match(/--[a-zA-Z0-9][\w-]*/);
    return m ? m[0] : flags.split(/\s+/)[0];
}
/**
 * Terminal path shared by every `commander.*` usage-error branch below: emit the
 * envelope on stderr, record the friction, exit 4. The friction string is what
 * was DISPLAYED (error + hint), not Commander's bare internal message — the
 * groomer only sees this log, and a bare `unknown command 'x'` reads as "no
 * pointer was given" (fb#275).
 */
function emitUsageEnvelope(err, env) {
    writeErrorEnvelope(env, 4);
    recordFriction(err, 4, `${env.error} — ${env.hint}`);
    setExit(4);
}
/**
 * Terminal handler for `program.parseAsync(...).catch(...)`. Never calls
 * `process.exit()` (Windows-unsafe post-fetch) — sets `process.exitCode` and
 * lets the loop drain. Routing:
 *
 *  - CliError (failWith guards / global-option validation thrown outside any
 *    action try-block) → stderr envelope + its mapped exit code.
 *  - Commander help/version display (exitCode 0) → pass any captured text
 *    through, exit 0.
 *  - `commander.help` (help auto-rendered for a bare `ib` / bare group, exit
 *    1) → pass the captured help text through unchanged, keep exit 1 — that
 *    output is help, not an error.
 *  - Any other commander.* (unknown command/flag, missing argument/option,
 *    excess args) → JSON envelope with code "USAGE" and exit 4 (validation):
 *    usage errors ARE validation errors, and agents get one uniform error
 *    surface.
 *  - Anything else → plain message, exit 1 (unexpected runtime failure).
 */
export function handleParseRejection(err, parserText, erroringCommand) {
    if (err instanceof CliError) {
        exitWithError(err);
        return;
    }
    if (isCommanderError(err)) {
        const text = parserText();
        if (err.exitCode === 0 || err.code === "commander.help") {
            if (text)
                emitStderr(text);
            setExit(err.exitCode ?? 0);
            return;
        }
        // Unknown subcommand → enriched envelope: siblings + did-you-mean (#1).
        if (err.code === "commander.unknownCommand" && erroringCommand) {
            const cmd = erroringCommand();
            if (cmd) {
                const token = (Array.isArray(cmd.args) && cmd.args[0]) ||
                    text.match(/unknown command '([^']+)'/)?.[1] ||
                    "";
                return emitUsageEnvelope(err, buildUnknownCommandEnvelope(cmd, token, getCallerTier()));
            }
        }
        if (err.code === "commander.missingMandatoryOptionValue" && erroringCommand) {
            const cmd = erroringCommand();
            const missing = cmd ? missingMandatoryOptions(cmd) : [];
            // Emit the PRESCRIPTIVE envelope for any number of missing required flags
            // (previously only for >1): the caller gets every missing flag, its allowed
            // values (from the command spec), and a copy-paste sample in ONE response —
            // no `--help` round-trip, even for a single omitted flag (feedback #204).
            if (cmd && missing.length) {
                const path = commandPath(cmd);
                // Look the spec up by canonical path (so an alias still gets its allowed
                // values + sample), but keep `path` as INVOKED for the envelope — the
                // caller should see back the command they actually ran.
                const spec = COMMAND_SPECS.find((s) => s.command === canonicalPath(path));
                const problems = missing.map((f) => ({
                    flag: longFlag(f),
                    issue: "missing",
                }));
                const envelope = buildValidationEnvelope(path, problems, { spec });
                // Commander reports the missing flag BEFORE excess positionals, so a
                // caller who made both mistakes at once would never see the date hint
                // (feedback #328 follow-up — same masking shape as fb#309). Fold it in
                // rather than making them fix one error to discover the next.
                const dateHint = dateFlagSuggestion(cmd, excessPositionals(cmd));
                if (dateHint) {
                    const base = (envelope.hint ?? "").trim().replace(/[.\s]*$/, "");
                    envelope.hint = `${base}. Also: a surplus positional looks like a date — pass it as \`${dateHint}\`, not as a positional.`;
                }
                return emitUsageEnvelope(err, envelope);
            }
        }
        // Unknown option → enriched envelope: the command's real positionals + flags,
        // a fuzzy did-you-mean among its actual flags, and any curated cross-command
        // redirect (feedback #235/#236 — the flag analogue of the unknown-command path).
        if (err.code === "commander.unknownOption" && erroringCommand) {
            const cmd = erroringCommand();
            const token = text.match(/unknown option '([^']+)'/)?.[1] ||
                err.message?.match(/unknown option '([^']+)'/)?.[1] ||
                "";
            if (cmd && token) {
                return emitUsageEnvelope(err, buildUnknownOptionEnvelope(cmd, token));
            }
        }
        const detail = (text || err.message || "usage error")
            .replace(/^error:\s*/gm, "")
            .trim();
        // Excess positionals → name what was probably meant. Chiefly a date typed
        // positionally on an `<id> --date` command (feedback #328); Commander's own
        // message lists the surplus tokens but never points at the flag.
        if (err.code === "commander.excessArguments" && erroringCommand) {
            const cmd = erroringCommand();
            if (cmd) {
                const excess = excessPositionals(cmd);
                if (excess.length) {
                    return emitUsageEnvelope(err, buildExcessArgumentsEnvelope(cmd, excess, detail));
                }
            }
        }
        const genericHint = "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands";
        return emitUsageEnvelope(err, {
            success: false,
            error: detail,
            code: "USAGE",
            statusCode: 0,
            hint: genericHint,
        });
    }
    const message = errorMessage(err);
    recordFriction(err, 1);
    emitStderr(`${message}\n`);
    setExit(1);
}
//# sourceMappingURL=program.js.map