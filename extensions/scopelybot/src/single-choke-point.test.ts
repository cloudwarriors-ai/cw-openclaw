// AC-7.12: scopelyFetch (scopely-api.ts) is the ONLY way from this plugin to
// the ZW app. Enforced on the TypeScript AST of the production import closure
// of index.ts (PK-7a; it replaced a regex scan that 13 of 15 red-team evasions
// passed). File names do not matter: any module index.ts can reach is
// scanned, so a production module named *.test.ts or a re-imported legacy
// module is covered. Every network, process or code-evaluation escape hatch is
// a finding unless ALLOW names that file, rule and exact call-site count, with
// the call's pinned first argument. Pure static analysis: nothing executes.
//
// This is a TRIPWIRE against accidental or lazy introduction of network, exec
// or eval capability, NOT a sandbox. A key computed at runtime (base64, join,
// String.fromCharCode, JSON.parse, property enumeration) can still reach the
// Function constructor or api.runtime, and no static scan can see that; the
// "documented limits" fixtures below pin representative cases. Such code is
// deliberate and would bypass scopelyFetch entirely, so code review is its
// control; at runtime the capability registry keeps every tool that is not
// live/local from running, and scopelyFetch bounds what the rest can send.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Finding = { file: string; line: number; rule: string; arg?: string };

// Bare module specifiers the closure may import (node: prefix stripped). Any
// other module (http, net, dns, dgram, undici, worker_threads, module, a data:
// URL, a new package) is a finding; child_process is allowed per file in ALLOW.
const SAFE_MODULES = new Set(["@sinclair/typebox", "fs", "path", "os", "crypto", "async_hooks"]);
// Globals that reach the network, evaluate code, start another thread (which
// has its own fetch) or hand out the global object.
const BANNED_NAMES = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "globalThis",
  "global",
  "self",
  "window",
  "eval",
  "Function",
  "require",
  "Bun",
  "Deno",
  "Worker",
  "SharedWorker",
  "importScripts",
]);
// Member names that load native code or modules, or reach the Function
// constructor, from any base expression.
const BANNED_MEMBERS = new Set([
  "binding",
  "_linkedBinding",
  "dlopen",
  "mainModule",
  "getBuiltinModule",
  "constructor",
  "require",
]);
const CHILD_PROCESS = "child_process";

// The intended exceptions, each with its reason. `n` is exact (an extra site
// fails, and so does a stale allowance) and `arg` pins the call's first
// argument, so retargeting an allowed call is a finding too.
const ALLOW: Record<string, Record<string, { n: number; arg?: RegExp; why: string }>> = {
  // api.runtime is the SDK's injected toolbox (exec, media fetch, web search,
  // config writes); `arg` is the member chain, so only the LLM call passes.
  "index.ts": {
    "sdk-runtime": {
      n: 1,
      arg: /^api\.runtime\.llm\.complete$/,
      why: "the opt-in voice judge's LLM call (the model, not the app)",
    },
  },
  "src/scopely-api.ts": { "call:fetch": { n: 1, arg: /^url\.href$/, why: "the guard itself" } },
  "src/comfort.ts": {
    "call:fetch": {
      n: 3,
      arg: /^"https:\/\/(?:api\.)?zoom\.us\//,
      why: "Zoom OAuth token + chat posts (literal Zoom origins, not the app)",
    },
  },
  "src/devtools-client.ts": {
    "call:fetch": {
      n: 1,
      arg: /^`\$\{base\}\$\{path\}`$/,
      why: "devtools-api log host from env (F3, registry-blocked; PK-10 binds it to the profile)",
    },
  },
  "src/gh-tools.ts": {
    [`module:${CHILD_PROCESS}`]: { n: 1, why: "gh CLI (F4, registry-blocked)" },
    exec: { n: 4, arg: /^"gh"$/, why: "only the gh binary" },
  },
  "src/correlation-tools.ts": {
    [`module:${CHILD_PROCESS}`]: { n: 1, why: "gh CLI (F3, registry-blocked)" },
    exec: { n: 1, arg: /^"gh"$/, why: "only the gh binary" },
  },
  "src/support-ticket-tools.ts": {
    [`module:${CHILD_PROCESS}`]: { n: 1, why: "gh CLI (F4b, registry-blocked)" },
    exec: { n: 1, arg: /^"gh"$/, why: "only the gh binary" },
  },
};

