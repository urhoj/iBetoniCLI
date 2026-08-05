import { failUsage } from "./output/json.js";
import { lineDiff } from "./textDiff.js";
/**
 * Register the five in-field edit flags on an edit-capable command. The flag
 * NAMES are the contract (`parseEditOp`, `unknownCommand.ts`, the help-wiring
 * tests); these descriptions never reach a leaf `--help`, which renders from the
 * CommandSpec — so one canonical wording serves all three commands.
 */
export function addEditFlags(cmd) {
    return cmd
        .option("--replace <text>", "Edit mode: replace this literal text in the target field (exactly once unless --all)")
        .option("--with <text>", 'Replacement for --replace ("" deletes the matched text)')
        .option("--append <text>", "Edit mode: append text to the target field (verbatim)")
        .option("--prepend <text>", "Edit mode: prepend text to the target field (verbatim)")
        .option("--all", "With --replace: substitute every occurrence");
}
/** Count non-overlapping occurrences of a literal `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
    if (needle === "")
        return 0;
    let count = 0;
    let i = haystack.indexOf(needle);
    while (i !== -1) {
        count++;
        i = haystack.indexOf(needle, i + needle.length);
    }
    return count;
}
/**
 * Apply one in-field edit, returning the new field value. `current` is coerced
 * from null/undefined to "". Throws failWith(exit 4) when a replace breaks the
 * strict match rule (0 matches; >1 and not `all`). append/prepend insert the
 * given text VERBATIM (no separator — the caller controls whitespace).
 */
export function applyTextEdit(current, op) {
    const base = current ?? "";
    switch (op.kind) {
        case "append":
            return { next: base + op.text };
        case "prepend":
            return { next: op.text + base };
        case "replace": {
            const n = countOccurrences(base, op.find);
            if (n === 0) {
                failUsage("--replace search text not found in the current field", "read the current field first — the search text must match it verbatim; or use --append/--prepend");
            }
            if (n > 1 && !op.all) {
                failUsage(`--replace matched ${n} times; pass --all or narrow the search`);
            }
            return { next: base.split(op.find).join(op.replacement), matchCount: n };
        }
    }
}
/**
 * Map raw edit flags → at most one TextEditOp. Returns undefined when no edit
 * flag is present (the command falls back to its existing whole-body behaviour).
 * Enforces: at most one of --replace/--append/--prepend; --with required iff
 * --replace; --with/--all without --replace → exit 4.
 */
export function parseEditOp(flags) {
    const kinds = [];
    if (flags.replace !== undefined)
        kinds.push("replace");
    if (flags.append !== undefined)
        kinds.push("append");
    if (flags.prepend !== undefined)
        kinds.push("prepend");
    if (kinds.length === 0) {
        if (flags.with !== undefined)
            failUsage("--with requires --replace");
        if (flags.all)
            failUsage("--all only applies with --replace");
        return undefined;
    }
    if (kinds.length > 1) {
        failUsage(`pass only one of --replace / --append / --prepend (got ${kinds.join(", ")})`);
    }
    if (flags.replace !== undefined) {
        if (flags.with === undefined) {
            failUsage('--replace requires --with <text> (use --with "" to delete the match)');
        }
        return { kind: "replace", find: flags.replace, replacement: flags.with, all: !!flags.all };
    }
    if (flags.all)
        failUsage("--all only applies with --replace");
    if (flags.append !== undefined)
        return { kind: "append", text: flags.append };
    return { kind: "prepend", text: flags.prepend };
}
/**
 * The client-side `--dry-run` result every edit-capable command returns: the
 * caller's identity keys naming the edited row (`{ command }` / `{ helpId }` /
 * `{ type }`), the field, the replace match count, and the line diff. Nothing is
 * written, so this works under `--read-only`.
 */
export function textEditDryRunEnvelope(before, next, matchCount, identity, field) {
    const diff = lineDiff(before, next);
    return {
        dryRun: true,
        ...identity,
        field,
        ...(matchCount !== undefined ? { matchCount } : {}),
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        sameContent: diff.sameContent,
        unified: diff.unified,
    };
}
//# sourceMappingURL=textEdit.js.map