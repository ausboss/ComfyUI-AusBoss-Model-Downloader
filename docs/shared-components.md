# Shared AusBoss components

Vendored unchanged from ComfyUI-AusBoss commit `3a4ce52760f1fb485c1b54020e9fd637fbdeb360` (2.21.1), under the same MIT license:

- `js/shared/index.mjs`
- `js/shared/panel_controls.mjs`
- `js/shared/panel_layout.mjs`
- `js/shared/canvas_passthrough.mjs`

Refresh deliberately from the main pack and test both renderers. `models.mjs`, `download_controls.mjs`, and the downloader frontend are owned by this addon.

`download_controls.mjs` wraps the vendored compact button with scoped color variants: teal `#00B4AA` download actions, slate-teal `#14424D` titles, near-black `#161F21` bodies, mint `#6FC0AA` installed status, amber `#F5B53D` missing status, neutral utilities, and red errors/removal. The same variants style download buttons added to Workflow Notes; other main-pack controls are unaffected. Reorder and download controls use 16px SVG icons with rounded 2.25px strokes. Icon-only buttons retain descriptive accessible labels and tooltips.