/** Value of a string literal or a `+`/template chain of literals ("fe" + "tch"). */
function foldString(n: ts.Node): string | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return n.text;
  }
  if (ts.isParenthesizedExpression(n)) {
    return foldString(n.expression);
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(n.left);
    const right = foldString(n.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(n)) {
    let out = n.head.text;
    for (const span of n.templateSpans) {
      const part = foldString(span.expression);
      if (part === undefined) {
        return undefined;
      }
      out += part + span.literal.text;
    }
    return out;
  }
  return undefined;
}

/** `this` is only allowed inside a class body (elsewhere it may be the global object). */
function thisOutsideClass(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isClassLike(p)) {
      return false;
    }
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isSourceFile(p)) {
      return true;
    }
    if (ts.isMethodDeclaration(p) && ts.isObjectLiteralExpression(p.parent)) {
      return true;
    }
  }
  return true;
}

/**
 * A use of `process.env` that can only read it: a member read that is not
 * assigned, deleted or incremented, or an object spread copy. Anything else
 * (assignment, delete, an alias, passing it on) can rewrite NODE_OPTIONS,
 * NODE_TLS_REJECT_UNAUTHORIZED, the proxy variables or the VITEST test gate.
 */
function isEnvRead(env: ts.PropertyAccessExpression): boolean {
  const use = env.parent;
  if (ts.isSpreadAssignment(use)) {
    return true;
  }
  if (!(ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use))) {
    return false;
  }
  let target: ts.Node = use;
  while (
    ts.isParenthesizedExpression(target.parent) ||
    ts.isAsExpression(target.parent) ||
    ts.isNonNullExpression(target.parent) ||
    ts.isTypeAssertionExpression(target.parent)
  ) {
    target = target.parent;
  }
  const p = target.parent;
  const op = ts.isBinaryExpression(p) && p.left === target ? p.operatorToken.kind : undefined;
  const assigned =
    op !== undefined && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  const stepped =
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken);
  return !assigned && !stepped && !ts.isDeleteExpression(p);
}

function isTypeOnlyImport(n: ts.ImportDeclaration): boolean {
  const clause = n.importClause;
  if (!clause) {
    return false;
  }
  const bindings = clause.namedBindings;
  return (
    clause.isTypeOnly ||
    (!clause.name &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.every((e) => e.isTypeOnly))
  );
}

const scanCache = new Map<string, { findings: Finding[]; imports: string[] }>();

