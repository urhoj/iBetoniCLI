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
const parserText = enableParserThrow(program);

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
try {
  const auth = await resolveAuth({ credentialsPath: defaultCredentialsPath() });
  setCallerTier(resolveCallerTier(auth?.token ?? null));
} catch {
  setCallerTier("standard");
}

program
  .parseAsync(process.argv)
  .catch((err) => handleParseRejection(err, parserText));
