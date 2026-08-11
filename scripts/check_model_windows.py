#!/usr/bin/env python3
"""Stdlib-only release gate: verify repo_radar/model_catalog.py's per-model capability windows
against invariants and against what litellm reports (a release-time drift cross-check only --
vendor docs in model_catalog.py remain canonical; see that module's docstring). Findings are
collected, never raised early -- one bad model must not hide problems in the rest of the catalog.
"""
import argparse, datetime, json, sys
from collections import namedtuple
from pathlib import Path

Finding = namedtuple("Finding", "model field message blocking")

# Allowlist, not derived from MODEL_CAPS: the known-good set of count_strategy values that
# repo_radar/llm.py and repo_radar/preflight.py branch on. This matches the same literal set
# already asserted in repo_radar/tests/test_model_catalog.py::test_record_invariants.
KNOWN_COUNT_STRATEGIES = {"anthropic_api", "local"}

# An override may clear ONLY a litellm directional-compare BLOCK for one of these fields.
# It can never clear any other invariant (positive-int, total_context, count_strategy,
# source_url, source_date, send_output, unresolved litellm).
OVERRIDABLE_FIELDS = {"max_input", "max_output"}

# Freshness window (days) shared by catalog source_date staleness and override verified_at.
FRESHNESS_DAYS = 90

# Required keys of an override row (see module docstring / §8). Any missing key, wrong type,
# or unparseable verified_at makes the row malformed -> a BLOCK that clears nothing.
_OVERRIDE_STR_KEYS = ("model", "field", "vendor_url", "justification")
_OVERRIDE_INT_KEYS = ("catalog_value", "litellm_value")


