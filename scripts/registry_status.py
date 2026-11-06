#!/usr/bin/env python3
"""Read the exact version's Registry result. A successful upload is not approval."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import tomllib
import urllib.request

NODE_ID = "ausboss-model-downloader"
STATUS_URL = f"https://api.comfy.org/nodes/{NODE_ID}/versions?include_status_reason=true"
STATUSES = {
    "NodeVersionStatusActive": "Approved by the Registry.",
    "NodeVersionStatusPending": "Review is pending; not approved yet.",
    "NodeVersionStatusFlagged": "Flagged for review; not approved. Inspect the finding before changing code.",
    "NodeVersionStatusBanned": "Banned by the Registry. Inspect the finding before taking further action.",
    "NodeVersionStatusDeleted": "This Registry version was deleted.",
    "NotPublished": "This exact version is not listed in the Registry.",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="Defaults to pyproject.toml")
    parser.add_argument("--report", action="store_true", help="Report Pending/Flagged without failing the job")
    parser.add_argument("--require-unpublished", action="store_true", help="Fail if this version already exists")
    args = parser.parse_args()
    try:
        version = args.version or tomllib.loads(
            (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text()
        )["project"]["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("Version must use X.Y.Z format")
        # The API can serve a cached empty list immediately after publication.
        # A fresh lookup must not mistake that response for an unpublished version.
        request = urllib.request.Request(
            f"{STATUS_URL}&_={time.time_ns()}",
            headers={"User-Agent": "AusBoss-registry-check", "Cache-Control": "no-cache"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024:
            raise ValueError("Registry response exceeds size limit")
        entries = json.loads(payload)
        if not isinstance(entries, list) or any(not isinstance(x, dict) for x in entries):
            raise ValueError("Unexpected Registry response")
        matches = [x for x in entries if x.get("version") == version]
        if len(matches) > 1:
            raise ValueError("Duplicate Registry versions")
        entry = matches[0] if matches else {}
        if entry and entry.get("node_id") != NODE_ID:
            raise ValueError("Registry returned a different node pack")
        status = entry.get("status", "NotPublished")
        if status not in STATUSES:
            raise ValueError("Unknown Registry status")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"Registry status could not be established: {exc}", file=sys.stderr)
        return 1

    print(f"{NODE_ID} {version}: {status}")
    print(STATUSES[status])
    reason = entry.get("status_reason") or ""
    if not isinstance(reason, str):
        reason = json.dumps(reason)
    for line in reason[:8000].splitlines():
        print(f"Reason: {line}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"## Registry {version}: {status}\n\n{STATUSES[status]}\n\n")
            handle.write("Only **NodeVersionStatusActive** means approved.\n\n")
            handle.write(f"[Registry response]({STATUS_URL})\n\n")
    if args.require_unpublished:
        return 0 if status == "NotPublished" else 2
    return 0 if status == "NodeVersionStatusActive" or (
        args.report and status in {"NodeVersionStatusPending", "NodeVersionStatusFlagged"}
    ) else 2


if __name__ == "__main__":
    sys.exit(main())
