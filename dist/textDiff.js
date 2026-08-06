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
/**
 * LCS op stream over the arrays with their common head/tail already stripped.
 * The stripped runs re-enter as `" "` ops in {@link lcsOps}, so the caller sees
 * exactly the stream a full-array DP would produce (see the equivalence
 * argument there).
 */
function lcsOpsCore(a, b) {
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
/**
 * Longest-common-subsequence op stream between two line arrays.
 *
 * The DP is O(n·m) in TIME AND MEMORY, so running it over two whole documents
 * that differ by one line is the dominant cost of `ib legal diff` (9M cells /
 * ~140 ms at 3000 lines, ~1 s at 10k). Only the differing MIDDLE needs it: the
 * common head and tail are emitted directly as `" "` ops, which keeps the op
 * stream — and therefore the rendered diff — byte-identical. Both trims are
 * exact, for different reasons:
 *
 * - HEAD: the walk takes the `a[i] === b[j]` branch before ever consulting the
 *   DP, so it always consumes the common prefix as `" "` ops. Unconditional.
 * - TAIL: `LCS(X·S, Y·S) = LCS(X,Y) + |S|` (the last-characters-match LCS
 *   identity), so every dp value inside the middle is just shifted by |S| and
 *   the `dp[i+1][j] >= dp[i][j+1]` tie-breaks are unchanged. The one way the
 *   full walk can still diverge is by matching the tail's FIRST line against a
 *   middle line of the other side (`[A,B]` vs `[B,B]` renders `- A / B / + B`,
 *   not `- A / + B / B`) — so the tail is shrunk until that line appears in
 *   neither middle. Shrinking only ever re-admits a line already in the middle
 *   set, so the set stays complete as the loop runs.
 */
function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    let head = 0;
    while (head < n && head < m && a[head] === b[head])
        head++;
    let tail = 0;
    while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail])
        tail++;
    const middleLines = new Set();
    for (let i = head; i < n - tail; i++)
        middleLines.add(a[i]);
    for (let j = head; j < m - tail; j++)
        middleLines.add(b[j]);
    while (tail > 0 && middleLines.has(a[n - tail]))
        tail--;
    const ops = [];
    for (let i = 0; i < head; i++)
        ops.push({ kind: " ", line: a[i] });
    ops.push(...lcsOpsCore(a.slice(head, n - tail), b.slice(head, m - tail)));
    for (let i = n - tail; i < n; i++)
        ops.push({ kind: " ", line: a[i] });
    return ops;
}
const CONTEXT = 3;
/**
 * Compute a line diff of `a` (old) vs `b` (new).
 * @param a Old text.
 * @param b New text.
 */
export function lineDiff(a, b) {
    // Ignore a sole trailing newline: "x\n" vs "x" is not a meaningful legal-text
    // change, and split("\n") would otherwise emit a spurious empty ± line and
    // skew the counts. Internal line endings are left untouched.
    const aTrim = a.replace(/\r?\n$/, "");
    const bTrim = b.replace(/\r?\n$/, "");
    if (aTrim === bTrim)
        return { addedLines: 0, removedLines: 0, sameContent: true, unified: "" };
    const ops = lcsOps(aTrim.split("\n"), bTrim.split("\n"));
    let addedLines = 0;
    let removedLines = 0;
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
            if (op.kind === "+")
                addedLines++;
            else
                removedLines++;
            flushRun(out.length === 0, false);
            out.push(`${op.kind} ${op.line}`);
        }
    }
    flushRun(out.length === 0, true);
    return { addedLines, removedLines, sameContent: false, unified: out.join("\n") };
}
//# sourceMappingURL=textDiff.js.map