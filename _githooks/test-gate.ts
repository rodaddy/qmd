#!/opt/homebrew/opt/node@24/bin/node
/**
 * test-gate -- the server-side and pre-commit test rules (development#1239).
 *
 * WHY. Rico, 2026-10-13: "something that'll block a shit ton of stupid tests
 * from even being allowed to be fucking pushed or committed" and "we do
 * functional testing, we do not do coverage testing". The rule it enforces is
 * `_DOCS/CODING_STANDARDS.md` "## Testing", "Only useful inputs and outputs".
 * A Claude-only hook never ran in other repos or under Codex and Pi, so this
 * is one deterministic script for a required CI status and a git pre-commit
 * hook. It is copied into other repos as-is: node built-ins only.
 *
 * MODES (both run in the cwd's repo).
 *   --range <base> <head>  CI on a PR: the diff is `git diff <base>...<head>`,
 *                          the tree is <head>, the base budget is <base>.
 *   --staged               pre-commit: the diff is the index against HEAD, the
 *                          tree is the index, the base budget is HEAD.
 *
 * RULES. No environment variable, flag or comment bypasses any of them; only
 * Rico overrides, by admin merge, as his own call. No agent asks him for one,
 * and never to raise the budget.
 *   BUDGET_MISSING   `.test-budget` absent or not a non-negative integer
 *   BUDGET_EXCEEDED  test count > budget
 *   BUDGET_RAISED    the base had a budget and this one is higher. The budget is a ceiling that
 *                    only goes down (Rico, 2026-10-17): nobody asks Rico to raise it; a PR that adds a
 *                    test deletes a superfluous one in the same PR; slow or local-only tests live in
 *                    the gitignored tests/coverage/, and CI runs only the functional set
 *                    (`_DOCS/CODING_STANDARDS.md` "The test budget only goes down")
 *   BUDGET_STALE     test count < budget: lower the budget (the ratchet)
 *   FINDING_NAME     an added test or describe is named after an issue, a review or a pin
 *   SOURCE_AS_TEXT   a read call with an added line reads a `src/` file as text
 *   HIDDEN_TESTS     an added line in a JS/TS test file defines a test-registration shim: a loop
 *                    calling each element's function as a statement (`await c.fn(t)`, `fn(t)`), or,
 *                    beside such a loop, a `(name, fn)` function storing `fn` in a list or map;
 *                    a `{ name, input, expected }` table, or one asserting each `fn`'s result, is not one
 *   COVERAGE         coverage flags or config in YAML under .forgejo/, .github/ or a named config
 *   GITIGNORE        `.gitignore` ignores neither `tests/` nor `tests/coverage/` as a directory,
 *                    or a file under `tests/coverage/` is tracked
 *
 * test-audit.ts imports the rule definitions exported here; this file is the
 * one place each rule is written.
 *
 * Exit 0 pass (one stdout line), 1 violations (one stderr line each,
 * `test-gate: <RULE>: <detail>`), 3 harness error (a git call failed).
 */
import { spawnSync } from "node:child_process";

const BUDGET_FILE = ".test-budget";
const COVERAGE_DIR = "tests/coverage/";

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec"]);

/** A test file: under a test directory (any case, as Swift's `Tests/`), or named as one. */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => TEST_SEGMENTS.has(s.toLowerCase()))) return true;
  return /\.(test|spec)\./.test(name) || /_test\./.test(name) || /^test_.*\.py$/.test(name);
}

/** The generated coverage tree: never counted, never judged. */
export const isExcluded = (path: string): boolean => path.startsWith(COVERAGE_DIR);
const baseName = (path: string): string => path.split("/").pop() ?? "";

const LOCKFILES = new Set([
  "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "uv.lock",
  "poetry.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "Package.resolved", "composer.lock",
]);

/** A dependency lockfile, by name. */
export function isLockfile(path: string): boolean {
  return LOCKFILES.has(baseName(path));
}

const JS_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
/**
 * The name and modifiers of a JS/TS test or describe opener on a code line:
 * `test`, `it.only`, `test.each`, `describe.skip`. Matched on a line whose
 * strings are blanked and comments dropped (`jsCode`); `callOpen` finds the call.
 */
const JS_OPENER = /(?<![\w.$])(test|it|describe)((?:\.\w+)*)/g;
/** The only modifiers an opener may chain: `test.describe(`, `test.step(`, `test.beforeEach(` open no test. */
const MODIFIERS = new Set([
  "only", "skip", "todo", "each", "concurrent", "failing", "fails", "skipIf", "runIf", "sequential", "for", "if", "todoIf", "fixme",
]);
/**
 * A subtest: `t.test(`, `await t.test(`, `(t) => t.test(`, `if (c) t.test(`.
 * Counted where it starts a statement or an arrow, branch or case body, and
 * only with a function among its later arguments, so `if (re.test(s))`,
 * `assert.ok(RE.test("x"))` and `schema.test("x", opts)` stay uncounted.
 */
const JS_SUBTEST = /(?<![\w.$])[A-Za-z_$][\w$]*\.test((?:\.\w+)*)/g;
const SUBTEST_START = /(?:^|[;{})]|=>|\belse|\breturn|\bcase\b[^:]*:|\bdefault\s*:)\s*(?:(?:await|void)\s+)?$/;
/** A function-valued argument: an arrow, a `function`, or an identifier named as one (`fn`, `body`, `checkFn`, `c.fn`). */
const FN_ARG = /=>|^(?:async\s+)?function\b|^(?:[\w$]+\.)*(?:fn|run|body|impl|[\w$]*Fn)$/;

