#!/usr/bin/env node
import {
  buildProgram,
  enableParserThrow,
  handleParseRejection,
  applySpecErrors,
} from "../program.js";
import { getGlobalOptions } from "../globals.js";
import { setOutputMode } from "../output/json.js";
import { resolveAuth } from "../auth/resolve.js";
import { defaultCredentialsPath } from "../auth/store.js";
import { setCallerTier, resolveCallerTier } from "../tier.js";

const program = buildProgram();

// Throw-instead-of-exit for the parser (usage errors become the JSON envelope
// in handleParseRejection; help/version pass through) + capture its stderr.
const { parserText, erroringCommand } = enableParserThrow(program);

program.hook("preAction", (_thisCommand, actionCommand) => {
  if (getGlobalOptions(program).pretty) setOutputMode("pretty");
  // Resolve the running command's CommandSpec so error envelopes can echo ITS
  // documented per-error remedy as `hint` (feedback #25). Shared with runArgv.
  applySpecErrors(actionCommand);
});

// Resolve the caller's visibility tier from the session token BEFORE parse so
// discovery (`ib commands`, `ib reference dump`, root primer) renders at the
// caller's tier. Fail-closed: any resolution failure → "standard" (privileged
// subtrees hidden).
let resolvedAuth: Awaited<ReturnType<typeof resolveAuth>> = null;
try {
  resolvedAuth = await resolveAuth({ credentialsPath: defaultCredentialsPath() });
  setCallerTier(resolveCallerTier(resolvedAuth?.token ?? null));
} catch {
  setCallerTier("standard");
}

// Best-effort prefetch the DB glossary for root `ib --help` / bare `ib` so
// `renderDomainHelp` can include the GLOSSARY section. Scoped to root help
// only — subcommand/group help renders from bundled specs and gains nothing.
// All failures are swallowed: offline, tokenless, or backend-down still
// renders `--help` correctly (GLOSSARY section simply omitted).
const wantsRootHelp =
  process.argv.length <= 2 ||
  (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2]!));
if (wantsRootHelp && resolvedAuth?.token) {
  try {
    const [{ createApiClient }, { runGlossaryList }, { setHelpGlossary }, { projectGlossaryForPrimer }] =
      await Promise.all([
        import("../api/client.js"),
        import("../commands/glossary/index.js"),
        import("../reference/domain.js"),
        import("../reference/dump.js"),
      ]);
    const client = createApiClient({
      endpoint: resolvedAuth.endpoint,
      token: resolvedAuth.token,
      version: program.version() ?? "0.0.0",
      readOnly: true,
    });
    const res = await runGlossaryList(client, {});
    setHelpGlossary(
      projectGlossaryForPrimer(res.items as Array<Record<string, unknown>>)
    );
  } catch {
    // Glossary unavailable — root help renders without the GLOSSARY section.
  }
}

program
  .parseAsync(process.argv)
  .catch((err) => handleParseRejection(err, parserText, erroringCommand));
