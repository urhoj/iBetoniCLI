import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CliError, errorMessage, exitCodeForError } from "./api/errors.js";
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
/**
 * Row lifetimes, enforced at capture time (the only moment guaranteed to run
 * on every harness — the stop gate only exists on some).
 *
 * UNCLAIMED: `sid: null` rows — plain shell, cron, or a harness with no stop
 * gate. No gate ever fires for them (the gate reports but never deletes rows
 * it does not own), so nothing else drains them and they accumulate forever
 * unless expired here. A week is ample for a human or a triage routine to spot
 * a genuine pattern.
 *
 * STALE: hard cap for EVERY row, claimed or not. A session that dies without
 * releasing leaves its rows unreleasable by anyone else (the gate withholds
 * foreign rows by design); without a ceiling those leak forever too.
 */
const UNCLAIMED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Explicit opt-out for DELIBERATE negative-path invocations (feedback #313).
 *
 * A run of error-message probes files nothing but noise: one reported session
 * logged 24 entries of which all 24 were intentional (`keikka nosuch`,
 * `--bogus-flag`, …), every one exiting exactly as designed, yet the stop gate
 * still demanded triage. The VITEST guard below covers the test suite; this
 * covers everything else, and it has to exist because the case is NOT
 * test-runner-only — two captured entries came from interactive shell probes
 * run to verify hint routing after a spec change.
 *
 * Set `IB_FRICTION_OFF=1` (or true/yes) around a batch of deliberate failures.
 */
function frictionDisabled() {
    return ["1", "true", "yes"].includes(String(process.env.IB_FRICTION_OFF ?? "").toLowerCase());
}
/**
 * Which actor captured this entry. The log file is machine-GLOBAL (one
 * `~/.ibetoni/cli-friction.jsonl` per box) but it is drained by a per-session
 * stop gate, so without an owner stamp the draining session both mis-attributes
 * foreign rows to itself AND destroys them before their own actor ever sees
 * them (feedback #312). Each agent harness exports its own session id into
 * every child process — Claude Code `CLAUDE_CODE_SESSION_ID`, Qwen Code
 * `QWEN_CODE_SESSION_ID`, Codex `CODEX_SESSION_ID` — so take the first one
 * present: a session from ANY harness must own (and be able to release) its
 * rows. Stamping only the Claude var left every Qwen/Codex capture unclaimed,
 * and no gate ever fired for those rows, so they accumulated forever.
 * `null` when `ib` runs outside an agent session (a shell, a cron routine) —
 * the gate reports a null-owner row but never deletes it; the age-out below
 * eventually clears it, since no gate will ever fire for it either.
 */
function sessionId() {
    for (const name of [
        "CLAUDE_CODE_SESSION_ID",
        "QWEN_CODE_SESSION_ID",
        "CODEX_SESSION_ID",
    ]) {
        const sid = process.env[name];
        if (typeof sid === "string" && sid.length > 0)
            return sid;
    }
    return null;
}
function frictionDir() {
    return join(homedir(), ".ibetoni");
}
export function frictionPath() {
    return join(frictionDir(), "cli-friction.jsonl");
}
/**
 * @param curatedHint the error was answered by a remedy the COMMAND owns — a
 *   matching spec ERRORS row, or one attached at the throw site (see
 *   `hintDetailForError`'s `source`). Only meaningful for exit 5; see the
 *   not-found skip below.
 */
export function recordFriction(err, exitCodeOverride, displayed, curatedHint = false) {
    try {
        if (getEmbeddedCtx())
            return; // real local CLI only
        if (frictionDisabled())
            return; // deliberate negative-path run
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
        // A not-found the command ANTICIPATED is not friction — it is evidence the
        // command works (feedback #579). `ib betoni laatu get 2` exits 5 with the
        // command's own remedy ("list the catalogue with `ib betoni laatu list`");
        // capturing that blocked the stop gate and cost a triage round to reach the
        // conclusion the gate's own instructions already prescribe ("skip expected
        // 404s"). Moving that filter from triage time to capture time is free.
        //
        // NARROW BY DESIGN: only exit 5, and only with a COMMAND-OWNED remedy. An
        // undeployed route (`ROUTE_NOT_FOUND`) or an unclassified 404 falls through
        // and is still captured — those are the wrong-path / deploy-gate cases,
        // where a 404 is the symptom rather than the answer.
        if (exitCode === 5 && curatedHint)
            return;
        const argv = process.argv.slice(2).join(" ").slice(0, 400);
        // `displayed` is what the caller actually SAW (enriched envelope error +
        // hint) — prefer it over the raw internal err.message so the groom step
        // never files "the error gave no pointer" for a hint that WAS shown
        // (feedback #275: the show→get did-you-mean existed, but the log recorded
        // Commander's bare `unknown command 'show'` and a groomer re-requested it).
        const message = (displayed ?? errorMessage(err)).slice(0, 400);
        const code = err instanceof CliError && err.body && typeof err.body === "object"
            ? (err.body.code ?? null)
            : null;
        const statusCode = err instanceof CliError ? err.statusCode : 0;
        const entry = {
            ts: new Date().toISOString(),
            sid: sessionId(),
            argv,
            exitCode,
            statusCode,
            code,
            message,
        };
        const p = frictionPath();
        let lines = [];
        try {
            lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
        }
        catch {
            /* first write — file does not exist yet */
        }
        // Collapse a REPEAT of the same (argv, exitCode, message) by the same actor
        // into a count rather than a new row (feedback #313: three identical probe
        // rounds turned 8 distinct failures into 24 entries). Matching on `sid` too
        // keeps the ownership stamp intact — one session must not fold, and thereby
        // adopt, another's row (feedback #312). Unparseable lines are left verbatim:
        // never destroy a row we don't understand.
        const parsed = lines.map((line) => {
            try {
                return { line, obj: JSON.parse(line) };
            }
            catch {
                return { line, obj: null };
            }
        });
        // Age out rows no gate can ever drain (see the TTL constants): unclaimed
        // rows after UNCLAIMED_TTL_MS, any row after STALE_ROW_TTL_MS. Done here —
        // before dedupe — so an expired row is never revived by a repeat collapse.
        // A row with no parseable timestamp is kept: never destroy what we cannot
        // date (same discipline as the unparseable-line rule above).
        const now = Date.now();
        const rows = parsed.filter(({ obj }) => {
            if (!obj)
                return true;
            // `ts` is the current field; `at` is the pre-rename shape some logged
            // rows still carry — accept both so those rows expire like any other.
            const raw = typeof obj.ts === "string"
                ? obj.ts
                : typeof obj.at === "string"
                    ? obj.at
                    : "";
            const at = Date.parse(raw);
            if (!Number.isFinite(at))
                return true;
            if (now - at >= STALE_ROW_TTL_MS)
                return false;
            return obj.sid !== null || now - at < UNCLAIMED_TTL_MS;
        });
        const dup = rows.find(({ obj }) => obj &&
            obj.argv === entry.argv &&
            obj.exitCode === entry.exitCode &&
            obj.message === entry.message &&
            (obj.sid ?? null) === entry.sid);
        if (dup?.obj) {
            dup.obj.count = (typeof dup.obj.count === "number" ? dup.obj.count : 1) + 1;
            dup.obj.lastTs = entry.ts;
            dup.line = JSON.stringify(dup.obj);
        }
        else {
            rows.push({ line: JSON.stringify(entry), obj: entry });
        }
        lines = rows.map((r) => r.line);
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