def _is_positive_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _parsed_date(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


def _override_structural_errors(ov):
    """Return a human-readable error string if `ov` is not a structurally well-formed override
    row, else None. Fail-closed: a missing key, wrong type, or unparseable verified_at is an
    error (the row clears nothing and surfaces its own BLOCK)."""
    if not isinstance(ov, dict):
        return f"not a dict: {ov!r}"
    errs = []
    for key in _OVERRIDE_STR_KEYS:
        if key not in ov:
            errs.append(f"missing '{key}'")
        elif not isinstance(ov[key], str):
            errs.append(f"'{key}' must be a str, got {ov[key]!r}")
    for key in _OVERRIDE_INT_KEYS:
        if key not in ov:
            errs.append(f"missing '{key}'")
        elif not _is_positive_int(ov[key]):
            errs.append(f"'{key}' must be a positive int, got {ov[key]!r}")
    if "verified_at" not in ov:
        errs.append("missing 'verified_at'")
    elif _parsed_date(ov["verified_at"]) is None:
        errs.append(f"'verified_at' must be a valid ISO date, got {ov.get('verified_at')!r}")
    return "; ".join(errs) if errs else None


def _validate_overrides(overrides):
    """Split `overrides` into (override_map, findings).

    override_map: {(model, field): override_dict} for rows that are structurally well-formed
    AND have a unique (model, field). Only these rows are ever consulted to clear a block.
    findings: BLOCK Findings for malformed rows and for duplicate (model, field) pairs -- both
    fail-closed. A malformed or duplicate row is EXCLUDED from override_map, so it clears nothing.
    """
    findings = []
    well_formed = []
    for idx, ov in enumerate(overrides):
        err = _override_structural_errors(ov)
        if err is not None:
            model = ov.get("model") if isinstance(ov, dict) else None
            field = ov.get("field") if isinstance(ov, dict) else None
            findings.append(Finding(model, field, f"malformed override row (index {idx}): {err}", True))
            continue
        well_formed.append(ov)

    by_key = {}
    dup_keys = set()
    for ov in well_formed:
        key = (ov["model"], ov["field"])
        if key in by_key:
            dup_keys.add(key)
        by_key[key] = ov

    override_map = {}
    for key, ov in by_key.items():
        if key in dup_keys:
            findings.append(Finding(key[0], key[1],
                                     f"duplicate override for {key} -- ambiguous, failing closed", True))
            continue
        override_map[key] = ov
    return override_map, findings


def _override_clears(ov, model, field, catalog_value, litellm_value, caps, target_date):
    """True iff a structurally-valid, unique override `ov` clears the live directional-compare
    BLOCK for (model, field). Requires an exact match on model/field/catalog_value/litellm_value,
    vendor_url == caps.source_url, a non-empty justification, and verified_at within
    FRESHNESS_DAYS of target_date (a future verified_at -> negative delta -> does NOT clear)."""
    if field not in OVERRIDABLE_FIELDS:
        return False
    if ov["model"] != model or ov["field"] != field:
        return False
    if ov["catalog_value"] != catalog_value or ov["litellm_value"] != litellm_value:
        return False
    if ov["vendor_url"] != caps.source_url:
        return False
    if not (isinstance(ov["justification"], str) and ov["justification"].strip()):
        return False
    vdate = _parsed_date(ov["verified_at"])
    if vdate is None:
        return False
    delta = (target_date - vdate).days
    return 0 <= delta <= FRESHNESS_DAYS


def check(caps_map, litellm_info, overrides, target_date, send_outputs=(8192, 16384)):
    """Validate every row of caps_map (model -> ModelCaps) against the window/catalog invariants
    and a directional compare against litellm_info(model). Returns a list of Finding; NEVER
    raises for a bad row or an unresolved model -- it collects and keeps going.

    `overrides` is a list of override rows (see module docstring / _override_structural_errors).
    A well-formed, unique override clears ONLY the litellm directional-compare BLOCK for its
    (model, field) -- and only when it matches the live catalog/litellm values, its vendor_url
    equals caps.source_url, its justification is non-empty, and its verified_at is within
    FRESHNESS_DAYS of target_date. Malformed rows and duplicate (model, field) pairs are
    themselves BLOCKs and clear nothing. Overrides can NEVER clear any other invariant
    (positive-int, total_context, count_strategy, source_url, stale/future source_date,
    send_output, or an unresolved litellm model).
    """
    findings = []
    override_map, override_findings = _validate_overrides(overrides)
    findings.extend(override_findings)

    for model, caps in caps_map.items():
        total_context, max_input, max_output = caps.total_context, caps.max_input, caps.max_output

        field_ok = {}
        for field_name, value in (("total_context", total_context), ("max_input", max_input),
                                   ("max_output", max_output)):
            ok = _is_positive_int(value)
            field_ok[field_name] = ok
            if not ok:
                findings.append(Finding(model, field_name,
                                         f"{field_name} must be a positive int (excluding bool), got {value!r}",
                                         True))

        if field_ok["max_input"] and field_ok["total_context"] and max_input > total_context:
            findings.append(Finding(model, "max_input",
                                     f"max_input {max_input} > total_context {total_context}", True))

        if not isinstance(caps.count_strategy, str):
            findings.append(Finding(model, "count_strategy",
                                     f"count_strategy must be a string, got {caps.count_strategy!r}", True))
        elif caps.count_strategy not in KNOWN_COUNT_STRATEGIES:
            findings.append(Finding(model, "count_strategy",
                                     f"count_strategy {caps.count_strategy!r} not in known set "
                                     f"{sorted(KNOWN_COUNT_STRATEGIES)}", True))

        url = caps.source_url
        if not (isinstance(url, str) and url.startswith("https://") and len(url) > len("https://")):
            findings.append(Finding(model, "source_url", f"source_url must be non-empty https, got {url!r}", True))

        parsed = _parsed_date(caps.source_date)
        if parsed is None:
            findings.append(Finding(model, "source_date",
                                     f"source_date must be a valid ISO date, got {caps.source_date!r}", True))
        elif parsed > target_date:
            findings.append(Finding(model, "source_date",
                                     f"source_date {caps.source_date} is in the future (target {target_date})",
                                     True))
        elif (target_date - parsed).days > FRESHNESS_DAYS:
            # NEW in Task 13: a catalog record more than FRESHNESS_DAYS old is stale -- re-verify
            # the row against vendor docs and refresh its own source_date. NOT override-clearable.
            findings.append(Finding(model, "source_date",
                                     f"source_date {caps.source_date} is stale "
                                     f"(> {FRESHNESS_DAYS} days before target {target_date})", True))

        if field_ok["max_output"]:
            for nominal in send_outputs:
                if nominal > max_output:
                    findings.append(Finding(model, "send_output",
                                             f"nominal send output {nominal} > max_output {max_output} "
                                             f"(no clamping -- catalog or nominal must change)", True))

        try:
            info = litellm_info(model)
        except Exception as exc:
            findings.append(Finding(model, "litellm", f"litellm_info({model!r}) raised: {exc}", True))
            continue

        litellm_max_input = info.get("max_input_tokens") if isinstance(info, dict) else None
        litellm_max_output = info.get("max_output_tokens") if isinstance(info, dict) else None
        if litellm_max_input is None or litellm_max_output is None:
            findings.append(Finding(model, "litellm",
                                     f"litellm_info({model!r}) missing max_input_tokens/max_output_tokens: "
                                     f"{info!r}", True))
            continue

        if field_ok["max_input"]:
            if max_input > litellm_max_input:
                ov = override_map.get((model, "max_input"))
                if ov is None or not _override_clears(ov, model, "max_input", max_input,
                                                      litellm_max_input, caps, target_date):
                    findings.append(Finding(model, "max_input",
                                             f"catalog max_input {max_input} > litellm max_input_tokens "
                                             f"{litellm_max_input}", True))
            elif max_input < litellm_max_input:
                findings.append(Finding(model, "max_input",
                                         f"catalog max_input {max_input} < litellm max_input_tokens "
                                         f"{litellm_max_input}", False))

        if field_ok["max_output"]:
            if max_output > litellm_max_output:
                ov = override_map.get((model, "max_output"))
                if ov is None or not _override_clears(ov, model, "max_output", max_output,
                                                      litellm_max_output, caps, target_date):
                    findings.append(Finding(model, "max_output",
                                             f"catalog max_output {max_output} > litellm max_output_tokens "
                                             f"{litellm_max_output}", True))
            elif max_output < litellm_max_output:
                findings.append(Finding(model, "max_output",
                                         f"catalog max_output {max_output} < litellm max_output_tokens "
                                         f"{litellm_max_output}", False))

    return findings


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
    from repo_radar import model_catalog
    import litellm

    def _litellm_info(model):
        info = litellm.get_model_info(model)  # raises for a model litellm doesn't resolve
        return {"max_input_tokens": info.get("max_input_tokens"), "max_output_tokens": info.get("max_output_tokens")}

    # Read the vendor-verified overrides. A missing/unreadable/non-array file is a hard error
    # (fail closed) -- NEVER silently fall back to [], which would re-open blocks the file clears.
    overrides_path = root / "repo_radar" / "model_window_overrides.json"
    try:
        overrides = json.loads(overrides_path.read_text())
    except (OSError, ValueError) as exc:
        print(f"cannot read overrides file {overrides_path}: {exc}", file=sys.stderr)
        return 2
    if not isinstance(overrides, list):
        print(f"overrides file {overrides_path} must be a JSON array, got {type(overrides).__name__}",
              file=sys.stderr)
        return 2

    findings = check(model_catalog.MODEL_CAPS, _litellm_info, overrides, target)
    blocking = [f for f in findings if f.blocking]
    warnings = [f for f in findings if not f.blocking]

    for f in warnings:
        print(f"  [WARN] {f.model} {f.field}: {f.message}")
    for f in blocking:
        print(f"  [BLOCK] {f.model} {f.field}: {f.message}", file=sys.stderr)

    if blocking:
        print(f"MODEL WINDOWS GATE FAILED: {len(blocking)} blocking finding(s), {len(warnings)} warning(s)",
              file=sys.stderr)
        return 1
    print(f"model windows gate OK ({len(model_catalog.MODEL_CAPS)} models checked, {len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