/** Findings plus the relative imports to follow, for one module. */
function scanFile(file: string, src: string): { findings: Finding[]; imports: string[] } {
  const key = `${file}\0${src}`;
  const cached = scanCache.get(key);
  if (cached) {
    return cached;
  }
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const imports: string[] = [];
  const add = (n: ts.Node, rule: string, arg?: string) =>
    findings.push({
      file,
      line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      rule,
      arg,
    });
  // Local names bound to child_process (named, default or namespace import), so
  // every call through them has its first argument pinned.
  const execNames = new Set<string>();
  for (const stmt of sf.statements) {
    const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
    const spec = ts.isImportDeclaration(stmt) ? stmt.moduleSpecifier : undefined;
    if (
      !clause ||
      !spec ||
      !ts.isStringLiteral(spec) ||
      spec.text.replace(/^node:/, "") !== CHILD_PROCESS
    ) {
      continue;
    }
    if (clause.name) {
      execNames.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      execNames.add(bindings.name.text);
    } else if (bindings) {
      for (const e of bindings.elements) {
        execNames.add(e.name.text);
      }
    }
  }

  const checkSpec = (n: ts.Node, spec: string, typeOnly: boolean) => {
    if (spec.startsWith(".")) {
      imports.push(spec);
      return;
    }
    const name = spec.replace(/^node:/, "");
    if (name === CHILD_PROCESS) {
      add(n, `module:${CHILD_PROCESS}`);
    } else if (spec.startsWith("openclaw/")) {
      if (!typeOnly) {
        add(n, "sdk-value-import");
      }
    } else if (!SAFE_MODULES.has(name)) {
      add(n, `module:${spec}`);
    }
  };

  const visit = (n: ts.Node) => {
    const parent = n.parent;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpec(n, n.moduleSpecifier.text, isTypeOnlyImport(n));
      // Binding names are not references, but importing a test hook is one,
      // even under an alias (`import { resetScopelyGuardForTest as r }`).
      const named = n.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const e of named.elements) {
          if ((e.propertyName ?? e.name).text.endsWith("ForTest")) {
            add(e, "test-hook-import");
          }
        }
      }
      return;
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpec(n, n.moduleSpecifier.text, n.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      checkSpec(n, n.moduleReference.expression.text, false);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = n.arguments[0];
      if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
        checkSpec(n, spec.text, false);
      } else {
        add(n, "non-literal-import");
      }
    } else if (ts.isIdentifier(n)) {
      const isKey =
        (ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent)) &&
        parent.name === n;
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === n;
      const callArg = (call: ts.Node) =>
        ts.isCallExpression(call.parent) && call.parent.expression === call
          ? (call.parent.arguments[0]?.getText(sf) ?? "")
          : undefined;
      if (BANNED_NAMES.has(n.text) && !isKey && !(isMemberName && n.text !== "fetch")) {
        const arg = n.text === "fetch" ? callArg(n) : undefined;
        add(n, arg === undefined ? `ident:${n.text}` : "call:fetch", arg);
      } else if (n.text === "process" && !isKey && !isMemberName) {
        // Only process.env: any other use can reach binding/dlopen/getBuiltinModule.
        const env =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === n &&
          parent.name.text === "env"
            ? parent
            : undefined;
        if (!env) {
          add(n, "ident:process");
        } else if (!isEnvRead(env)) {
          add(env, "process-env-write");
        }
      } else if (execNames.has(n.text) && !isKey && !isMemberName) {
        const base = ts.isPropertyAccessExpression(parent) && parent.expression === n ? parent : n;
        const arg = callArg(base);
        add(n, arg === undefined ? "exec-ref" : "exec", arg);
      } else if (n.text.endsWith("ForTest") && !isKey) {
        const declared =
          (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
          parent.name === n;
        if (!declared) {
          add(n, `test-hook:${n.text}`);
        }
      }
    } else if (ts.isPropertyAccessExpression(n) && n.name.text === "runtime") {
      // `arg` is the whole member chain (api.runtime.llm.complete), so the one
      // allowed use cannot be retargeted to exec or media fetch.
      let chain: ts.Node = n;
      while (ts.isPropertyAccessExpression(chain.parent) && chain.parent.expression === chain) {
        chain = chain.parent;
      }
      add(n, "sdk-runtime", chain.getText(sf));
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(parent)) {
      // A destructured key is a member access under another name:
      // `const { runtime } = api`, `const { constructor: F } = () => 0`.
      const bound = n.propertyName ?? n.name;
      const name = ts.isIdentifier(bound) ? bound.text : "";
      if (name === "runtime") {
        add(n, "sdk-runtime");
      } else if (BANNED_MEMBERS.has(name)) {
        add(n, `destructure:${name}`);
      }
    } else if (ts.isPropertyAccessExpression(n) && BANNED_MEMBERS.has(n.name.text)) {
      add(n, `member:${n.name.text}`);
    } else if (n.kind === ts.SyntaxKind.ThisKeyword && thisOutsideClass(n)) {
      add(n, "this-outside-class");
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isBinaryExpression(n) ||
      ts.isTemplateExpression(n)
    ) {
      // A folded string key reaches the same thing as the name: api["runtime"],
      // Reflect.get(api, "run" + "time"), mod["resetScopelyGuardForTest"].
      const value = foldString(n);
      if (value === "runtime") {
        add(n, "sdk-runtime");
      } else if (value?.endsWith("ForTest")) {
        add(n, `test-hook:${value}`);
      } else if (value !== undefined && (BANNED_NAMES.has(value) || BANNED_MEMBERS.has(value))) {
        add(n, `string:${value}`);
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "require"
    ) {
      const spec = n.arguments[0];
      if (spec && ts.isStringLiteral(spec)) {
        checkSpec(n, spec.text, false);
      } else {
        add(n, "non-literal-require");
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const result = { findings, imports };
  scanCache.set(key, result);
  return result;
}

/**
 * EVERY existing file a relative specifier could load. A loader may map
 * "./x.js" to x.ts or "./x.ts" to x.js, so stopping at the first sibling would
 * let a clean x.ts hide an x.js that actually runs.
 */
function resolveRelative(from: string, spec: string, files: Map<string, string>): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.[cm]?[jt]s$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.js`, `${base}.ts`, `${base}/index.ts`];
  return [...new Set(candidates)].filter((candidate) => files.has(candidate));
}

/** Findings for the closure of `entry` over relative imports (unresolvable = finding). */
function scanClosure(files: Map<string, string>, entry = "index.ts"): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const { findings, imports } = scanFile(file, files.get(file) ?? "");
    out.push(...findings);
    for (const spec of imports) {
      const targets = resolveRelative(file, spec, files);
      if (targets.length > 0) {
        queue.push(...targets);
      } else {
        out.push({ file, line: 0, rule: "unresolvable-relative-import", arg: spec });
      }
    }
  }
  return out;
}

/** Findings ALLOW does not cover, plus any allowance that is no longer used exactly. */
function unallowed(findings: Finding[]): Finding[] {
  const used = new Map<string, number>();
  const bad = findings.filter((f) => {
    const key = `${f.file}|${f.rule}`;
    const allow = ALLOW[f.file]?.[f.rule];
    const count = used.get(key) ?? 0;
    if (!allow || count >= allow.n || (allow.arg && !allow.arg.test(f.arg ?? ""))) {
      return true;
    }
    used.set(key, count + 1);
    return false;
  });
  for (const [file, rules] of Object.entries(ALLOW)) {
    for (const [rule, allow] of Object.entries(rules)) {
      if ((used.get(`${file}|${rule}`) ?? 0) !== allow.n) {
        bad.push({ file, line: 0, rule: `stale-allowance:${rule}` });
      }
    }
  }
  return bad;
}

function loadFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(full);
      } else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) {
        out.set(path.relative(ROOT, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(ROOT);
  return out;
}

const FILES = loadFiles();

/** The closure with `edits` applied (file -> new source, or a function of the old one). */
function scanWith(edits: Record<string, string | ((src: string) => string)>): Finding[] {
  const files = new Map(FILES);
  for (const [file, edit] of Object.entries(edits)) {
    files.set(file, typeof edit === "string" ? edit : edit(files.get(file) ?? ""));
  }
  return unallowed(scanClosure(files));
}

const append = (code: string) => (src: string) => `${src}\n${code}\n`;
const APP = "https://api.vip.pscx.ai/api/v1/x";

describe("single choke point: AST scan of index.ts's import closure (AC-7.12)", () => {
  it("the production closure has only the allowlisted, pinned call sites", () => {
    const findings = scanClosure(FILES);
    // The walk really reached the guard and a gh-backed tool module.
    expect(findings).toContainEqual(
      expect.objectContaining({ file: "src/scopely-api.ts", rule: "call:fetch" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ file: "src/gh-tools.ts", rule: "exec" }),
    );
    expect(unallowed(findings)).toEqual([]);
  });

  // The red-team's evasion classes; each must fail the scan when injected
  // into an ordinary tool module.
  it.each([
    ["E0 direct fetch", `export async function x() { await fetch("${APP}", { method: "POST" }); }`],
    ["E1 alias const f = fetch", `const f = fetch; export const x = () => f("${APP}");`],
    ["E2 globalThis['fetch']", `export const x = () => globalThis["fetch"]("${APP}");`],
    ["E3 (0, fetch)()", `export const x = () => (0, fetch)("${APP}");`],
    ["E4 fetch?.()", `export const x = () => fetch?.("${APP}");`],
    ["E5 fetch.call", `export const x = () => fetch.call(undefined, "${APP}");`],
    ["E6 import([...].join)", `export const x = () => import(["node", "https"].join(":"));`],
    ["E7 import('ht' + 'tps')", `export const x = () => import("ht" + "tps");`],
    ["E8 node:dgram", `import dgram from "node:dgram"; export const x = dgram;`],
    ["E9 node:dns", `import dns from "node:dns"; export const x = dns;`],
    ["E10 destructured globalThis", `const { fetch: f } = globalThis; export const x = f;`],
    [
      "E11 Reflect.apply(fetch)",
      `export const x = () => Reflect.apply(fetch, undefined, ["${APP}"]);`,
    ],
    [
      "E12 require('child_' + 'process')",
      `declare const require: (s: string) => unknown; export const x = () => require("child_" + "process");`,
    ],
    ["E13 process.binding", `export const x = () => (process as any).binding("spawn_sync");`],
    [
      "E14 Reflect.get(globalThis, 'fe' + 'tch')",
      `export const x = Reflect.get(globalThis, "fe" + "tch");`,
    ],
    ["E15 new Function", `export const x = new Function("return 1")();`],
    [
      "E16 SDK value import",
      `import { fetchWithTimeout } from "openclaw/plugin-sdk/web-fetch"; export const x = fetchWithTimeout;`,
    ],
    ["E17 import('node:child_process')", `export const x = () => import("node:child_process");`],
    // Further classes closed by the same rules.
    ["node:https import", `import https from "node:https"; export const x = https;`],
    ["bare http import", `import * as http from "http"; export const x = http;`],
    ["worker_threads", `import { Worker } from "node:worker_threads"; export const x = Worker;`],
    [
      "createRequire via node:module",
      `import { createRequire } from "node:module"; export const x = createRequire;`,
    ],
    ["data: URL module", `export const x = () => import("data:text/javascript,export default 1");`],
    ["process.getBuiltinModule", `export const x = () => process.getBuiltinModule("node:https");`],
    ["process alias", `const p = process; export const x = p;`],
    ["Function via .constructor", `export const x = (() => 0).constructor("return 1");`],
    ["Function via folded key", `export const x = (() => 0)["constr" + "uctor"]("return 1");`],
    ["module.require", `declare const module: any; export const x = module.require("https");`],
    ["sloppy this", `export function x(this: unknown) { return this; }`],
    ["eval", `export const x = eval("1");`],
    ["XMLHttpRequest", `export const x = new XMLHttpRequest();`],
    ["WebSocket", `export const x = new WebSocket("wss://api.vip.pscx.ai/");`],
    ["test hook called from production", `resetScopelyGuardForTest();`],
    ["unresolvable relative import", `import "./missing-module.js";`],
  ])("detects %s injected into src/org-tools.ts", (_label, code) => {
    expect(scanWith({ "src/org-tools.ts": append(code) }).length).toBeGreaterThan(0);
  });

  // One row per rule, each caught by THAT rule (so dropping a banned name or a
  // branch fails a row even when another rule would also fire): the final
  // review's new evasions (N-ids) plus every rule that had no fixture.
  const API_DECL = "declare const api: any;\n";
  it.each([
    [
      "N01 api.runtime exec",
      "sdk-runtime",
      `${API_DECL}export const x = () => api.runtime.system.runCommandWithTimeout(["curl", "-X", "POST", "${APP}"], 5000);`,
    ],
    [
      "N02 api.runtime media fetch",
      "sdk-runtime",
      `${API_DECL}export const x = () => api.runtime.media.loadWebMedia("${APP}");`,
    ],
    [
      "N03 api.runtime node invoke",
      "sdk-runtime",
      `${API_DECL}export const x = () => api.runtime.nodes.invoke({ command: "system.run" });`,
    ],
    [
      "N04 api.runtime web search",
      "sdk-runtime",
      `${API_DECL}export const x = () => api.runtime.webSearch.search({ query: "x" });`,
    ],
    [
      "N05 api.runtime config write",
      "sdk-runtime",
      `${API_DECL}export const x = () => api.runtime.config.mutateConfigFile({ mutate: () => undefined });`,
    ],
    [
      "N06 alias of api.runtime",
      "sdk-runtime",
      `${API_DECL}const rt = api.runtime; export const x = () => rt.system.runCommandWithTimeout(["sh"], 1);`,
    ],
    [
      "N07 destructured off api.runtime",
      "sdk-runtime",
      `${API_DECL}const { system } = api.runtime; export const x = system;`,
    ],
    [
      "N08 element access below api.runtime",
      "sdk-runtime",
      `${API_DECL}export const x = () => api.runtime["system"]["runCommandWithTimeout"](["sh"], 1);`,
    ],
    [
      "destructured runtime",
      "sdk-runtime",
      `${API_DECL}const { runtime } = api; export const x = runtime;`,
    ],
    ["folded runtime key", "sdk-runtime", `${API_DECL}export const x = api["run" + "time"];`],
    [
      "Reflect.get runtime",
      "sdk-runtime",
      `${API_DECL}export const x = Reflect.get(api, "runtime");`,
    ],
    [
      "N11 destructured constructor",
      "destructure:constructor",
      `const { constructor: F } = () => 0; export const x = F("return 1")();`,
    ],
    [
      "N18 destructured module constructor",
      "destructure:constructor",
      `declare const module: any; const { constructor: M } = module; export const x = M._load("x");`,
    ],
    [
      "destructured getBuiltinModule",
      "destructure:getBuiltinModule",
      `export const x = ({ getBuiltinModule: g }: any) => g("node:https");`,
    ],
    [
      "N20 aliased test-hook import",
      "test-hook-import",
      `import { resetScopelyGuardForTest as r } from "./scopely-api.js"; r();`,
    ],
    [
      "N19 aliased profile test hook",
      "test-hook-import",
      `import { setBackendProfileForTest as s } from "./backend-profile.js"; s({ mode: "read-write" });`,
    ],
    [
      "test hook by string key",
      "test-hook:resetScopelyGuardForTest",
      `import * as m from "./scopely-api.js"; export const x = () => (m as any)["resetScopelyGuardForTest"]();`,
    ],
    [
      "N21 Worker",
      "ident:Worker",
      `export const w = new Worker("data:text/javascript,fetch('${APP}')");`,
    ],
    ["SharedWorker", "ident:SharedWorker", `export const w = new SharedWorker("data:x");`],
    [
      "importScripts",
      "ident:importScripts",
      `export const x = () => (importScripts as any)("${APP}");`,
    ],
    ["N26 TLS check off", "process-env-write", `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";`],
    ["N27 NODE_OPTIONS", "process-env-write", `process.env.NODE_OPTIONS = "--require /tmp/x.js";`],
    ["N19 VITEST spoof", "process-env-write", `process.env.VITEST = "1";`],
    ["env compound write", "process-env-write", `process.env.HTTPS_PROXY ??= "http://evil.test";`],
    ["env element write", "process-env-write", `process.env["NODE_OPTIONS"] = "x";`],
    ["env wrapped write", "process-env-write", `(process.env.VITEST as string) = "1";`],
    ["env increment", "process-env-write", `process.env.COUNT++;`],
    ["env delete", "process-env-write", `delete process.env.NO_PROXY;`],
    ["env Object.assign", "process-env-write", `Object.assign(process.env, { VITEST: "1" });`],
    ["env alias", "process-env-write", `const e = process.env; e.VITEST = "1";`],
    ["env replaced", "process-env-write", `process.env = {};`],
    ["EventSource", "ident:EventSource", `export const x = () => new EventSource("${APP}");`],
    ["global", "ident:global", `export const x = global;`],
    ["self", "ident:self", `export const x = self;`],
    ["window", "ident:window", `export const x = window;`],
    ["Bun", "ident:Bun", `export const x = Bun;`],
    ["Deno", "ident:Deno", `export const x = Deno;`],
    ["require as a value", "ident:require", `export const x = require;`],
    ["binding member", "member:binding", `export const x = (p: any) => p.binding("spawn_sync");`],
    ["mainModule member", "member:mainModule", `export const x = (p: any) => p.mainModule;`],
    [
      "_linkedBinding member",
      "member:_linkedBinding",
      `export const x = (p: any) => p._linkedBinding("x");`,
    ],
    ["dlopen member", "member:dlopen", `export const x = (p: any) => p.dlopen;`],
    [
      "getBuiltinModule member",
      "member:getBuiltinModule",
      `export const x = (p: any) => p.getBuiltinModule("x");`,
    ],
    ["node:net import", "module:node:net", `import net from "node:net"; export const x = net;`],
    ["export * from", "module:node:net", `export * from "node:net";`],
    [
      "import = require",
      "module:node:net",
      `import net = require("node:net"); export const x = net;`,
    ],
  ])("detects %s by rule %s", (_label, rule, code) => {
    const rules = scanWith({ "src/org-tools.ts": append(code) }).map((f) => f.rule);
    expect(rules).toContain(rule);
  });

  // The documented limits of a static tripwire (the header says what covers
  // them): each of these still passes the scan. A row moves to the table
  // above only with a new rule, never a looser test.
  it.each([
    [
      "N09 a new inbound route (not app egress)",
      `${API_DECL}export const x = () => api.registerHttpRoute({ path: "/x", handler: () => true });`,
    ],
    [
      "N12 a base64-decoded constructor key",
      `const k = Buffer.from("Y29uc3RydWN0b3I=", "base64").toString(); export const x = (() => 0)[k]("return 1")();`,
    ],
    [
      "N13 a joined constructor key",
      `export const x = (() => 0)[["constr", "uctor"].join("")]("return 1")();`,
    ],
    [
      "N14 an enumerated constructor key",
      `const p = Object.getPrototypeOf(() => 0); const n = Object.getOwnPropertyNames(p).find((k) => k.length === 11)!; export const x = p[n]("return 1")();`,
    ],
    [
      "N15 an atob constructor key",
      `export const x = (() => 0)[atob("Y29uc3RydWN0b3I=")]("return 1")();`,
    ],
    [
      "N16 a fromCharCode constructor key",
      `export const x = (() => 0)[String.fromCharCode(99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114)]("return 1")();`,
    ],
    [
      "N17 a JSON.parse constructor key",
      `export const x = (() => 0)[JSON.parse('"constructor"')]("return 1")();`,
    ],
  ])("documented limit, not caught statically: %s", (_label, code) => {
    expect(scanWith({ "src/org-tools.ts": append(code) })).toEqual([]);
  });

  it("documented limit N39: only an exec call's first argument is pinned (gh-tools is registry-blocked, F4)", () => {
    const edit = (src: string) =>
      src.replace('execFileSync("gh", args', `execFileSync("gh", ["api", "-X", "POST", "${APP}"]`);
    expect(edit(FILES.get("src/gh-tools.ts") ?? "")).not.toBe(FILES.get("src/gh-tools.ts"));
    expect(scanWith({ "src/gh-tools.ts": edit })).toEqual([]);
  });

  // A clean twin must not hide the file that actually loads: every existing
  // candidate (x.ts and x.js) of a relative specifier is scanned.
  it.each([
    ["./dup", "src/dup.js"],
    ["./dup.js", "src/dup.js"],
    ["./dup.ts", "src/dup.js"],
    ["./dup", "src/dup.ts"],
    ["./dup.js", "src/dup.ts"],
    ["./dup.ts", "src/dup.ts"],
  ])("import %j scans the fetching twin %s", (spec, evil) => {
    const bad = scanWith({
      "src/dup.ts": "export const a = 1;",
      "src/dup.js": "export const a = 1;",
      [evil]: `export const f = () => fetch("${APP}", { method: "POST" });`,
      "src/org-tools.ts": append(`import "${spec}";`),
    });
    expect(bad).toContainEqual(expect.objectContaining({ file: evil, rule: "call:fetch" }));
  });

  it("detects a production module hidden behind a *.test.ts name once it is imported", () => {
    const bad = scanWith({
      "src/hidden.test.ts": `export async function leak() { await fetch("${APP}", { method: "POST" }); }`,
      "src/org-tools.ts": (src) => `import "./hidden.test.js";\n${src}`,
    });
    expect(bad).toContainEqual(expect.objectContaining({ file: "src/hidden.test.ts" }));
  });

  // The legacy env-password cookie login (scopely-auth.ts) was deleted in
  // PK-7a; re-adding it and importing it (static, extensionless or dynamic)
  // fails the scan through the closure, whatever the file is called.
  it.each([
    ["static", `import { scopelyLogin } from "./scopely-auth.js"; void scopelyLogin;`],
    ["extensionless", `import { scopelyLogin } from "./scopely-auth"; void scopelyLogin;`],
    ["dynamic", `export const x = () => import("./scopely-auth");`],
  ])("detects a re-added legacy login module imported %s", (_label, importer) => {
    const bad = scanWith({
      "src/scopely-auth.ts": `export async function scopelyLogin() {\n  return fetch(\`\${process.env.SCOPELY_BASE_URL}/api/auth/login/\`, { method: "POST" });\n}`,
      "src/org-tools.ts": append(importer),
    });
    expect(bad).toContainEqual(expect.objectContaining({ file: "src/scopely-auth.ts" }));
  });

  it.each([
    [
      "a NEW fetch in allowlisted comfort.ts (count is exact)",
      "src/comfort.ts",
      append(
        `export const leak = () => fetch(\`https://\${["api", "vip"].join(".")}.pscx.ai/x\`);`,
      ),
    ],
    [
      "the allowed api.runtime use retargeted from the LLM to exec (chain is pinned)",
      "index.ts",
      (src: string) =>
        src.replace(
          "api.runtime.llm.complete(params)",
          "api.runtime.system.runCommandWithTimeout(params)",
        ),
    ],
    [
      "a second api.runtime LLM call in index.ts (count is exact)",
      "index.ts",
      append("export const judge = (api: any) => api.runtime.llm.complete({});"),
    ],
    [
      "an allowed comfort.ts fetch retargeted off Zoom (argument is pinned)",
      "src/comfort.ts",
      (src: string) => src.replace('"https://api.zoom.us/v2/im/chat/messages"', `"${APP}"`),
    ],
    [
      "a stale allowance (an allowed fetch removed)",
      "src/comfort.ts",
      (src: string) =>
        src.replace(
          'await fetch("https://api.zoom.us/v2/im/chat/messages"',
          'await zoomPost("https://api.zoom.us/v2/im/chat/messages"',
        ),
    ],
    [
      "gh-tools exec retargeted from gh to curl",
      "src/gh-tools.ts",
      (src: string) => src.replace('execFileSync("gh", args', 'execFileSync("curl", args'),
    ],
    [
      "a child_process binding used without a call (alias)",
      "src/gh-tools.ts",
      append("export const run = execFileSync;"),
    ],
  ])("detects %s", (_label, file, edit) => {
    const before = FILES.get(file);
    const after = (edit as (src: string) => string)(before ?? "");
    expect(after).not.toBe(before); // the fixture really changed the file
    expect(scanWith({ [file]: edit }).length).toBeGreaterThan(0);
  });

  // The count alone catches this one: its argument passes the Zoom pin. The
  // finding names the extra call site itself, not only the stale count.
  it("names a NEW pinned-looking fetch in allowlisted comfort.ts (count is exact)", () => {
    const code = `export const leak = () => fetch("https://api.zoom.us/v2/x");`;
    expect(scanWith({ "src/comfort.ts": append(code) })).toContainEqual(
      expect.objectContaining({
        file: "src/comfort.ts",
        rule: "call:fetch",
        arg: '"https://api.zoom.us/v2/x"',
      }),
    );
  });

  it("does not flag type-only SDK imports, prose that says fetch, or fetch-named locals", () => {
    const files = new Map(FILES);
    files.set(
      "src/org-tools.ts",
      `${files.get("src/org-tools.ts")}\nimport type { OpenClawPluginApi as A } from "openclaw/plugin-sdk";\n// we fetch things here\nexport const fetchHealth = 1;\nexport const label = "fetches the vendor list";\nexport type B = A;\n`,
    );
    expect(unallowed(scanClosure(files))).toEqual([]);
  });
});