const PAIRS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/** The index of the bracket matching the `(`, `{` or `[` at `open` in `code`, or -1. */
function closeParen(code: string, open: number): number {
  const [o, c] = [code[open] as string, PAIRS[code[open] as string]];
  for (let i = open, depth = 0; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

/**
 * The index just past the call `(` of an opener whose name ends at `at`, or -1:
 * `test(`, a table `test.each(<balanced>)(` or `` test.each`..`( ``. A table
 * whose `(` or `` ` `` does not close on the line is the call itself, as a
 * multi-line `test.each([` is; its title is on the line closing the table.
 * An unclosed `` ` `` returns its own index, which `titleOf` reads no title
 * from, so a first table row holding a string is never judged as one.
 */
function callOpen(code: string, at: number): number {
  let k = at;
  if (code[k] === "(") {
    const close = closeParen(code, k);
    if (close === -1) return k + 1;
    const next = /^\s*\(/.exec(code.slice(close + 1));
    return next === null ? k + 1 : close + 1 + next[0].length;
  }
  if (code[k] === "`") {
    const close = code.indexOf("`", k + 1);
    if (close === -1) return k;
    k = close + 1;
  }
  const next = /^\s*\(/.exec(code.slice(k));
  return next === null ? -1 : k + next[0].length;
}
/** An opener starts a statement: nothing before it, or a `;`, `{` or `}`. */
const STATEMENT_START = /(^|[;{}])\s*$/;
/** One opener per line, capturing the test's function name. */
const NAMED_OPENERS: [RegExp, RegExp][] = [
  [/\.py$/, /^\s*(?:async\s+)?def (test_\w*)\(/],
  [/\.go$/, /^func (Test\w*)\(/],
];
/** A swift-testing `@Test` or `@Testing.Test` attribute, with or without arguments; never `@Tests`. */
const SWIFT_TEST = /(?<![\p{L}\p{N}_.$])@(?:Testing\.)?Test(?![\p{L}\p{N}_])/gu;
/**
 * The func an attribute attaches to, read from just past the attribute: only
 * whitespace, other attributes and modifiers may come between. Names may be
 * Unicode or a backticked raw identifier.
 */
const SWIFT_FUNC =
  /(?:\s|@[\p{L}_][\p{L}\p{N}_.]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?|\b(?:public|private|fileprivate|internal|open|static|class|final|nonisolated|mutating|override)\b)*func\s+(`[^`\n]*`|[\p{L}_][\p{L}\p{N}_]*)/uy;
/** A Swift string or extended regex opener: `"`, `"""`, `#"`, `#/`. A bare `/` is division. */
const SWIFT_LITERAL = /(#*)("""|"|\/)/y;
/** An XCTest method, after any attributes and the modifiers XCTest still runs: `@MainActor override func testA(`. */
const XCTEST_FUNC = /^\s*(?:@[\p{L}_][\p{L}\p{N}_.]*(?:\([^()]*\))?\s+|(?:public|open|internal|final|override|nonisolated)\s+)*func\s+(test[\p{L}\p{N}_]*)\s*\(/u;
/** `#[test]`, `#[tokio::test]`, `#[tokio::test(flavor = "multi_thread")]`. */
const RUST_TEST = /#\[(?:\w+::)*test(?:\([^\]]*\))?\]/;
const RUST_FN = /\bfn\s+(\w+)/;
const STRING_ARG = /^\s*(['"`])((?:\\.|(?!\1).)*)\1/;

function namedOpener(path: string): RegExp | undefined {
  return NAMED_OPENERS.find(([ext]) => ext.test(path))?.[1];
}

/** A language the gate counts tests in; other files open none, so they are not read. */
function hasTestSyntax(path: string): boolean {
  return JS_FILE.test(path) || path.endsWith(".rs") || path.endsWith(".swift") || namedOpener(path) !== undefined;
}

/** The code before a `/` that makes it a regex literal, not a division. */
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case))\s*$/;

/** The index of the `/` closing a regex literal opened at `start`, or -1 when the line has none. */
function regexEnd(line: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
  }
  return -1;
}

/**
 * A JS/TS file's lines as code: every string, template and regex literal's
 * content replaced by spaces (escapes respected, delimiters kept, so offsets
 * still match the source), a `//` comment outside a string dropped, and a
 * `/* ... *\/` block blanked. A block comment and a template literal carry
 * from line to line; a template's `${}` stays blanked as text.
 */
function jsCode(lines: string[]): string[] {
  let block = false;
  let template = false;
  return lines.map((line) => {
    let out = "";
    let quote = template ? "`" : "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (block) {
        if (c === "*" && line[i + 1] === "/") {
          block = false;
          out += "  ";
          i++;
        } else out += " ";
      } else if (quote !== "") {
        if (c === "\\") {
          out += i + 1 < line.length ? "  " : " ";
          i++;
        } else if (c === quote) {
          out += c;
          quote = "";
        } else out += " ";
      } else if (c === "/" && line[i + 1] === "/") {
        break;
      } else if (c === "/" && line[i + 1] === "*") {
        block = true;
        out += "  ";
        i++;
      } else if (c === "/" && REGEX_BEFORE.test(out)) {
        const end = regexEnd(line, i);
        if (end === -1) out += c;
        else {
          out += `/${" ".repeat(end - i - 1)}/`;
          i = end;
        }
      } else {
        if (c === "'" || c === '"' || c === "`") quote = c;
        out += c;
      }
    }
    // Only a template literal spans lines; an unclosed ' or " ends with its line.
    template = quote === "`";
    return out;
  });
}

/** One pass per file, however many of its lines are asked about. */
function perFile<T>(pass: (lines: string[]) => T): (lines: string[]) => T {
  const cache = new WeakMap<string[], T>();
  return (lines) => {
    let code = cache.get(lines);
    if (code === undefined) {
      code = pass(lines);
      cache.set(lines, code);
    }
    return code;
  };
}
export const codeOf = perFile(jsCode);

/**
 * A Python file's lines as code, offsets kept: string content blanked
 * (escapes respected) and a `#` comment dropped. An open triple-quoted string
 * carries to the next line; an open one-line string only when a trailing `\`
 * continues it, so a 3.12 f-string nesting quotes (`f"{ "it's" }"`) cannot
 * leave a bogus string open past its line.
 */
const pyCodeOf = perFile((lines) => {
  let carry = "";
  return lines.map((line) => {
    let out = "";
    let quote = carry;
    let continued = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (quote !== "") {
        if (c === "\\") {
          continued = i + 1 === line.length;
          out += continued ? " " : "  ";
          i++;
        } else if (line.startsWith(quote, i)) {
          out += quote;
          i += quote.length - 1;
          quote = "";
        } else out += " ";
      } else if (c === "#") break;
      else if (c === "'" || c === '"') {
        quote = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        out += quote;
        i += quote.length - 1;
      } else out += c;
    }
    carry = quote.length === 3 || continued ? quote : "";
    return out;
  });
});

/**
 * One test or describe a line opens, with its title and the 0-based line the
 * title came from. A `title` opener is the title of a multi-line `test.each`
 * table, on the line that closes the table: judged by name, never counted.
 */
export type LineOpener = { kind: "test" | "describe" | "title"; title: string | null; titleLine: number | null };

/**
 * A `.each` or `.for` table opener: `test.each(`, `it.runIf(c).each<Row>([`,
 * `test.each<` ending its line, `` describe.each` ``, `test.for(`. It opens a table
 * when its argument does not close on its line.
 */
const EACH_OPEN = /(?<![\w.$])(?:test|it|describe)(?:\.\w+(?:\([^()]*\))?)*\.(?:each|for)\s*(?:<.*>\s*)?(\(|`|<\s*$)/g;

/**
 * The lines closing a multi-line `.each`/`.for` table, each mapped to the index
 * just past the `(` its title call opens. A table's argument (`(` or `` ` ``,
 * after a generic `<...>` spanning lines) is followed over the code lines by
 * bracket depth to where it closes; that line closes the table only when a `(`
 * follows the close (`])(`, `}))(`, `` `( ``). A curried `)(` elsewhere never does.
 */
const tableCloses = perFile((code) => {
  const closes = new Map<number, number>();
  code.forEach((line, j) => {
    for (const m of line.matchAll(EACH_OPEN)) {
      const start = (m.index ?? 0) + m[0].length - (m[1] as string).length;
      let mode = line[start] === "<" ? "angle" : "seek";
      let depth = 0;
      scan: for (let i = j, c = start; i < code.length; i++, c = 0) {
        const s = code[i] as string;
        for (; c < s.length; c++) {
          const ch = s[c] as string;
          if (mode === "angle") {
            if (ch === "<") depth++;
            else if (ch === ">" && s[c - 1] !== "=" && --depth === 0) mode = "seek";
          } else if (mode === "seek") {
            if (ch === "(") [mode, depth] = ["paren", 1];
            else if (ch === "`") mode = "tick";
            else if (ch.trim() !== "") break scan;
          } else if (mode === "paren" && "([{".includes(ch)) depth++;
          else if (mode === "paren" ? ")]}".includes(ch) && --depth === 0 : ch === "`") {
            const next = /^\s*\(/.exec(s.slice(c + 1));
            if (i !== j && next !== null && !closes.has(i)) closes.set(i, c + 1 + next[0].length);
            break scan;
          }
        }
      }
    }
  });
  return closes;
});

/**
 * The tests and describes line `i` of a file opens, openers before subtests. JS/TS: a title
 * is the opener's first string-literal argument on its line, or, when nothing
 * follows its `(` on the line, the leading string literal of the next non-blank
 * line. An opener counts when it has a title or starts a statement
 * (`void test("x", ...)` counts, `if (test(x))` does not). Python, Go: the
 * function name. Swift: see `swiftOpeners`. Rust: a `#[test]`-shaped attribute outside a comment,
 * titled by the `fn` on its line or on the next line that is not blank or
 * another attribute.
 */
export function lineOpeners(path: string, lines: string[], i: number): LineOpener[] {
  const raw = lines[i] ?? "";
  if (path.endsWith(".rs")) return rustOpeners(lines, i);
  if (path.endsWith(".swift")) return swiftOpeners(lines)[i] ?? [];
  if (!JS_FILE.test(path)) {
    const line = path.endsWith(".py") ? (pyCodeOf(lines)[i] ?? "") : raw;
    const name = namedOpener(path)?.exec(line)?.[1];
    return name === undefined ? [] : [{ kind: "test", title: name, titleLine: i }];
  }
  const code = codeOf(lines)[i] ?? "";
  const found: LineOpener[] = [];
  const tableAt = tableCloses(codeOf(lines)).get(i);
  if (tableAt !== undefined) {
    const { title, titleLine } = titleOf(lines, raw, code, i, tableAt);
    if (title !== null) found.push({ kind: "title", title, titleLine });
  }
  for (const m of code.matchAll(JS_OPENER)) {
    const start = m.index ?? 0;
    if (!(m[2] as string).split(".").slice(1).every((mod) => MODIFIERS.has(mod))) continue;
    const at = callOpen(code, start + m[0].length);
    if (at === -1) continue;
    // A wrapped title is found before the statement-start check: it makes an expression opener count.
    const { title, titleLine } = titleOf(lines, raw, code, i, at);
    if (title === null && !STATEMENT_START.test(code.slice(0, start))) continue;
    found.push({ kind: m[1] === "describe" ? "describe" : "test", title, titleLine });
  }
  for (const m of code.matchAll(JS_SUBTEST)) {
    const start = m.index ?? 0;
    if (!(m[1] as string).split(".").slice(1).every((mod) => MODIFIERS.has(mod))) continue;
    if (!SUBTEST_START.test(code.slice(0, start))) continue;
    const at = callOpen(code, start + m[0].length);
    if (at === -1) continue;
    // `t.test(name, fn)` takes a function after its title, read across the next lines; `re.test(x)` takes none.
    // An unclosed `(` still splits: the function argument starts within those lines.
    const rest = [code.slice(at - 1), ...codeOf(lines).slice(i + 1, i + 20)].join("\n");
    const close = closeParen(rest, 0);
    const args = topLevelParts(rest.slice(1, close === -1 ? rest.length : close));
    if (!args.slice(1).some((a) => FN_ARG.test(a))) continue;
    found.push({ kind: "test", ...titleOf(lines, raw, code, i, at) });
  }
  return found;
}

/**
 * The title of a call whose arguments start at `at` on line `i`: its first
 * string-literal argument, or, when nothing follows the `(` on the line, the
 * leading string literal of the next non-blank line.
 */
function titleOf(lines: string[], raw: string, code: string, i: number, at: number): { title: string | null; titleLine: number | null } {
  let arg = STRING_ARG.exec(raw.slice(at));
  let titleLine: number | null = arg === null ? null : i;
  if (arg === null && code.slice(at).trim() === "") {
    let j = i + 1;
    while (j < lines.length && (lines[j] as string).trim() === "") j++;
    arg = STRING_ARG.exec(lines[j] ?? "");
    if (arg !== null) titleLine = j;
  }
  return { title: arg === null ? null : (arg[2] as string), titleLine };
}

/**
 * A Swift file's lines as code, offsets kept: string and extended regex
 * content blanked (`"..."`, `"""` across lines, `#"raw"#` with its own `\#`
 * escape, `#/regex/#`), with `\(...)` interpolation read as code, and
 * comments blanked, `/* *\/` nesting. A backticked raw identifier stays code.
 */
function swiftCode(lines: string[]): string[] {
  const src = lines.join("\n");
  const blank = (t: string): string => t.replace(/[^\n]/g, " ");
  // A string being read, or the open-paren depth of an interpolation inside one.
  const stack: ({ hashes: string; multi: boolean } | { depth: number })[] = [];
  let out = "";
  for (let i = 0; i < src.length; ) {
    const top = stack[stack.length - 1];
    const c = src[i] as string;
    if (top !== undefined && "hashes" in top) {
      const close = (top.multi ? '"""' : '"') + top.hashes;
      if (src.startsWith(`\\${top.hashes}`, i)) {
        const j = i + 1 + top.hashes.length;
        if (src[j] === "(") {
          out += `${blank(src.slice(i, j))}(`;
          stack.push({ depth: 0 });
        } else out += blank(src.slice(i, j + 1));
        i = j + 1;
      } else if (src.startsWith(close, i)) {
        out += close;
        stack.pop();
        i += close.length;
      } else {
        // A single-line string never spans lines: an unclosed one ends with its line.
        if (c === "\n" && !top.multi) stack.pop();
        out += c === "\n" ? c : " ";
        i++;
      }
      continue;
    }
    if (src.startsWith("//", i)) {
      const eol = src.indexOf("\n", i);
      const end = eol === -1 ? src.length : eol;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (src.startsWith("/*", i)) {
      let j = i;
      for (let depth = 0; j < src.length; ) {
        if (src.startsWith("/*", j)) [depth, j] = [depth + 1, j + 2];
        else if (src.startsWith("*/", j)) {
          [depth, j] = [depth - 1, j + 2];
          if (depth === 0) break;
        } else j++;
      }
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    SWIFT_LITERAL.lastIndex = i;
    const lit = SWIFT_LITERAL.exec(src);
    if (lit !== null && (lit[2] !== "/" || lit[1] !== "")) {
      const [all, hashes, quote] = lit as unknown as [string, string, string];
      out += all;
      i += all.length;
      if (quote === "/") {
        const at = src.indexOf(`/${hashes}`, i);
        const end = at === -1 ? src.length : at;
        out += blank(src.slice(i, end));
        i = end;
      } else stack.push({ hashes, multi: quote === '"""' });
      continue;
    }
    if (top !== undefined) {
      if (c === "(") top.depth++;
      else if (c === ")" && top.depth-- === 0) stack.pop();
    }
    out += c;
    i++;
  }
  return out.split("\n");
}

const swiftCache = new WeakMap<string[], LineOpener[][]>();

/**
 * The openers of every line of a Swift file, one pass per file. A swift-testing
 * `@Test` outside a comment or string (`swiftCode`) is one test,
 * `@Test(arguments: ...)` included, as a table is: titled by its
 * `@Test("display name")` (any string form), else by the `func` it attaches
 * to; with both, the func name is a `title` opener too, judged and not
 * counted. An XCTest `func test*` is a test unless an `@Test` owns it.
 */
function swiftOpeners(lines: string[]): LineOpener[][] {
  let found = swiftCache.get(lines);
  if (found !== undefined) return found;
  const raw = lines.join("\n");
  const codeLines = swiftCode(lines);
  const code = codeLines.join("\n");
  const lineAt = (offset: number): number => raw.slice(0, offset).split("\n").length - 1;
  const out: LineOpener[][] = lines.map(() => []);
  const owned = new Set<number>();
  for (const m of code.matchAll(SWIFT_TEST)) {
    const start = m.index ?? 0;
    let after = start + m[0].length;
    let title: string | null = null;
    let titleLine: number | null = null;
    const paren = /^\s*\(/.exec(code.slice(after));
    if (paren !== null) {
      const open = after + paren[0].length - 1;
      // The first argument as a string literal; its content is blanked in code, so its close is the next delimiter.
      const arg = /^\s*(#*)("""|")/.exec(code.slice(open + 1));
      const from = arg === null ? -1 : open + 1 + arg[0].length;
      const end = arg === null ? -1 : code.indexOf((arg[2] as string) + (arg[1] as string), from);
      if (end !== -1) [title, titleLine] = [raw.slice(from, end), lineAt(from)];
      const close = closeParen(code, open);
      after = close === -1 ? code.length : close + 1;
    }
    SWIFT_FUNC.lastIndex = after;
    const fn = SWIFT_FUNC.exec(code);
    const tests: LineOpener[] = [];
    if (fn !== null) {
      const name = (fn[1] as string).replace(/`/g, "");
      const fnLine = lineAt((fn.index ?? 0) + fn[0].length - 1);
      owned.add(fnLine);
      if (title === null) [title, titleLine] = [name, fnLine];
      else tests.push({ kind: "title", title: name, titleLine: fnLine });
    }
    (out[lineAt(start)] as LineOpener[]).push({ kind: "test", title, titleLine }, ...tests);
  }
  codeLines.forEach((c, j) => {
    const name = owned.has(j) ? undefined : XCTEST_FUNC.exec(c)?.[1];
    if (name !== undefined) (out[j] as LineOpener[]).push({ kind: "test", title: name, titleLine: j });
  });
  swiftCache.set(lines, out);
  found = out;
  return found;
}

/** A raw string opener, `r"`, `r#"`, `br##"`, `cr#"`: its `#`s are part of its close. */
const RUST_RAW = /[bc]?r(#*)"/y;
/** A char literal: `'x'` or one escape (`'\n'`, `'\''`, `'\x7f'`, `'\u{1F600}'`); any other `'` is a lifetime or label. */
const RUST_CHAR = /'(?:[^'\\\n]|\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.))'/uy;

/**
 * A Rust file's lines as code, offsets kept: `/* *\/` comments blanked
 * (nesting, across lines), `//` tails removed, and the content of strings
 * (`"..."` with escapes, raw `r#"..."#`, both across lines) and char literals blanked.
 */
const rustCodeOf = perFile((lines) => {
  let depth = 0;
  // The delimiter closing an open string, and whether `\` escapes inside it.
  let close = "";
  let escapes = false;
  return lines.map((line) => {
    let out = "";
    for (let i = 0; i < line.length; ) {
      if (close !== "") {
        if (escapes && line[i] === "\\") {
          out += i + 1 < line.length ? "  " : " ";
          i += 2;
        } else if (line.startsWith(close, i)) {
          out += close;
          i += close.length;
          close = "";
        } else {
          out += " ";
          i++;
        }
        continue;
      }
      if (depth === 0 && line.startsWith("//", i)) break;
      if (line.startsWith("/*", i)) depth++;
      else if (depth > 0 && line.startsWith("*/", i)) depth--;
      else if (depth > 0) {
        out += " ";
        i++;
        continue;
      } else {
        RUST_RAW.lastIndex = i;
        RUST_CHAR.lastIndex = i;
        const raw = /\w/.test(line[i - 1] ?? "") ? null : RUST_RAW.exec(line);
        const char = raw === null ? RUST_CHAR.exec(line) : null;
        if (raw !== null) [out, i, close, escapes] = [out + raw[0], i + raw[0].length, `"${raw[1]}`, false];
        else if (char !== null) [out, i] = [`${out}'${" ".repeat(char[0].length - 2)}'`, i + char[0].length];
        else {
          if (line[i] === '"') [close, escapes] = ['"', true];
          out += line[i];
          i++;
        }
        continue;
      }
      out += "  ";
      i += 2;
    }
    return out;
  });
});

/** The test a Rust line's attribute opens, titled by its `fn` name. */
function rustOpeners(lines: string[], i: number): LineOpener[] {
  const rustCode = rustCodeOf(lines);
  const code = rustCode[i] ?? "";
  const attr = RUST_TEST.exec(code);
  if (attr === null) return [];
  let j = i;
  let rest = code.slice((attr.index ?? 0) + attr[0].length);
  while (rest.trim() === "" || rest.trim().startsWith("#[")) {
    if (++j >= lines.length) return [{ kind: "test", title: null, titleLine: null }];
    rest = rustCode[j] as string;
  }
  const name = RUST_FN.exec(rest)?.[1];
  return [{ kind: "test", title: name ?? null, titleLine: name === undefined ? null : j }];
}

/** How many tests line `i` of a test file opens. */
export function countTestsInLine(path: string, lines: string[], i: number): number {
  return lineOpeners(path, lines, i).filter((o) => o.kind === "test").length;
}

/** The names line `i` gives its tests and describes. */
export function testTitles(path: string, lines: string[], i: number): string[] {
  return lineOpeners(path, lines, i).flatMap((o) => (o.title === null ? [] : [o.title]));
}

/**
 * "review" as a word start ("per review", not "renders preview"); "findings",
 * or "finding" as a noun (after an article or "review", or last), never the
 * verb in "finding items".
 */
export const FINDING_PATTERNS = [
  /#\d+/i, /\w+#\d+/i, /\bP[0-3]\b/i, /\breview/i, /\bfindings\b/i, /\b(?:the|a|an|this|that|per|review)\s+finding\b/i, /\bfinding$/i,
  /regression/i, /^(never |no longer )/i,
];
/**
 * Python, Go, Swift and Rust test names are identifiers: `test_issue_1239`,
 * `test_p1_`, `TestIssue12`, `TestPR12Fix`, `TestP1Bug` (not `TestHTTP2Server`).
 */
const NAME_FINDING_PATTERNS = [
  /(?:^|_)(?:issue|sf|pr|bug|gh)_?\d+/i, /(?:^|_)p[0-3](?:_|$)/i, /(?:Issue|Sf|SF|Pr|PR|Bug|Gh|GH)\d+/, /(?<![A-Z])P[0-3](?:[A-Z_]|$)/,
];

/** A test or describe name that cites an issue, a review or a pin. */
export function isFindingName(path: string, name: string): boolean {
  if (FINDING_PATTERNS.some((p) => p.test(name))) return true;
  return !JS_FILE.test(path) && NAME_FINDING_PATTERNS.some((p) => p.test(name));
}

const SOURCE_READ_JS = /\b(?:readFileSync|readFile|Bun\.file)\s*\(/g;
const SOURCE_READ_PY = /(?<![\w.])open\s*\(/g;

/**
 * The read calls in a test file that read a `src/` file as text, as 0-based
 * first and last lines: `src/` in the raw text of the call's own span, its `(`
 * to the matching `)` across lines, counted in the code form (strings blanked,
 * each line padded to its raw length so offsets align; Python uses the raw
 * text). A call whose `(` never closes spans to the end of its first line.
 */
export function sourceReadSpans(path: string, lines: string[]): { first: number; last: number }[] {
  const raw = lines.join("\n");
  const code = JS_FILE.test(path) ? codeOf(lines).map((c, i) => c.padEnd((lines[i] as string).length)).join("\n") : raw;
  const lineAt = (offset: number): number => raw.slice(0, offset).split("\n").length - 1;
  const spans: { first: number; last: number }[] = [];
  for (const m of code.matchAll(path.endsWith(".py") ? SOURCE_READ_PY : SOURCE_READ_JS)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = closeParen(code, open);
    const eol = raw.indexOf("\n", open);
    const end = close === -1 ? (eol === -1 ? raw.length : eol) : close + 1;
    if (raw.slice(open, end).includes("src/")) spans.push({ first: lineAt(open), last: lineAt(end - 1) });
  }
  return spans;
}

/** The names a registration shim gives the function it stores and replays. */
const SHIM_FN = "(?:fn|run|body|impl)";
const SHIM_NAME = new RegExp(`^${SHIM_FN}$`);
/** A loop binding each element: `for (const c of`, `for (const [name, fn] of`, `.forEach(({ fn }) =>`. */
const LOOP_HEAD =
  /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+([\w$]+|\{[^}]*\}|\[[^\]]*\])\s+of\b|\.(?:forEach|map)\(\s*(?:async\s+)?(?:\(\s*([\w$]+|\{[^}]*\}|\[[^\]]*\])[^)]*\)|([\w$]+))\s*=>/g;
/** A named function's parameter list: `function addCase(`, `const section = (`, `const section = async (`. */
const SHIM_DEF = /\bfunction\s*[\w$]*\s*\(|\b(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?\(/g;
/** Storing into a list or map: `cases.push(`, `registry.set(`. */
const STORE = /\.(?:push|set)\s*\(/g;

/**
 * The end of a body starting at `from`: its matching `}` when it opens with
 * `{`, else the end of the line it starts on (an arrow's expression may start
 * on the next line).
 */
function bodyEnd(code: string, from: number): number {
  const lead = /^\s*/.exec(code.slice(from))?.[0].length ?? 0;
  if (code[from + lead] === "{") {
    const close = closeParen(code, from + lead);
    if (close !== -1) return close + 1;
  }
  const eol = code.indexOf("\n", from + lead);
  return eol === -1 ? code.length : eol;
}

/** The comma-separated parts of `text` at bracket depth 0. */
function topLevelParts(text: string): string[] {
  const parts = [""];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    // The `>` of an arrow `=>` closes nothing.
    if ("({[<".includes(c)) depth++;
    else if (")}]".includes(c) || (c === ">" && text[i - 1] !== "=")) depth--;
    if (c === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += c;
  }
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** The fields a registered test carries besides its function: a row reading any other field is a table. */
const SHIM_FIELD = /^(?:name|title|opts|options)$/;
/**
 * A replay call is a statement of its own, its result unused: `await c.fn(t);`,
 * `=> fn(t)`, or an unbraced loop body after its head's `)`; never
 * `assert.equal(fn(2), 4)`.
 */
const CALL_START = String.raw`(?<=(?:^|[;{})]|=>)\s*(?:(?:await|void)\s+)?)`;

/**
 * Whether a loop body replays the function each element carries, as bound by
 * `binding`, and reads nothing else of it: `c.fn(t)` with only `c.name` beside
 * it is a replay; `s.run()` checked against `s.expected` is a table row.
 */
function replaysElementFn(binding: string, body: string): boolean {
  const id = (name: string) => name.replace(/[$]/g, "\\$");
  if (/^[\w$]+$/.test(binding)) {
    const fields = [...body.matchAll(new RegExp(`(?<![\\w.$])${id(binding)}\\s*\\.\\s*([\\w$]+)`, "g"))].map((f) => f[1] as string);
    if (fields.some((f) => !SHIM_NAME.test(f) && !SHIM_FIELD.test(f))) return false;
    return new RegExp(`${CALL_START}${id(binding)}\\s*(?:\\.\\s*${SHIM_FN}|\\[\\s*1\\s*\\])\\s*\\(`).test(body);
  }
  const parts = topLevelParts(binding.slice(1, -1));
  // `[name, fn]`: the pair's second element; `{ name, fn }` or `{ fn: f }`: the element's field. Each by a shim name.
  if (binding.startsWith("[")) {
    if (parts.length !== 2 || !SHIM_NAME.test(parts[1] as string)) return false;
    return new RegExp(`${CALL_START}${id(parts[1] as string)}\\s*\\(`).test(body);
  }
  const keys = parts.map((p) => p.split(":").map((s) => s.trim().split(/\s*=/)[0] as string));
  if (keys.some(([key]) => !SHIM_NAME.test(key as string) && !SHIM_FIELD.test(key as string))) return false;
  return keys.some(([key, local]) => {
    const l = local ?? (key as string);
    return SHIM_NAME.test(key as string) && /^[\w$]+$/.test(l) && new RegExp(`${CALL_START}${id(l)}\\s*\\(`).test(body);
  });
}

/**
 * The spans of a JS/TS test file, as 0-based first and last lines, that hide
 * tests from the count: a loop that calls the function each element carries
 * as a statement and reads nothing of it but its name and options
 * (`for (const c of cases) await c.fn(t)`, `for (const [name, fn] of rows) fn(t)`),
 * and, in a file holding such a loop, a function of `(name, fn)` or
 * `(name, opts, fn)` that stores its function in a list or map
 * (`function section(name, fn) { sections.push({ name, fn }); }`). A row's
 * function is recognised by name (fn, run, body, impl) or, for a shim's
 * parameter, by a function type. `test` is not one (`re.test(` is a regex), nor
 * `callback` or `cb` (a fake timer firing its callbacks). A table of
 * `{ name, input, expected }` rows carries none, nor one whose function's
 * result is asserted (`assert.equal(fn("x"), 1, name)`).
 *
 * Known gaps, by design a name-keyed heuristic: a renamed field
 * (`s.check(t)`), a store by `unshift` or index assignment, an index loop
 * (`for (let i...) cases[i].fn(t)`) and `for...in` are not seen
 * (development#1272).
 */
export function hiddenTestSpans(path: string, lines: string[]): { first: number; last: number }[] {
  if (!JS_FILE.test(path)) return [];
  const raw = lines.join("\n");
  const code = codeOf(lines).map((c, i) => c.padEnd((lines[i] as string).length)).join("\n");
  const lineAt = (offset: number): number => raw.slice(0, offset).split("\n").length - 1;
  const spans: { first: number; last: number }[] = [];
  for (const m of code.matchAll(LOOP_HEAD)) {
    const start = m.index ?? 0;
    const binding = (m[1] ?? m[2] ?? m[3]) as string;
    // A `for` body follows the head's `)`; an arrow's body runs to the `)` closing `.forEach(`.
    const end = m[1] !== undefined
      ? bodyEnd(code, closeParen(code, code.indexOf("(", start)) + 1)
      : closeParen(code, code.indexOf("(", start));
    if (end === -1) continue;
    if (replaysElementFn(binding, code.slice(start + m[0].length, end))) spans.push({ first: lineAt(start), last: lineAt(end - 1) });
  }
  // A store of `(name, fn)` is a shim only beside its replay: alone it is a fake emitter's `on(event, fn)`.
  if (spans.length === 0) return spans;
  for (const m of code.matchAll(SHIM_DEF)) {
    const start = m.index ?? 0;
    const open = start + m[0].length - 1;
    const close = closeParen(code, open);
    if (close === -1) continue;
    // `(name, fn)`, or `(name, opts, fn)` as the whisper harness's addCase.
    const params = topLevelParts(code.slice(open + 1, close));
    if (params.length < 2 || params.length > 3) continue;
    const fnParam = params[params.length - 1] as string;
    // A plain parameter, `fn` or `fn: Type`; a destructured one is an options object.
    const param = /^([\w$]+)\s*\??\s*(?::(.*))?$/s.exec(fnParam);
    if (param === null) continue;
    const name = param[1] as string;
    if (!SHIM_NAME.test(name) && !/=>|\bFunction\b/.test(param[2] ?? "")) continue;
    // The body follows the parameters, a return type and an arrow.
    const arrow = /^\s*(?::[^={\n]*)?(?:=>)?/.exec(code.slice(close + 1))?.[0].length ?? 0;
    const end = bodyEnd(code, close + 1 + arrow);
    const body = code.slice(close + 1, end);
    const stores = [...body.matchAll(STORE)].some((s) => {
      const at = (s.index ?? 0) + s[0].length - 1;
      const args = body.slice(at, closeParen(body, at) + 1);
      return new RegExp(`(?<![\\w.$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`).test(args);
    });
    if (stores) spans.push({ first: lineAt(start), last: lineAt(end - 1) });
  }
  return spans;
}

const COVERAGE_PATTERNS = [
  /--coverage/,
  /coverageThreshold/,
  /collectCoverage/,
  /--cov\b/,
  /(^|[\s"'])c8(\s|$|["'])/,
  /(^|[\s"'])nyc(\s|$|["'])/,
  /istanbul/,
  /\bcoverage\s*[:=]/,
  /\[tool\.coverage/,
  /go test\b.*-cover/,
  /\bcoverage run\b/,
  /pytest-cov/,
  /"coverage"\s*:/,
  /tarpaulin/,
  /llvm-cov/,
  /codecov/,
  /coveralls/,
];
/** Files that exist only to configure coverage: any setting in one is a hit. */
const COVERAGE_FILE = /^\.(coveragerc|c8rc|nycrc)/;
const ANY_SETTING = /\S/;

/** The coverage pattern a config line matches, or null. */
export function coverageHit(path: string, line: string): RegExp | null {
  if (COVERAGE_FILE.test(baseName(path)) && ANY_SETTING.test(line)) return ANY_SETTING;
  return COVERAGE_PATTERNS.find((p) => p.test(line)) ?? null;
}

/** CI YAML under `.forgejo/`, `.github/` and `.woodpecker/`, and config files by name anywhere in the tree. */
export function isCoverageConfig(path: string): boolean {
  if (/^\.(forgejo|github|woodpecker)\/.*\.ya?ml$/.test(path)) return true;
  const name = baseName(path);
  return (
    [
      "package.json", "pyproject.toml", "setup.cfg", "bunfig.toml", "Makefile", "tox.ini", "justfile", "noxfile.py", "Cargo.toml",
      ".gitlab-ci.yml", ".woodpecker.yml",
    ].includes(name) ||
    /^(vitest|jest|vite)\.config\./.test(name) ||
    /^karma\.conf\./.test(name) ||
    /^\.mocharc/.test(name) ||
    COVERAGE_FILE.test(name)
  );
}

/**
 * One `.gitignore` line as git reads it, or null for a blank or `#` line,
 * matched against a directory path written without its trailing `/` (so
 * `tests/*` matches `tests/coverage` but never `tests` itself). A pattern with
 * no `/` but a trailing one matches at any depth; a match on a parent
 * directory matches everything under it.
 */
function ignoreMatcher(line: string): { negate: boolean; re: RegExp } | null {
  let p = line.trim();
  if (p === "" || p.startsWith("#")) return null;
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    // `**/` may match no directory at all, as `**/tests/coverage/` matches `tests/coverage/`.
    if (p.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (p.startsWith("**", i)) {
      re += ".*";
      i++;
    } else if (p[i] === "*") re += "[^/]*";
    else if (p[i] === "?") re += "[^/]";
    else re += (p[i] as string).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Every path judged is a directory, so a trailing `/` (dirOnly) needs no check of its own.
  return { negate, re: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}(?:/|$)`) };
}

/**
 * True when `.gitignore` ignores `tests/` or `tests/coverage/` as a directory:
 * for each, the last line matching it is not a `!` negation. Git never
 * re-includes a path under an excluded directory, so an ignored `tests/`
 * covers whatever a later `!tests/coverage/` says.
 */
export function gitignoreCovers(text: string): boolean {
  const matchers = text.split("\n").flatMap((line) => ignoreMatcher(line) ?? []);
  for (const dir of ["tests", COVERAGE_DIR.slice(0, -1)]) {
    let ignored = false;
    for (const m of matchers) if (m.re.test(dir)) ignored = !m.negate;
    if (ignored) return true;
  }
  return false;
}

class HarnessError extends Error {}

let top = process.cwd();

/** One git call in the repo root. Null on a non-zero exit. */
function gitTry(args: string[]): string | null {
  const git = spawnSync("git", ["-C", top, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (git.error !== undefined) throw new HarnessError(`git ${args[0]}: ${git.error.message}`);
  return git.status === 0 ? git.stdout : null;
}

/** A git call that must succeed; a failure is a harness error (exit 3). */
function git(args: string[]): string {
  const out = gitTry(args);
  if (out === null) throw new HarnessError(`git ${args.join(" ")} failed`);
  return out;
}

/** Where the gate reads from: a tree-ish prefix for `git show`, and the diff args. */
type Source = {
  /** `<rev>:` for a commit, `:` for the index. */
  show: string;
  /** Blob paths in the tree being judged. */
  files: string[];
  /** `git diff` args selecting the change. */
  diff: string[];
  /** Revision holding the base budget, or null when there is none. */
  baseRev: string | null;
};

function rangeSource(base: string, head: string): Source {
  const baseSha = git(["rev-parse", "--verify", "-q", `${base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "--verify", "-q", `${head}^{commit}`]).trim();
  const files: string[] = [];
  for (const row of git(["ls-tree", "-r", "-z", "--full-tree", headSha]).split("\0")) {
    const tab = row.indexOf("\t");
    if (tab === -1) continue;
    if (row.slice(0, tab).split(" ")[1] === "blob") files.push(row.slice(tab + 1));
  }
  return { show: `${headSha}:`, files, diff: [`${baseSha}...${headSha}`], baseRev: baseSha };
}

function stagedSource(): Source {
  const files: string[] = [];
  for (const row of git(["ls-files", "-s", "-z", "--full-name"]).split("\0")) {
    const tab = row.indexOf("\t");
    if (tab === -1) continue;
    // Mode 160000 is a submodule, not a file.
    if (!row.startsWith("160000 ")) files.push(row.slice(tab + 1));
  }
  const head = gitTry(["rev-parse", "--verify", "-q", "HEAD^{commit}"])?.trim() ?? null;
  return { show: ":", files: [...new Set(files)], diff: ["--cached"], baseRev: head };
}

function read(src: Source, path: string): string {
  return git(["show", `${src.show}${path}`]);
}

type Violation = { rule: string; detail: string };

/** A budget file's value, or null when it is not a non-negative integer. */
function parseBudget(text: string): number | null {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

function countTests(src: Source): number {
  let count = 0;
  for (const path of src.files) {
    if (isExcluded(path) || !isTestPath(path) || !hasTestSyntax(path)) continue;
    const lines = read(src, path).split("\n");
    for (let i = 0; i < lines.length; i++) count += countTestsInLine(path, lines, i);
  }
  return count;
}

function budgetRules(src: Source, count: number, out: Violation[]): number | null {
  const budget = src.files.includes(BUDGET_FILE) ? parseBudget(read(src, BUDGET_FILE)) : null;
  if (budget === null) {
    out.push({ rule: "BUDGET_MISSING", detail: `${BUDGET_FILE} is absent or not a non-negative integer (${count} tests)` });
    return null;
  }
  // ls-tree, not cat-file -e: an empty listing is "no base budget", and a git failure is a harness error.
  if (src.baseRev !== null && git(["ls-tree", src.baseRev, "--", BUDGET_FILE]).trim() !== "") {
    const was = parseBudget(read({ ...src, show: `${src.baseRev}:` }, BUDGET_FILE));
    if (was !== null && budget > was) {
      out.push({ rule: "BUDGET_RAISED", detail: `${BUDGET_FILE} went from ${was} to ${budget}; the budget only goes down: delete a superfluous test in this PR instead (_DOCS/CODING_STANDARDS.md "The test budget only goes down")` });
    }
  }
  if (count > budget) out.push({ rule: "BUDGET_EXCEEDED", detail: `${count} tests, budget ${budget}` });
  if (count < budget) out.push({ rule: "BUDGET_STALE", detail: `${count} tests, budget ${budget}: lower ${BUDGET_FILE} to ${count}` });
  return budget;
}

/**
 * Changed paths with added and removed line counts. `--text` everywhere: a
 * `.gitattributes` binary marking must not hide a test file from the diff rules.
 * numstat still prints `-` for such a file even under `--text` (probed, git
 * 2.55.0), so a `-` row with a source extension is counted from its own
 * `--text` diff instead; any other `-` row (an image, a fixture) is skipped.
 */
const SOURCE_FILE = new RegExp(
  `\\.(${[
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "py", "go", "swift", "rs", "rb", "java", "kt", "kts", "scala", "groovy",
    "php", "cs", "fs", "c", "h", "cc", "cpp", "cxx", "hpp", "m", "mm", "sh", "bash", "zsh", "lua", "ex", "exs", "erl", "clj",
    "dart", "vue", "svelte", "sql", "r", "pl", "hs", "ml", "zig", "nim", "cr", "tf", "nix",
  ].join("|")})$`,
);

/**
 * A source file: a source extension, or no extension and a `#!` first line in
 * the judged tree (`_ob/bin/weeklyroundup`). A deleted file is read from the base.
 */
function isSourceFile(src: Source, path: string): boolean {
  if (SOURCE_FILE.test(path)) return true;
  if (baseName(path).includes(".")) return false;
  const first =
    gitTry(["show", `${src.show}${path}`]) ?? (src.baseRev === null ? null : gitTry(["show", `${src.baseRev}:${path}`]));
  return first?.startsWith("#!") ?? false;
}

function numstat(src: Source): { path: string; added: number; removed: number }[] {
  const rows: { path: string; added: number; removed: number }[] = [];
  for (const row of git(["diff", "--text", "--numstat", "-z", "--no-renames", ...src.diff]).split("\0")) {
    // A filename may hold a tab: everything after the second tab is the path.
    const [added, removed, ...rest] = row.split("\t");
    if (rest.length === 0) continue;
    const path = rest.join("\t");
    if (added === "-" || removed === "-") {
      if (!SOURCE_FILE.test(path)) continue;
      const lines = hunkLines(src, path);
      rows.push({ path, added: lines.filter((l) => l.sign === "+").length, removed: lines.filter((l) => l.sign === "-").length });
    } else {
      rows.push({ path, added: Number(added), removed: Number(removed) });
    }
  }
  return rows;
}

/** The changed lines of one file, with their line numbers (at head for `+`). */
function hunkLines(src: Source, path: string): { sign: "+" | "-"; n: number; text: string }[] {
  const diff = git(["diff", "--text", "-U0", "--no-renames", "--no-color", ...src.diff, "--", `:(literal)${path}`]);
  const lines: { sign: "+" | "-"; n: number; text: string }[] = [];
  let next = -1;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) next = Number(hunk[1]);
    else if (next !== -1 && line.startsWith("+")) lines.push({ sign: "+", n: next++, text: line.slice(1) });
    else if (next !== -1 && line.startsWith("-")) lines.push({ sign: "-", n: -1, text: line.slice(1) });
  }
  return lines;
}

/** Added lines of one file, with their line numbers at head. */
function addedLines(src: Source, path: string): { n: number; text: string }[] {
  return hunkLines(src, path).filter((l) => l.sign === "+");
}

function diffRules(src: Source, out: Violation[]): void {
  const testFiles: string[] = [];
  for (const { path, added } of numstat(src)) {
    // Only source files count, on either side: a fixture or snapshot under a test path is neither.
    if (isExcluded(path) || isLockfile(path) || !isSourceFile(src, path)) continue;
    if (isTestPath(path)) {
      if (added > 0) testFiles.push(path);
    }
  }
  for (const path of testFiles) {
    const added = addedLines(src, path);
    // Titles and read calls come from the file at the judged tree: an opener is
    // judged when its own line or its title's line (wrapped, or a table's closing
    // line) was added; a read call when any line of its span was.
    const lines = read(src, path).split("\n");
    const addedAt = new Set(added.map(({ n }) => n - 1));
    for (let i = 0; hasTestSyntax(path) && i < lines.length; i++) {
      for (const o of lineOpeners(path, lines, i)) {
        if (o.title === null || !(addedAt.has(i) || (o.titleLine !== null && addedAt.has(o.titleLine)))) continue;
        if (isFindingName(path, o.title)) {
          const n = (o.titleLine ?? i) + 1;
          out.push({ rule: "FINDING_NAME", detail: `${path}:${n}: test named after an issue or finding: ${JSON.stringify(o.title)}` });
        }
      }
    }
    for (const { first, last } of sourceReadSpans(path, lines)) {
      for (let n = first; n <= last; n++) {
        if (!addedAt.has(n)) continue;
        out.push({ rule: "SOURCE_AS_TEXT", detail: `${path}:${first + 1}: reads application source as text` });
        break;
      }
    }
    for (const { first, last } of hiddenTestSpans(path, lines)) {
      for (let n = first; n <= last; n++) {
        if (!addedAt.has(n)) continue;
        out.push({ rule: "HIDDEN_TESTS", detail: `${path}:${first + 1}: registers or replays named test functions inside one test; write each as its own test or a table row` });
        break;
      }
    }
  }
}

function repoRules(src: Source, out: Violation[]): void {
  for (const path of src.files) {
    if (isExcluded(path) || !isCoverageConfig(path)) continue;
    const lines = read(src, path).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hit = coverageHit(path, lines[i] as string);
      if (hit !== null) {
        out.push({ rule: "COVERAGE", detail: `${path}:${i + 1}: matches ${hit.source}; coverage lives under ${COVERAGE_DIR}, never in a pipeline` });
        break;
      }
    }
  }
  const ignore = src.files.includes(".gitignore") ? read(src, ".gitignore") : "";
  if (!gitignoreCovers(ignore)) {
    out.push({ rule: "GITIGNORE", detail: `.gitignore does not ignore ${COVERAGE_DIR} (no line, or a later ! negation)` });
  }
  // A force-added file under the generated tree is committed coverage output.
  for (const path of src.files) {
    if (isExcluded(path)) out.push({ rule: "GITIGNORE", detail: `${path} is tracked; ${COVERAGE_DIR} is generated and never committed` });
  }
}

function usage(): never {
  console.error("usage: test-gate.ts --range <base> <head> | --staged | --count [<rev>]");
  process.exit(3);
}

function main(argv: string[]): number {
  const [mode, ...rest] = argv;
  const ok =
    (mode === "--range" && rest.length === 2) ||
    (mode === "--staged" && rest.length === 0) ||
    (mode === "--count" && rest.length <= 1);
  if (!ok) usage();
  top = git(["rev-parse", "--show-toplevel"]).trim();
  if (mode === "--count") {
    // The one test count of record: what a .test-budget must equal (test-audit reads it).
    const rev = rest[0] ?? "HEAD";
    console.log(String(countTests(rangeSource(rev, rev))));
    return 0;
  }
  const src = mode === "--range" ? rangeSource(rest[0] as string, rest[1] as string) : stagedSource();
  const violations: Violation[] = [];
  const count = countTests(src);
  const budget = budgetRules(src, count, violations);
  diffRules(src, violations);
  repoRules(src, violations);
  for (const { rule, detail } of violations) console.error(`test-gate: ${rule}: ${detail}`);
  if (violations.length > 0) return 1;
  console.log(`test-gate: ok (${count} tests, budget ${budget})`);
  return 0;
}

// The CLI runs only when executed; test-audit imports the rule exports above.
// A Node without import.meta.main (before 24.2) would skip the CLI and exit 0: fail closed instead.
if (import.meta.main === undefined) {
  console.error("test-gate: harness error: needs Node 24.2 or newer");
  process.exit(3);
}
if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Any throw is a harness failure, never a pass and never a rule verdict.
    const why = err instanceof HarnessError ? err.message : String((err as Error)?.stack ?? err);
    console.error(`test-gate: harness error: ${why}`);
    process.exitCode = 3;
  }
}
