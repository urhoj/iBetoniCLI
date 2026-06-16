/**
 * Minimal line-level text diff for `ib legal diff`.
 *
 * The point is AI-ergonomics: comparing two legal-document bodies (each up to
 * ~10 KB) by pulling BOTH into the agent's context and eyeballing them is
 * token-expensive and error-prone. Instead the CLI computes the diff locally and
 * returns only the changed hunks + counts — the agent sees the change, not the
 * two blobs.
 *
 * LCS over lines (classic DP), then a unified-style render with bounded context;
 * long unchanged runs collapse to a `… (N unchanged lines) …` marker so the
 * output stays small even when the documents are large and mostly identical.
 */
/** Longest-common-subsequence op stream between two line arrays. */
function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    // dp[i][j] = LCS length of a[i:] and b[j:]
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ kind: " ", line: a[i] });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ kind: "-", line: a[i] });
            i++;
        }
        else {
            ops.push({ kind: "+", line: b[j] });
            j++;
        }
    }
    while (i < n)
        ops.push({ kind: "-", line: a[i++] });
    while (j < m)
        ops.push({ kind: "+", line: b[j++] });
    return ops;
}
const CONTEXT = 3;
/**
 * Compute a line diff of `a` (old) vs `b` (new).
 * @param a Old text.
 * @param b New text.
 */
export function lineDiff(a, b) {
    if (a === b)
        return { addedLines: 0, removedLines: 0, sameContent: true, unified: "" };
    const ops = lcsOps(a.split("\n"), b.split("\n"));
    const addedLines = ops.filter((o) => o.kind === "+").length;
    const removedLines = ops.filter((o) => o.kind === "-").length;
    // Collapse runs of unchanged lines longer than 2*CONTEXT down to a head +
    // marker + tail so big-but-mostly-same documents stay compact.
    const out = [];
    let run = []; // pending unchanged lines
    const flushRun = (atStart, atEnd) => {
        if (run.length === 0)
            return;
        if (run.length <= 2 * CONTEXT) {
            out.push(...run.map((l) => `  ${l}`));
        }
        else {
            const head = atStart ? [] : run.slice(0, CONTEXT);
            const tail = atEnd ? [] : run.slice(-CONTEXT);
            const hidden = run.length - head.length - tail.length;
            out.push(...head.map((l) => `  ${l}`));
            out.push(`… (${hidden} unchanged lines) …`);
            out.push(...tail.map((l) => `  ${l}`));
        }
        run = [];
    };
    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        if (op.kind === " ") {
            run.push(op.line);
        }
        else {
            flushRun(out.length === 0, false);
            out.push(`${op.kind} ${op.line}`);
        }
    }
    flushRun(out.length === 0, true);
    return { addedLines, removedLines, sameContent: false, unified: out.join("\n") };
}
//# sourceMappingURL=textDiff.js.map