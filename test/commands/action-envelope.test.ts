/**
 * Structural invariant: EVERY Commander `.action()` routes its failures through
 * `exitWithError`.
 *
 * Why this is a test and not a convention: the exit-code contract in
 * betonicli/CLAUDE.md says "every error path emits the JSON envelope". An action
 * that throws without routing through `exitWithError` escapes to
 * `handleParseRejection`'s terminal branch in `program.ts`, which emits PLAIN
 * TEXT — so the caller (an AI or a CI job parsing stdout) gets something it
 * cannot parse, on the exact path where it most needs a structured error.
 *
 * That contract used to be upheld by ~300 hand-copied try/catch tails, i.e. by
 * discipline alone: a new command that forgot one broke it silently, and no test
 * noticed because the unit tests exercise the pure `run*` functions rather than
 * the action wiring. `jsonAction`/`guarded` (src/commands/_shared/action.ts) made
 * the tail reusable; this test makes it enforced.
 *
 * Uses the TypeScript AST rather than a regex because this invariant is meant to
 * be permanent — a regex over `.action(` would drift the first time someone
 * formats a call differently.
 */
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const COMMANDS_DIR = fileURLToPath(new URL("../../src/commands", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(full);
    }
    return entry.endsWith(".ts") ? [full] : [];
  });
}

/** True when `node` contains a catch clause anywhere beneath it. */
function hasCatch(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCatchClause(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Text of an in-file declaration of `name` (a local action factory, usually). */
function declarationText(sf: ts.SourceFile, name: string): string | null {
  let text: string | null = null;
  const visit = (n: ts.Node): void => {
    if (text !== null) return;
    if (
      (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === name
    ) {
      text = n.getText(sf);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return text;
}

/**
 * The contract is "a throw inside an action must not escape as plain text", so
 * the property checked is that failures are CONTAINED — not that a particular
 * helper was called. `ib auth login`/`logout`/`refresh` legitimately catch and
 * set `process.exitCode` directly instead of calling `exitWithError` (a
 * documented Windows/libuv constraint after the OAuth flow), and must pass.
 */
function routesErrors(arg: ts.Node, sf: ts.SourceFile): boolean {
  // 1. the shared wrappers
  if (
    ts.isCallExpression(arg) &&
    ts.isIdentifier(arg.expression) &&
    (arg.expression.text === "jsonAction" || arg.expression.text === "guarded")
  ) {
    return true;
  }
  // 2. an inline function that contains its own catch, or whose whole job is to
  //    hand a CliError to exitWithError (the renamed-command stubs).
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    return hasCatch(arg) || /\bexitWithError\s*\(/.test(arg.getText());
  }
  // 3. a local action factory, e.g. schema's `runOneOrBatch(runSchemaTable)` —
  //    resolve the callee in this file and check the factory itself contains the
  //    routing (its own catch, or one of the shared wrappers).
  const callee = ts.isCallExpression(arg) ? arg.expression : arg;
  if (ts.isIdentifier(callee)) {
    const decl = declarationText(sf, callee.text);
    return (
      decl !== null &&
      /\bcatch\s*\(|\bexitWithError\s*\(|\bguarded\s*\(|\bjsonAction\s*\(/.test(decl)
    );
  }
  return false;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function violationsIn(file: string): Violation[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const found: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "action" &&
      node.arguments.length > 0 &&
      !routesErrors(node.arguments[0], sf)
    ) {
      // Anchor on `.action`, not the start of the whole method chain.
      const { line } = sf.getLineAndCharacterOfPosition(node.expression.name.getStart(sf));
      found.push({
        file: file.slice(file.indexOf("src")).replace(/\\/g, "/"),
        line: line + 1,
        text: node.arguments[0].getText(sf).split("\n")[0].trim().slice(0, 90),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("Commander action error-envelope contract", () => {
  const files = sourceFiles(COMMANDS_DIR);

  test("the command tree is actually being scanned", () => {
    // Guards against the check silently passing because it found nothing.
    expect(files.length).toBeGreaterThan(30);
    const actions = files.reduce((n, f) => {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true);
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "action"
        ) count++;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return n + count;
    }, 0);
    expect(actions).toBeGreaterThan(250);
  });

  test("every .action() routes failures through exitWithError", () => {
    const violations = files.flatMap(violationsIn);
    const report = violations
      .map((v) => `  ${v.file}:${v.line}\n    ${v.text}`)
      .join("\n");
    expect(
      violations,
      violations.length
        ? `${violations.length} action(s) do not route errors, so a throw there emits PLAIN TEXT ` +
          `instead of the JSON envelope (see betonicli/CLAUDE.md exit-code contract).\n` +
          `Wrap the body in jsonAction()/guarded() from src/commands/_shared/action.js:\n${report}`
        : ""
    ).toEqual([]);
  });
});
