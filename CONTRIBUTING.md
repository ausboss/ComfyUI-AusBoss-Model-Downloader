# Contributing

This addon owns the download backend and Workflow Note adapter. ComfyUI-AusBoss remains a separate project.

## Local checks

Python 3.10+ and Node.js 22+ are sufficient for the offline tests. Use a virtual environment:

```bash
python -m venv .venv
```

Activate it (`source .venv/bin/activate` on Linux/macOS, or `.venv\Scripts\Activate.ps1` in PowerShell), then:

```bash
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
ruff check --select F,E9 __init__.py downloader tests
node --test tests/*.test.mjs
node --check js/model_downloader/index.js
```

Tests use temporary directories and simulated provider responses. They do not need credentials or download model files.

For frontend changes, check the actual ComfyUI canvas in Classic and Nodes 2.0: add a row, resize, save/reload, reorder, and check Workflow Note integration. Provider changes also need a small real public-model transfer into an isolated model folder.

## Rules

- Loading or queueing a workflow must never initiate downloads. Keep transfers behind explicit buttons.
- Validate model extensions, provider hosts, redirects, and destinations on the server. Do not permit code folders or arbitrary paths.
- Keep credentials out of workflow properties, presets, browser storage, logs, screenshots, and commits.
- Send provider authorization only to that provider's exact host. Preserve user/job ownership checks.
- Do not overwrite existing model files. Keep partial files separate until verification succeeds.
- Preserve the serialized node ID and model-list format. Chain frontend lifecycle callbacks and dispose observers/listeners.
- Refresh vendored UI modules deliberately; see [shared-components.md](docs/shared-components.md).

GitHub Actions runs offline checks only. There is no automatic Registry publication workflow in this repository.
