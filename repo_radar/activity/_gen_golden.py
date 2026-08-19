"""Generate the committed golden-equivalence fixtures for the Node/Python activity-record
encoders (Task 2.1) from the CURRENT `records.py` implementation -- the authoritative encoder.
Run via:

    python -m repo_radar.activity._gen_golden

Regenerate ONLY when `records.py`'s encoding behavior intentionally changes. The whole point of
the golden pair is that an ACCIDENTAL drift on either side of the two encoders fails the
committed byte-equality tests (menubar/activity/__tests__/records-golden.test.js,
repo_radar/tests/test_activity_golden.py) instead of silently diverging.
"""
import json
import pathlib

from repo_radar.activity import records as R

_TESTS_DIR = pathlib.Path(__file__).resolve().parents[2] / "menubar" / "activity" / "__tests__"

# Fixed metadata for the Step 5b truncation-parity case -- an event carrying a genuinely
# oversized (>1 KiB), entirely-multibyte value. `records-golden.test.js` and
# `test_activity_golden.py` both hardcode these SAME constants (documented there) to
# reconstruct an equivalent record independently and compare its encoding to the committed
# `expected_line`.
TRUNCATION_ACTIVITY_ID = "00000000-0000-4000-8000-000000000000"
TRUNCATION_TS = "2026-08-14T00:00:00-07:00"
TRUNCATION_SEQ = 100
TRUNCATION_EVENT = "oversized_value"
TRUNCATION_FIELD_KEY = "blob"
TRUNCATION_VALUE = "\U0001F511" * 400  # "🔑" * 400 -- 1600 bytes of UTF-8, all 4-byte chars


def _gen_expected():
    cases = json.loads((_TESTS_DIR / "golden-cases.json").read_text())
    lines = []
    for c in cases:
        rec = R.build(c["type"], **c["args"])
        lines.append(R.encode(rec).decode("utf-8"))
    (_TESTS_DIR / "golden-expected.jsonl").write_text("".join(lines))


def _gen_truncation():
    rec = R.build(
        "event",
        seq=TRUNCATION_SEQ,
        activity_id=TRUNCATION_ACTIVITY_ID,
        ts=TRUNCATION_TS,
        level="info",
        event=TRUNCATION_EVENT,
        fields={TRUNCATION_FIELD_KEY: TRUNCATION_VALUE},
    )
    assert rec["_truncated"] is True, "fixture must actually exercise truncation"
    expected_line = R.encode(rec).decode("utf-8")
    (_TESTS_DIR / "golden-truncation.json").write_text(
        json.dumps({"input": TRUNCATION_VALUE, "expected_line": expected_line},
                   ensure_ascii=False, indent=2) + "\n"
    )


def main():
    _gen_expected()
    _gen_truncation()


if __name__ == "__main__":
    main()
