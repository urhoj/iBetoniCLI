/**
 * check-invocation — refuse to build/test this checkout when the invocation
 * cannot produce trustworthy evidence.
 *
 * Two environment faults, both of which report GREEN against code you did not
 * edit, or fail while naming the wrong cause:
 *
 * 1. THE VENDORED COPY (feedback #651). betonicli is vendored into puminet5api
 *    as a nested submodule (`"@ibetoni/cli": "file:./betonicli"`), so a
 *    relative `npm --prefix betonicli …` / `git -C betonicli …` issued from a
 *    shell whose cwd has drifted into puminet5api resolves THAT copy — a real
 *    package with the same name and a real git repo, so nothing errors. It
 *    happened for real on 2026-08-16: 164 test files / 3377 tests passed and
 *    check:dist reported "dist/ matches a fresh build", all of it against the
 *    untouched vendored src while the edited file sat in code/betonicli. The
 *    vendored dist/ is what SHIPS and only ever arrives via the CI pointer
 *    bump, so this copy is consumed, never built in place.
 *
 * 2. A WORKTREE WITH NO node_modules (feedback #653). Deps are not fully
 *    hoisted: betonicli/node_modules holds the handful whose version differs
 *    from the workspace root (chalk ^6 here vs 4.1.2 there). A worktree
 *    without its own node_modules resolves the WRONG major through Node's
 *    upward walk, and tsc then blames a source file — `src/output/pretty.ts:
 *    Namespace 'chalk' has no exported member 'default'` — which reads as a
 *    bug in the file you are probably editing at the time. Testing for
 *    node_modules at all, rather than for one known package, keeps this guard
 *    true as the dependency set drifts.
 *
 * Wired into pretest / prebuild / pretype-check / precheck:dist — the four
 * commands whose green output is the evidence these two faults falsify.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** package.json `name` of dir, or null when there is no readable manifest. */
function packageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
}

function refuse(what, why) {
  console.error(`[betonicli] refusing to run — ${what}\n${why}`);
  process.exitCode = 1;
}

// Checked FIRST on purpose: a vendored copy with no node_modules satisfies BOTH
// tests, and "you are in the vendored copy" is the actionable fault of the two —
// reversing the order would answer it with the junction advice instead.
if (packageName(path.dirname(root)) === "puminet5api") {
  refuse(
    `this is the VENDORED copy (${root})`,
    "It is consumed, never built in place: its dist/ arrives via the CI pointer bump.\n" +
      "Building or testing here proves nothing about the checkout you edited.\n" +
      "Use a cwd-independent invocation from the workspace root instead:\n" +
      "  npm run <script> --workspace=betonicli"
  );
} else if (!fs.existsSync(path.join(root, "node_modules"))) {
  refuse(
    `${root} has no node_modules/`,
    "Node would resolve deps by walking UP to the workspace root, which carries a\n" +
      "different major for some of them — tsc then blames a source file for what is\n" +
      "an environment fault.\n" +
      "  fresh checkout → run `npm install` from the workspace root\n" +
      "  git worktree   → junction its node_modules to the submodule's own copy:\n" +
      "    New-Item -ItemType Junction -Path <worktree>\\node_modules -Target <repo>\\betonicli\\node_modules"
  );
}
