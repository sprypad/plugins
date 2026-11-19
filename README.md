# Spry plugins

The open list of plugins for [Spry](https://sprypad.com) — notes, data and files in one folder you own.

Spry's **Settings ▸ Plugins ▸ Browse plugins…** reads `index.json` from this repository. Each plugin is a folder under `plugins/`; a build step (`build.py`) turns it into a package
(`packages/<id>-<version>.tnp`) and lists it, with the package's checksum, in `index.json`. Spry downloads a package only when you press Install, and refuses one whose checksum is not
the listed one.

## What is here

| | |
|---|---|
| `plugins/<id>/` | the source of each plugin: `plugin.json`, its page half (`index.js`), and a README |
| `packages/` | the built `.tnp` packages (generated — do not edit by hand) |
| `index.json` | the list Spry reads (generated) |
| `reviewed.json` | which plugin versions someone from the project has looked at: `{ "plugin-id": ["1.0"] }` |
| `build.py` | builds `packages/` and `index.json`; `python build.py --check` is what the checks run |

## Using a plugin

Open **Settings ▸ Plugins ▸ Browse plugins…**, press **Install** on a plugin, read what it can do, and confirm. A plugin runs inside Spry, so install only plugins you trust. A plugin
marked **Not reviewed yet** has not been looked at by the project; **Reviewed** means someone has read its code at that version.

## Making a plugin

See [CONTRIBUTING.md](CONTRIBUTING.md). Plugins are plain JavaScript; Spry's own guide to writing one is `docs/plugins.md` in the Spry repository, and `plugins/epub-importer/` is a complete example
(an *importer*: it turns EPUB books into notes).
