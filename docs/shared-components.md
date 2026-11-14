# Shared AusBoss components

Vendored unchanged from ComfyUI-AusBoss commit `be2a2a1444379129e82e2b006b4c4665749bd2ab` (2.26.2), under the same MIT license:

- `js/shared/index.mjs`
- `js/shared/theme.mjs`
- `js/shared/panel_controls.mjs`
- `js/shared/panel_layout.mjs`
- `js/shared/canvas_passthrough.mjs`

Refresh deliberately from the main pack and test both renderers. `models.mjs`, `download_controls.mjs`, and the downloader frontend are owned by this addon.

## The look

The node face follows the main pack: a near-black card, solid gray controls with no outlines, and one teal accent. Every colour, corner size, control height and the font come from `theme.mjs`; the addon's own files type no colours. The two exceptions are the node's title and body colours in `js/model_downloader/index.js`, which are the main pack's default node scheme.

`download_controls.mjs` gives the pack's compact button the tones a download needs, all from the palette: `primary` (Download), `danger` (Cancel), `success` (Installed), `neutral` (utilities) and `quiet` (remove). The same buttons are added to Workflow Note rows; other main-pack controls are unaffected. Icons are 14px SVG strokes. Icon-only buttons keep descriptive labels and tooltips.

The list is a table. One set of column widths (`COLUMNS` in `js/model_downloader/index.js`) is shared by the heading and every row, so statuses, sizes and buttons line up. The status column holds a short word only; the size has its own right-aligned column.

## Scripts after an update

ComfyUI sends no cache header for `.mjs` files, so a browser could run an old helper script beside a new entry script. `downloader/frontend_cache.py` serves this addon's scripts with a version tag on every relative `.mjs` import and `Cache-Control: no-cache` on the `.mjs` files, the same way the main pack does. Write those imports as plain strings; `tests/test_frontend_cache.py` fails on one built in code.
