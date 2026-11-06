#!/usr/bin/env python3
"""Verify the archive produced by `comfy node pack` before publication."""

from pathlib import Path
import tomllib
import zipfile


def main():
    root = Path(__file__).resolve().parent.parent
    config = tomllib.loads((root / "pyproject.toml").read_text())
    assert config["project"]["name"] == "ausboss-model-downloader"
    assert config["tool"]["comfy"]["PublisherId"] == "ausboss"
    assert config["project"]["urls"]["Repository"] == (
        "https://github.com/ausboss/ComfyUI-AusBoss-Model-Downloader"
    )
    assert not config["tool"]["comfy"].get("includes"), "No force-included directories"
    expected = {"__init__.py", "pyproject.toml", "LICENSE", "README.md", "CONTRIBUTING.md"}
    for folder, extensions in [("downloader", {".py"}), ("js", {".js", ".mjs"}),
                               ("docs", {".md", ".png"})]:
        expected.update(str(p.relative_to(root)) for p in (root / folder).rglob("*")
                        if p.is_file() and p.suffix in extensions)
    with zipfile.ZipFile(root / "node.zip") as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "Duplicate archive entries"
        assert set(names) == expected, (
            f"Missing: {sorted(expected - set(names))}; extra: {sorted(set(names) - expected)}"
        )
        assert archive.testzip() is None, "Archive checksum failure"
        for name in sorted(expected):
            assert archive.read(name) == (root / name).read_bytes(), f"Content mismatch: {name}"
            print(name)
    print(f"Verified {len(expected)} files; runtime code and documentation match this checkout.")


if __name__ == "__main__":
    main()
