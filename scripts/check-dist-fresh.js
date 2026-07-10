/**
 * check-dist-fresh — fail when the committed dist/ has drifted from src/.
 *
 * betonicli ships a COMMITTED dist/: the vendored puminet5api submodule
 * (MCP ib_exec, /api/cli/exec, /ai) and the npm bin run dist/bin/ib.js
 * directly — deploys never build. So a src-only commit silently never ships
 * (feedback #135: the nested-subgroup fix sat unbuilt across two commits;
 * gap filed as #136). This check compiles src/ to a temp dir at the SAME
 * depth as dist/ (sourcemap relative paths stay byte-equal — .gitattributes
 * pins eol=lf, so the compare is deterministic across Windows/Linux) and
 * byte-compares the two trees.
 *
 * Drift classes:
 *   STALE    — src changed, dist not rebuilt (the #135 class)
 *   UNBUILT  — fresh build emits a file dist/ lacks (new module, never built)
 *   ORPHANED — dist/ has a file a fresh build no longer emits (deleted src;
 *              tsc never cleans outDir — `npm run build` now rm -rf's dist
 *              first via prebuild, so a rebuild fixes all three classes)
 *
 * Usage: npm run check:dist — exit 1 on drift. Wired into CI in place of the
 * bare build step (it compiles the same tsconfig, so it subsumes it).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const freshDir = path.join(root, ".distcheck");

/** Relative (posix-style) paths of every file under dir. */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).replaceAll("\\", "/"));
  }
  return out.sort();
}

fs.rmSync(freshDir, { recursive: true, force: true });
try {
  // --outDir on the CLI overrides tsconfig's "./dist". .distcheck sits at repo
  // root so ../src sourcemap paths match the committed maps byte-for-byte.
  execSync("npx tsc -p tsconfig.json --outDir .distcheck", {
    cwd: root,
    stdio: "inherit",
  });

  const fresh = walk(freshDir);
  const dist = fs.existsSync(distDir) ? walk(distDir) : [];
  const distSet = new Set(dist);
  const freshSet = new Set(fresh);

  const unbuilt = fresh.filter((f) => !distSet.has(f));
  const orphaned = dist.filter((f) => !freshSet.has(f));
  const stale = fresh.filter(
    (f) =>
      distSet.has(f) &&
      !fs
        .readFileSync(path.join(freshDir, f))
        .equals(fs.readFileSync(path.join(distDir, f)))
  );

  if (stale.length || unbuilt.length || orphaned.length) {
    const report = [
      ["STALE (src changed, dist not rebuilt)", stale],
      ["UNBUILT (fresh build emits it, dist lacks it)", unbuilt],
      ["ORPHANED (in dist, no longer built from src)", orphaned],
    ]
      .filter(([, files]) => files.length)
      .map(
        ([label, files]) =>
          `  ${label}:\n${files.map((f) => `    dist/${f}`).join("\n")}`
      )
      .join("\n");
    console.error(
      `dist/ has drifted from src/ — a src-only commit silently never ships:\n${report}\n` +
        "Fix: npm run build (cleans dist/ first), then commit the dist/ changes."
    );
    process.exitCode = 1; // never process.exit() — Windows-unsafe convention
  } else {
    console.log(
      `check:dist OK — dist/ matches a fresh build (${fresh.length} files)`
    );
  }
} finally {
  fs.rmSync(freshDir, { recursive: true, force: true });
}
