#!/usr/bin/env python3
"""Build the open repository's list and packages (the sprypad/plugins repository keeps a copy of this file as build.py).

    python build.py            write packages/<id>-<version>.tnp for every plugin under plugins/ and index.json
    python build.py --check    change nothing; fail (exit 1) if a plugin is wrong or if index.json / packages/ are not what building would make

A plugin is a folder `plugins/<id>/` with a `plugin.json`, its page half, and (if it likes) a README.md, a picture. The package is a zip of that folder written in order with a fixed time, so the
same folder always gives the same bytes and the same sha256: the list names that checksum and Spry refuses a download that does not match it (core/pluginstore.py).
Which plugins the project has looked at is `reviewed.json`: { "plugin-id": ["1.0"] } -- a plugin is "reviewed" only at a version named there.

The rules here are the ones Spry applies when it opens a package (core/pluginpkg.py); a plugin that passes here installs there. Standard library only.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent if (Path(__file__).resolve().parent / "plugins").is_dir() else Path(__file__).resolve().parent.parent
SLUG = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
SUFFIXES = (".json", ".js", ".md", ".txt", ".png", ".jpg", ".jpeg", ".svg")
MAX_PACKAGE = 4 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
MAX_FILES = 30
API = 0
PERMISSIONS = ("note.read", "note.write", "notes.read", "speech", "files.import", "network")          # the permissions Spry knows (core/permissions.py)
RAW = "https://raw.githubusercontent.com/sprypad/plugins/main/"


def package_bytes(folder: Path) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(p for p in folder.rglob("*") if p.is_file() and not any(part.startswith(".") for part in p.relative_to(folder).parts)):
            info = zipfile.ZipInfo(path.relative_to(folder).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    return out.getvalue()


def problems_of(folder: Path) -> list[str]:
    found: list[str] = []
    try:
        manifest = json.loads((folder / "plugin.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [f"plugin.json cannot be read ({error})"]
    if not isinstance(manifest, dict):
        return ["plugin.json must be an object"]
    if manifest.get("id") != folder.name or not SLUG.match(str(manifest.get("id", ""))):
        found.append(f"id must be the folder's name ({folder.name!r}): 2 to 41 lowercase letters, digits and dashes, starting with a letter")
    for key in ("title", "description", "version"):
        if not str(manifest.get(key) or "").strip():
            found.append(f"{key} is needed")
    if manifest.get("api", API) != API:
        found.append(f"api must be {API}")
    page = str(manifest.get("page") or "")
    if not page.endswith(".js") or ".." in Path(page).parts or not (folder / page).is_file():
        found.append("page must be a .js file in the folder")
    for name in manifest.get("permissions") or []:
        if name not in PERMISSIONS:
            found.append(f"unknown permission {name!r}")
    for name in manifest.get("handles") or []:
        if not (isinstance(name, str) and re.fullmatch(r"\.[a-z0-9]{1,10}", name)):
            found.append(f"handles must be extensions like .epub, not {name!r}")
    files = [p for p in folder.rglob("*") if p.is_file() and not any(part.startswith(".") for part in p.relative_to(folder).parts)]
    if len(files) > MAX_FILES:
        found.append(f"{len(files)} files; the limit is {MAX_FILES}")
    for path in files:
        name = path.relative_to(folder).as_posix()
        if not name.lower().endswith(SUFFIXES):
            found.append(f"{name}: a plugin may not hold this kind of file (only {', '.join(SUFFIXES)})")
        if path.stat().st_size > MAX_FILE:
            found.append(f"{name}: over {MAX_FILE // 1024} KB")
    return found


def build(root: Path = ROOT) -> tuple[dict, dict[str, bytes], list[str]]:
    """(the list, {package name: bytes}, problems)."""
    reviewed = {}
    try:
        reviewed = json.loads((root / "reviewed.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    entries, packages, problems = [], {}, []
    for folder in sorted(p for p in (root / "plugins").iterdir() if p.is_dir() and not p.name.startswith(".")) if (root / "plugins").is_dir() else []:
        found = problems_of(folder)
        problems += [f"{folder.name}: {line}" for line in found]
        if found:
            continue
        manifest = json.loads((folder / "plugin.json").read_text(encoding="utf-8"))
        data = package_bytes(folder)
        if len(data) > MAX_PACKAGE:
            problems.append(f"{folder.name}: the package is over {MAX_PACKAGE // 1024} KB")
            continue
        name = f"{manifest['id']}-{manifest['version']}.tnp"
        packages[name] = data
        permissions = [n for n in manifest.get("permissions") or [] if isinstance(n, str)]
        entries.append({
            "id": manifest["id"], "title": manifest["title"], "description": manifest["description"], "version": str(manifest["version"]),
            "author": str(manifest.get("author") or ""), "homepage": str(manifest.get("homepage") or ""),
            "download": f"packages/{name}", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "api": manifest.get("api", API),
            "needs": list(manifest.get("needs") or []), "permissions": permissions, "kinds": list(manifest.get("kinds") or []),
            "extensions": [e for e in (manifest.get("handles") or []) if isinstance(e, str)],
            "review": "reviewed" if str(manifest["version"]) in (reviewed.get(manifest["id"]) or []) else "unreviewed",
        })
    return {"version": 1, "plugins": entries}, packages, problems


def render(index: dict) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    index, packages, problems = build()
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    wanted = render(index)
    have = (ROOT / "index.json").read_text(encoding="utf-8") if (ROOT / "index.json").is_file() else ""
    folder = ROOT / "packages"
    existing = {p.name: p.read_bytes() for p in folder.glob("*.tnp")} if folder.is_dir() else {}
    if check:
        if have != wanted or existing != packages:
            print("index.json or packages/ are not what building the plugins makes: run `python build.py` and commit the result.", file=sys.stderr)
            return 1
        print(f"ok: {len(index['plugins'])} plugin(s)")
        return 0
    folder.mkdir(exist_ok=True)
    for stale in set(existing) - set(packages):
        (folder / stale).unlink()
    for name, data in packages.items():
        (folder / name).write_bytes(data)
    (ROOT / "index.json").write_text(wanted, encoding="utf-8")
    print(f"wrote index.json and {len(packages)} package(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
