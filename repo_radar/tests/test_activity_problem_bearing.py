import json, pathlib
from repo_radar.activity import quota, records as R

AID = "00000000-0000-4000-8000-000000000000"

def _load_vectors():
    V = pathlib.Path(__file__).parent / "data" / "problem_bearing_vectors.json"
    return json.loads(V.read_text())

def test_problem_bearing_vectors_are_schema_valid_records():
    # Every record in every case's scan.records must actually be a valid v1 record for AID --
    # guards the fixture itself from rotting into records that no longer exercise real production
    # parsing. A Node test drives the SAME file for cross-language parity, so an invalid record
    # here would silently break that parity rather than fail loudly (see records.py's parse_valid).
    for case in _load_vectors():
        for rec in case["scan"]["records"]:
            assert R.parse_valid(json.dumps(rec), AID) is not None, (case["name"], rec)

def test_is_problem_bearing_matches_expected_for_every_vector():
    # Ruling 33/36 (Codex R1 finding B1, R2 finding R2-2): quota.is_problem_bearing is the single
    # shared predicate -- (a) any event with level in {warn, error}, (b) any terminal with a
    # failure-like outcome, (c) any integrity record, (d) any structural finding, (e) any rejected
    # segment entry, or (f) 2+ terminal records -- that both retention (_classify) and the Node
    # reader must agree on. v2: the predicate takes the whole scan (records/findings/rejected),
    # not just the valid records.
    for case in _load_vectors():
        assert quota.is_problem_bearing(case["scan"]) == case["problem_bearing"], case["name"]
