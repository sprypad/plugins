# Adding a plugin

1. **Make a folder** `plugins/<id>/`. The id is 2–41 lowercase letters, digits and dashes, starting with a letter, and it is the folder's name.
2. **Write `plugin.json`**:
   ```json
   { "id": "my-plugin", "title": "My plugin", "description": "What it does, in a sentence.", "version": "1.0", "api": 0,
     "page": "index.js", "permissions": [], "author": "Your name", "homepage": "https://…", "kinds": ["importer"] }
   ```
   `permissions` must name everything of the person's that the plugin reads (`note.read`, `notes.read`, `note.write`, `speech`, `files.import`, `network`). Name only what it uses.
3. **Write `index.js`** — one JavaScript file (an ES module, 2 MB at most; bundle it if it grows). Only these kinds of file may be in the folder: `.json .js .md .txt .png .jpg .svg`.
   No Python, no links, at most 30 files.
4. **Put a `README.md` and a licence** in the folder so people know what it does and may use it.
5. **Run `python build.py`** and commit what it writes (`packages/…` and `index.json`). `python build.py --check` is what the pull request checks run.
6. **Open a pull request.** A change to an existing plugin must raise its `version`.

## What a reviewer looks at

- That `permissions` names everything the code reaches for, and nothing more.
- That the code does what the description says and nothing else (no hidden requests, no reading what it does not need).
- An importer's `convert` function runs in a sealed worker: it must be self-contained (see Spry's `docs/plugins.md`, "Importer plugins").

When someone has read a plugin's code at a version, that version is added to `reviewed.json` and Spry shows **Reviewed** for it. Until then it shows **Not reviewed yet** — it can still be
listed here, and people may install it, knowing that.

## Not allowed

A plugin that collects what it was not asked to, hides what it does, or sends the person's notes anywhere without saying so (the `network` permission) is removed from the list.
