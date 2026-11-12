"""Parse editor text as data. Run with -I -S; never import the scene or Manim."""
import ast
import json
import sys

BASES = {"Scene", "ThreeDScene", "MovingCameraScene", "ZoomedScene", "VectorScene", "LinearTransformationScene"}


def sanitize_code(text):
    """Replace IPython cell/line magics and shell escapes with comments to preserve line numbers."""
    lines = text.splitlines(keepends=True)
    cleaned = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith(("%", "!", "?")):
            cleaned.append("# [magic] " + line)
        else:
            cleaned.append(line)
    return "".join(cleaned)


def extract_notebook_code(text):
    """Extract and concatenate code cells from a .ipynb JSON string."""
    try:
        nb = json.loads(text)
        if isinstance(nb, dict) and "cells" in nb:
            code_parts = []
            for cell in nb.get("cells", []):
                if cell.get("cell_type") == "code":
                    src = "".join(cell.get("source", []))
                    code_parts.append(sanitize_code(src))
                    code_parts.append("\n")
            return "".join(code_parts)
    except Exception:
        pass
    return None


def discover(source):
    nb_code = extract_notebook_code(source)
    if nb_code is not None:
        source = nb_code
    else:
        source = sanitize_code(source)

    tree = ast.parse(source)
    # Pre-populate roots with BASES so scenes in notebook cells without local 'from manim import *' are recognized
    roots = set(BASES)
    modules = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "manim":
            for alias in node.names:
                if alias.name == "*":
                    roots.update(BASES)
                elif alias.name in BASES:
                    roots.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "manim":
                    modules.add(alias.asname or alias.name)
    candidates = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        known = any(
            (isinstance(base, ast.Name) and base.id in roots)
            or (isinstance(base, ast.Attribute) and isinstance(base.value, ast.Name)
                and base.value.id in modules and base.attr in BASES)
            for base in node.bases
        )
        if known:
            roots.add(node.name)
            candidates.append({"name": node.name, "line": node.lineno})
    return candidates


if __name__ == "__main__":
    try:
        result = {"scenes": discover(sys.stdin.read(2 * 1024 * 1024))}
    except SyntaxError as error:
        result = {"scenes": [], "error": f"Syntax error on line {error.lineno}: {error.msg}"}
    print(json.dumps(result, ensure_ascii=True))

