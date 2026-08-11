#!/usr/bin/env python3
"""Stdlib-only release gate: verify repo_radar/model_catalog.py's per-model capability windows
against invariants and against what litellm reports (a release-time drift cross-check only --
vendor docs in model_catalog.py remain canonical; see that module's docstring). Findings are
collected, never raised early -- one bad model must not hide problems in the rest of the catalog.
"""
import argparse, datetime, sys
from collections import namedtuple
from pathlib import Path

Finding = namedtuple("Finding", "model field message blocking")

# Allowlist, not derived from MODEL_CAPS: the known-good set of count_strategy values that
# repo_radar/llm.py and repo_radar/preflight.py branch on. This matches the same literal set
# already asserted in repo_radar/tests/test_model_catalog.py::test_record_invariants.
KNOWN_COUNT_STRATEGIES = {"anthropic_api", "local"}


def _is_positive_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _parsed_date(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


def check(caps_map, litellm_info, overrides, target_date, send_outputs=(8192, 16384)):
    """Validate every row of caps_map (model -> ModelCaps) against the window/catalog invariants
    and a directional compare against litellm_info(model). Returns a list of Finding; NEVER
    raises for a bad row or an unresolved model -- it collects and keeps going.

    `overrides` is accepted but not yet consumed (that lands in a later task); it exists here
    purely so callers can start passing the parameter shape before the override logic exists.
    """
    findings = []
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
                findings.append(Finding(model, "max_input",
                                         f"catalog max_input {max_input} > litellm max_input_tokens "
                                         f"{litellm_max_input}", True))
            elif max_input < litellm_max_input:
                findings.append(Finding(model, "max_input",
                                         f"catalog max_input {max_input} < litellm max_input_tokens "
                                         f"{litellm_max_input}", False))

        if field_ok["max_output"]:
            if max_output > litellm_max_output:
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

    # Task 12 does not consume overrides yet -- always pass []; a later task adds the overrides
    # file and threads it through here.
    findings = check(model_catalog.MODEL_CAPS, _litellm_info, [], target)
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
