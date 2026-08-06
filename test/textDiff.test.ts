import { describe, test, expect } from "vitest";
import { lineDiff } from "../src/textDiff.js";

describe("lineDiff", () => {
  test("identical input -> sameContent, empty unified, zero counts", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual({
      addedLines: 0,
      removedLines: 0,
      sameContent: true,
      unified: "",
    });
  });

  test("counts added and removed lines and labels them", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(d.sameContent).toBe(false);
    expect(d.addedLines).toBe(2); // "B", "d"
    expect(d.removedLines).toBe(1); // "b"
    expect(d.unified).toContain("- b");
    expect(d.unified).toContain("+ B");
    expect(d.unified).toContain("+ d");
  });

  test("pure addition", () => {
    const d = lineDiff("a\nb", "a\nb\nc");
    expect(d).toMatchObject({ addedLines: 1, removedLines: 0, sameContent: false });
  });

  test("ignores a sole trailing newline (no spurious empty ± line)", () => {
    // "x\n" vs "x" must read as identical, not as a removed/added empty line.
    expect(lineDiff("a\nb\n", "a\nb")).toEqual({
      addedLines: 0,
      removedLines: 0,
      sameContent: true,
      unified: "",
    });
    expect(lineDiff("a\nb", "a\nb\n")).toMatchObject({ sameContent: true });
    // A real trailing-line difference (blank line in the middle) is still shown.
    const d = lineDiff("a\nb", "a\n\nb");
    expect(d.sameContent).toBe(false);
    expect(d.addedLines).toBe(1);
  });

  test("collapses long unchanged runs into a marker", () => {
    const base = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const d = lineDiff(base, `${base}\nNEW`);
    expect(d.addedLines).toBe(1);
    expect(d.unified).toContain("unchanged lines");
    expect(d.unified).toContain("+ NEW");
    // The collapsed output must be far smaller than echoing all 40 lines.
    expect(d.unified.split("\n").length).toBeLessThan(10);
  });
});

/**
 * Oracle for the head/tail trimming in `lcsOps`: the pre-trim implementation,
 * verbatim (full O(n·m) DP over both whole documents). The trim is a pure
 * speed-up, so every input must render byte-identically through both.
 */
function referenceLineDiff(a: string, b: string) {
  type Op = { kind: " " | "+" | "-"; line: string };
  const lcsOps = (x: string[], y: string[]): Op[] => {
    const n = x.length;
    const m = y.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { ops.push({ kind: " ", line: x[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: "-", line: x[i] }); i++; }
      else { ops.push({ kind: "+", line: y[j] }); j++; }
    }
    while (i < n) ops.push({ kind: "-", line: x[i++] });
    while (j < m) ops.push({ kind: "+", line: y[j++] });
    return ops;
  };
  const CONTEXT = 3;
  const aTrim = a.replace(/\r?\n$/, "");
  const bTrim = b.replace(/\r?\n$/, "");
  if (aTrim === bTrim) return { addedLines: 0, removedLines: 0, sameContent: true, unified: "" };
  const ops = lcsOps(aTrim.split("\n"), bTrim.split("\n"));
  const addedLines = ops.filter((o) => o.kind === "+").length;
  const removedLines = ops.filter((o) => o.kind === "-").length;
  const out: string[] = [];
  let run: string[] = [];
  const flushRun = (atStart: boolean, atEnd: boolean) => {
    if (run.length === 0) return;
    if (run.length <= 2 * CONTEXT) {
      out.push(...run.map((l) => `  ${l}`));
    } else {
      const head = atStart ? [] : run.slice(0, CONTEXT);
      const tail = atEnd ? [] : run.slice(-CONTEXT);
      out.push(...head.map((l) => `  ${l}`));
      out.push(`… (${run.length - head.length - tail.length} unchanged lines) …`);
      out.push(...tail.map((l) => `  ${l}`));
    }
    run = [];
  };
  for (const op of ops) {
    if (op.kind === " ") run.push(op.line);
    else { flushRun(out.length === 0, false); out.push(`${op.kind} ${op.line}`); }
  }
  flushRun(out.length === 0, true);
  return { addedLines, removedLines, sameContent: false, unified: out.join("\n") };
}

describe("lineDiff head/tail trim is output-identical to the full DP", () => {
  const doc = (n: number, mangle: (i: number) => string | null = () => null) =>
    Array.from({ length: n }, (_, i) => mangle(i) ?? `line ${i}`).join("\n");

  const cases: Array<[string, string, string]> = [
    ["identical", doc(50), doc(50)],
    ["both empty", "", ""],
    ["empty vs one line", "", "only"],
    ["one line vs empty", "only", ""],
    ["append at end", doc(50), `${doc(50)}\nNEW`],
    ["prepend at start", doc(50), `NEW\n${doc(50)}`],
    ["mid replace", doc(50), doc(50, (i) => (i === 25 ? "CHANGED" : null))],
    ["fully different", doc(30), doc(30, (i) => `other ${i}`)],
    ["collapse marker (40 lines + tail add)", doc(40), `${doc(40)}\nNEW`],
    ["short run (<= 2*CONTEXT unchanged)", "a\nb\nc\nd\ne\nf\ng", "X\nb\nc\nd\ne\nf\nY"],
    ["trailing newline only", "a\nb\n", "a\nb"],
    // The tail-trim hazard: the tail's first line also occurs in the middle.
    ["tail line repeats in the middle", "A\nB", "B\nB"],
    ["blank lines everywhere", "a\n\nb\n\nc", "a\n\nX\n\nc"],
    ["all-identical lines, different counts", "x\nx\nx", "x\nx\nx\nx"],
    ["head and tail both trimmable", `${doc(20)}\nMID\n${doc(20)}`, `${doc(20)}\nOTHER\n${doc(20)}`],
  ];

  for (const [name, a, b] of cases) {
    test(name, () => {
      expect(lineDiff(a, b)).toEqual(referenceLineDiff(a, b));
    });
  }

  test("randomized documents (blank + repeated lines) match the full DP", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20260806;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ["", "", "alpha", "beta", "gamma", "delta", "  ", "## Heading"];
    const randomDoc = () =>
      Array.from({ length: Math.floor(rnd() * 14) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("\n");
    for (let k = 0; k < 400; k++) {
      const a = randomDoc();
      const b = randomDoc();
      expect(lineDiff(a, b), `seedStep ${k}: ${JSON.stringify([a, b])}`).toEqual(referenceLineDiff(a, b));
    }
  });
});
