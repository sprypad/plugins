# Spry importers (the importer pack)

One plugin that brings **kinds of file Spry does not open by itself** into your notes, so you install it once and get them all. For now: **EPUB books**. More kinds are added to this one plugin
(and a new version listed) as they are written; the Import window offers to install it the first time you import a file it can convert.

Install it from **Settings ▸ Plugins ▸ Browse plugins…** (or copy this folder into your Plugins folder and Reload plugins). After that, **File ▸ Import…** (or dragging an `.epub` into the file tree)
offers **Convert**, which makes a note of the book: its chapters in order, with headings, emphasis, lists, quotes, code, tables, links and pictures. The book is left where it was. A book with
copy protection (DRM) cannot be read; the importer says so.

It is also the example of an importer plugin: see docs/plugins.md, "Importer plugins". One plugin may add many importers (`api.points.importers.add(...)` once for each kind of file); `handles` in
`plugin.json` lists the extensions it takes, so the list can tell Spry which plugin to offer for a file.
