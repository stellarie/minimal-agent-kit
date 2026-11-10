// Extract syntax facts from JS or JSX source on stdin. Print them as JSON.
// Facts: functions (name, start, end, passthrough), calls (name, line), interface
// (exports, Express routes, React component props), imports (module specifiers, lines),
// classes (lines). Uses the vendored acorn.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("./vendor/", import.meta.url));
const acorn = require("acorn");
const jsx = require("acorn-jsx");
const Parser = acorn.Parser.extend(jsx());

const VERBS = new Set(["get", "post", "put", "patch", "delete", "all", "use", "head", "options"]);

function parse(src) {
  const opts = { ecmaVersion: "latest", locations: true, allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return Parser.parse(src, { ...opts, sourceType: "module" });
  } catch {
    return Parser.parse(src, { ...opts, sourceType: "script" });
  }
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, node));
    else if (v && typeof v.type === "string" && key !== "loc") walk(v, visit, node);
  }
}

function dotted(n) {
  if (n.type === "Identifier") return n.name;
  if (n.type === "ThisExpression") return "this";
  if (n.type === "MemberExpression" && !n.computed) return `${dotted(n.object)}.${n.property.name}`;
  if (n.type === "CallExpression") return `${dotted(n.callee)}()`;
  return "?";
}

function fnName(fn, parent) {
  if (fn.id) return fn.id.name;
  if (!parent) return "<anonymous>";
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key.type === "Identifier") return parent.key.name;
  if (parent.type === "AssignmentExpression") return dotted(parent.left);
  return "<anonymous>";
}

function paramNames(fn) {
  const out = [];
  for (const p of fn.params) {
    if (p.type === "Identifier") out.push(p.name);
    else if (p.type === "RestElement" && p.argument.type === "Identifier") out.push(p.argument.name);
    else return null;
  }
  return out;
}

function passthrough(fn) {
  let call = null;
  if (fn.body.type !== "BlockStatement") call = fn.body;
  else if (fn.body.body.length === 1) {
    const st = fn.body.body[0];
    if (st.type === "ReturnStatement") call = st.argument;
    else if (st.type === "ExpressionStatement") call = st.expression;
  }
  if (!call || call.type !== "CallExpression") return false;
  const names = paramNames(fn);
  if (!names) return false;
  const args = [];
  for (const a of call.arguments) {
    if (a.type === "Identifier") args.push(a.name);
    else if (a.type === "SpreadElement" && a.argument.type === "Identifier") args.push(a.argument.name);
    else return false;
  }
  return names.length > 0 && args.length === names.length && args.every((a, i) => a === names[i]);
}

function hasJsx(fn) {
  let found = false;
  walk(fn.body, (n) => { if (n.type === "JSXElement" || n.type === "JSXFragment") found = true; });
  return found;
}

function facts(src) {
  const tree = parse(src);
  const functions = [];
  const calls = [];
  const iface = new Set();
  const imports = [];
  const classes = [];
  const lines = (n) => ({ start: n.loc.start.line, end: n.loc.end.line });
  const isString = (a) => a && a.type === "Literal" && typeof a.value === "string";
  walk(tree, (n, parent) => {
    if (n.type === "ImportDeclaration" || ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source)) {
      imports.push({ specs: [n.source.value], level: 0, ...lines(n) });
    } else if (n.type === "ImportExpression" && isString(n.source)) {
      imports.push({ specs: [n.source.value], level: 0, ...lines(n) });
    } else if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && isString(n.arguments[0])) {
      imports.push({ specs: [n.arguments[0].value], level: 0, ...lines(n) });
    } else if (n.type === "ClassDeclaration" || n.type === "ClassExpression") {
      classes.push(lines(n));
    }
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      const name = fnName(n, parent);
      functions.push({ name, start: n.loc.start.line, end: n.loc.end.line, passthrough: passthrough(n) });
      const first = n.params[0];
      if (/^[A-Z]/.test(name) && first && first.type === "ObjectPattern" && hasJsx(n)) {
        const keys = first.properties.map((p) => (p.type === "RestElement" ? `...${p.argument.name}` : p.key.name ?? p.key.value));
        iface.add(`props ${name}{${keys.join(",")}}`);
      }
    } else if (n.type === "CallExpression") {
      const name = dotted(n.callee);
      calls.push({ name, line: n.loc.start.line });
      const c = n.callee;
      const path = n.arguments[0];
      if (c.type === "MemberExpression" && !c.computed && VERBS.has(c.property.name)
          && path && path.type === "Literal" && typeof path.value === "string" && path.value.startsWith("/")) {
        iface.add(`route ${c.property.name.toUpperCase()} ${path.value}`);
      }
    } else if (n.type === "ExportNamedDeclaration") {
      const d = n.declaration;
      if (d && d.id) iface.add(`export ${d.id.name}`);
      if (d && d.declarations) d.declarations.forEach((v) => v.id.type === "Identifier" && iface.add(`export ${v.id.name}`));
      n.specifiers.forEach((s) => iface.add(`export ${s.exported.name ?? s.exported.value}`));
    } else if (n.type === "ExportDefaultDeclaration") {
      iface.add("export default");
    } else if (n.type === "AssignmentExpression") {
      const left = n.left.type === "MemberExpression" ? dotted(n.left) : "";
      if (left === "module.exports" && n.right.type === "ObjectExpression") {
        n.right.properties.forEach((p) => p.key && iface.add(`export ${p.key.name ?? p.key.value}`));
      } else if (left === "module.exports") iface.add("export default");
      else if (left.startsWith("exports.") || left.startsWith("module.exports.")) iface.add(`export ${left.split(".").pop()}`);
    }
  });
  return { functions, calls, interface: [...iface].sort(), imports, classes };
}

try {
  process.stdout.write(JSON.stringify(facts(readFileSync(0, "utf8"))));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: `parse error: ${e.message}` }));
}
