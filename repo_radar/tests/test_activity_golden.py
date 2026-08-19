"""Cross-language golden-equivalence harness (Task 2.1). Both this file and
menubar/activity/__tests__/records-golden.test.js read the SAME two committed fixtures
(golden-cases.json / golden-expected.jsonl, generated once from this file's own `records.py`
encoder via `python -m repo_radar.activity._gen_golden`) and assert byte-equality, so neither
encoder can drift silently.
"""
import json
import pathlib

from repo_radar.activity import records as R
from repo_radar.activity._gen_golden import (
    TRUNCATION_ACTIVITY_ID,
    TRUNCATION_EVENT,
    TRUNCATION_FIELD_KEY,
    TRUNCATION_SEQ,
    TRUNCATION_TS,
)

D = pathlib.Path("menubar/activity/__tests__")


def test_python_encodes_every_record_type_byte_for_byte():
    cases = json.loads((D / "golden-cases.json").read_text())
    expected = (D / "golden-expected.jsonl").read_text().split("\n")
    for i, c in enumerate(cases):
        assert R.encode(R.build(c["type"], **c["args"])).decode("utf-8") == expected[i] + "\n"


def test_python_truncation_matches_the_committed_node_golden_line_byte_for_byte():
    """Step 5b: truncation parity. `golden-truncation.json` = {input, expected_line}. The fixed
    metadata (activity_id/ts/seq/event/field key) is imported from the SAME `_gen_golden`
    constants used to produce the committed line, so this test can never silently drift from the
    fixture it's asserting against."""
    trunc = json.loads((D / "golden-truncation.json").read_text())

    rec = R.build(
        "event",
        seq=TRUNCATION_SEQ,
        activity_id=TRUNCATION_ACTIVITY_ID,
        ts=TRUNCATION_TS,
        level="info",
        event=TRUNCATION_EVENT,
        fields={TRUNCATION_FIELD_KEY: trunc["input"]},
    )

    line = R.encode(rec).decode("utf-8")
    assert line == trunc["expected_line"]
    assert rec["_truncated"] is True
    stored = rec["fields"][TRUNCATION_FIELD_KEY]
    assert len(stored.encode("utf-8")) <= R.MAX_VALUE_BYTES
    assert "[truncated" in stored
    # Byte-exact equality above already implies the cut landed on a valid UTF-8 boundary -- a
    # mid-sequence split would have produced different (or non-decodable) bytes.
