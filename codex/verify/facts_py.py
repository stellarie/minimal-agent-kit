"""Extract syntax facts from Python source on stdin. Print them as JSON.

Facts: functions (name, start, end, passthrough), calls (name, line), interface (public symbols),
imports (candidate module names, relative level, lines), classes (lines).
"""

import ast
import json
import sys


def call_name(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    elif isinstance(node, ast.Call):
        parts.append(call_name(node.func) + "()")
    return ".".join(reversed(parts))


def params(fn):
    a = fn.args
    return [p.arg for p in a.posonlyargs + a.args] + ([a.vararg.arg] if a.vararg else [])


def passthrough(fn):
    body = fn.body
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant):
        body = body[1:]
    if len(body) != 1 or not isinstance(body[0], (ast.Return, ast.Expr)):
        return False
    call = body[0].value
    if not isinstance(call, ast.Call) or call.keywords:
        return False
    args = []
    for arg in call.args:
        if isinstance(arg, ast.Starred) and isinstance(arg.value, ast.Name):
            args.append(arg.value.id)
        elif isinstance(arg, ast.Name):
            args.append(arg.id)
        else:
            return False
    names = params(fn)
    if names and names[0] in ("self", "cls"):
        names = names[1:]
    return bool(names) and args == names and not fn.decorator_list


def signature(fn):
    return f"{fn.name}({', '.join(params(fn))})"


def interface(tree):
    explicit = None
    out = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = signature(node)
        elif isinstance(node, ast.ClassDef):
            out[node.name] = f"class {node.name}"
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                    explicit = {e.value for e in node.value.elts if isinstance(e, ast.Constant)}
    keep = explicit if explicit is not None else {n for n in out if not n.startswith("_")}
    return sorted(v for k, v in out.items() if k in keep)


def facts(source):
    tree = ast.parse(source)
    functions, calls, imports, classes = [], [], [], []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append({
                "name": node.name, "start": node.lineno, "end": node.end_lineno,
                "passthrough": passthrough(node),
            })
        elif isinstance(node, ast.ClassDef):
            classes.append({"start": node.lineno, "end": node.end_lineno})
        elif isinstance(node, ast.Call):
            calls.append({"name": call_name(node.func), "line": node.lineno})
        elif isinstance(node, ast.Import):
            for a in node.names:
                imports.append({"specs": [a.name], "level": 0, "start": node.lineno, "end": node.end_lineno})
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            specs = [f"{mod}.{a.name}" if mod else a.name for a in node.names] + ([mod] if mod else [])
            imports.append({"specs": specs, "level": node.level, "start": node.lineno, "end": node.end_lineno})
    return {"functions": functions, "calls": calls, "interface": interface(tree), "imports": imports, "classes": classes}


if __name__ == "__main__":
    try:
        print(json.dumps(facts(sys.stdin.read())))
    except SyntaxError as e:
        print(json.dumps({"error": f"syntax error line {e.lineno}: {e.msg}"}))
