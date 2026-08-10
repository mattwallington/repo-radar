#!/usr/bin/env python3
"""Stdlib-only release gate: verify the model lifecycle manifest against a target date."""
import argparse, json, sys, datetime
from pathlib import Path


def _parsed(sd):
    try:
        return datetime.date.fromisoformat(sd)
    except (TypeError, ValueError):
        return None


def check(manifest_path, known_ids, migration_keys, target_date):
    """Return a list of failure strings (never raises for malformed rows)."""
    failures = []
    try:
        rows = json.loads(Path(manifest_path).read_text())
    except Exception as e:
        return [f"manifest unreadable: {e}"]
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        return ["manifest must be a JSON array of objects"]
    bad = [i for i, r in enumerate(rows) if not (isinstance(r.get("id"), str) and r.get("id"))]
    if bad:
        return [f"rows with missing/non-string id at indices {bad}"]
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)):
        failures.append("duplicate ids in manifest")
    manifest_ids = set(ids)
    expected = set(known_ids) | set(migration_keys)
    if expected - manifest_ids:
        failures.append(f"manifest missing ids: {sorted(expected - manifest_ids)}")
    if manifest_ids - expected:
        failures.append(f"manifest has extra ids: {sorted(manifest_ids - expected)}")
    by_id = {r.get("id"): r for r in rows}
    for r in rows:
        rid = r.get("id", "<no-id>")
        url = r.get("source_url")
        if not (isinstance(url, str) and url.startswith("https://")):
            failures.append(f"{rid}: source_url must be non-empty https")
        if "shutdown_date" not in r:
            failures.append(f"{rid}: missing shutdown_date key")
    for kid in known_ids:
        r = by_id.get(kid)
        if not r:
            continue
        if r.get("status") != "active":
            failures.append(f"{kid}: KNOWN model must be status=active")
        sd = r.get("shutdown_date")
        if sd is not None:
            d = _parsed(sd)
            if d is None:
                failures.append(f"{kid}: malformed shutdown_date {sd!r}")
            elif d <= target_date:
                failures.append(f"{kid}: KNOWN model shutdown {sd} <= target {target_date}")
    for mk in migration_keys:
        r = by_id.get(mk)
        if not r:
            continue
        if r.get("status") != "retired":
            failures.append(f"{mk}: migration key must be status=retired")
        sd = r.get("shutdown_date")
        d = _parsed(sd) if sd is not None else None
        if sd is not None and d is None:
            failures.append(f"{mk}: malformed shutdown_date {sd!r}")
        elif d is None or d > target_date:
            failures.append(f"{mk}: migration key shutdown {sd} not on/before target {target_date}")
    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-date", required=True)
    a = ap.parse_args()
    try:
        target = datetime.date.fromisoformat(a.target_date)
    except ValueError:
        print(f"invalid --target-date (want YYYY-MM-DD): {a.target_date}", file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from repo_radar import llm
    from repo_radar import model_catalog
    failures = check(str(root / "repo_radar" / "model_lifecycle.json"),
                     set(model_catalog.MODEL_CAPS), set(llm.MODEL_MIGRATIONS), target)
    if failures:
        print("MODEL LIFECYCLE GATE FAILED:", file=sys.stderr)
        for f in failures:
            print("  -", f, file=sys.stderr)
        return 1
    print(f"model lifecycle gate OK ({len(model_catalog.MODEL_CAPS)} known, "
          f"{len(llm.MODEL_MIGRATIONS)} migrations) for {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
