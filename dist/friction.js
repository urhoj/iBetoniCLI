import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CliError, exitCodeForError } from "./api/errors.js";
import { getEmbeddedCtx } from "./embedded.js";
/**
 * Local, best-effort capture of CLI friction so it lands in the `ib feedback`
 * loop WITHOUT relying on the AI remembering to file mid-flow.
 *
 * Every non-zero exit is appended to ~/.ibetoni/cli-friction.jsonl (a bounded
 * ring buffer). A groom step — the session-stop gate or a cron — reads it,
 * clusters/dedupes, files the genuine patterns via `ib dev feedback create`,
 * then clears the log. Mirrors the glossary-miss → groom-ib-glossary pattern
 * (raw capture is cheap; FILING is curated, so per-typo noise never reaches the
 * sink).
 *
 * LOCAL CLI ONLY: skipped in the embedded/exec path (server-side MCP/exec is a
 * different process with a different profile, and its errors are not the user's
 * local friction). NEVER throws — recording friction must never break the
 * command it is recording.
 */
const FRICTION_CAP = 300;
function frictionDir() {
    return join(homedir(), ".ibetoni");
}
export function frictionPath() {
    return join(frictionDir(), "cli-friction.jsonl");
}
export function recordFriction(err, exitCodeOverride, displayed) {
    try {
        if (getEmbeddedCtx())
            return; // real local CLI only
        // Never write from the test suite — vitest exercises writeError() in many
        // command tests, which would spam the real ~/.ibetoni log. The friction
        // test re-enables via IB_FRICTION_TEST against a temp HOME.
        if (process.env.VITEST && !process.env.IB_FRICTION_TEST)
            return;
        // Parser/USAGE errors know their code at the call site (Commander errors
        // don't map through exitCodeForError); everything else derives it.
        const exitCode = exitCodeOverride ?? exitCodeForError(err);
        if (!exitCode)
            return; // 0 / success is never friction
        const argv = process.argv.slice(2).join(" ").slice(0, 400);
        // `displayed` is what the caller actually SAW (enriched envelope error +
        // hint) — prefer it over the raw internal err.message so the groom step
        // never files "the error gave no pointer" for a hint that WAS shown
        // (feedback #275: the show→get did-you-mean existed, but the log recorded
        // Commander's bare `unknown command 'show'` and a groomer re-requested it).
        const message = (displayed ?? (err instanceof Error ? err.message : String(err))).slice(0, 400);
        const code = err instanceof CliError && err.body && typeof err.body === "object"
            ? (err.body.code ?? null)
            : null;
        const statusCode = err instanceof CliError ? err.statusCode : 0;
        const entry = JSON.stringify({
            ts: new Date().toISOString(),
            argv,
            exitCode,
            statusCode,
            code,
            message,
        });
        const p = frictionPath();
        let lines = [];
        try {
            lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
        }
        catch {
            /* first write — file does not exist yet */
        }
        lines.push(entry);
        if (lines.length > FRICTION_CAP)
            lines = lines.slice(-FRICTION_CAP);
        try {
            mkdirSync(frictionDir(), { recursive: true });
        }
        catch {
            /* dir already exists */
        }
        writeFileSync(p, lines.join("\n") + "\n", { mode: 0o600 });
    }
    catch {
        /* never break the CLI over friction bookkeeping */
    }
}
//# sourceMappingURL=friction.js.map