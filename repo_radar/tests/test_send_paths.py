import threading
import types
from pathlib import Path
from unittest.mock import patch

import pytest

from repo_radar.preflight import PreflightResult


class _StubSession:
    def __init__(self, table): self.table = table; self.calls = []
    def count(self, model, prompt, requested_output):
        self.calls.append((model, prompt, requested_output)); return self.table(prompt)


def test_branch1_chunk_never_reversed(monkeypatch):
    import repo_radar.llm as llm
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (True, 9, False))
    s = _StubSession(lambda p: PreflightResult(1, True))
    assert llm.authoritative_partition(s, "o/r", [{"path": "a", "size": 1, "content": "x"}], "claude-opus-5") == "chunk"
    assert s.calls == []


def test_branch1_single_stays_or_tightens(monkeypatch):
    import repo_radar.llm as llm
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (False, 1, True))
    files = [{"path": "a", "size": 1, "content": "x"}]
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(500, True)), "o/r", files, "claude-opus-5") == "single"
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(10**9, True)), "o/r", files, "claude-opus-5") == "chunk"
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(None, False)), "o/r", files, "claude-opus-5") == "single"


def _files(n): return [{"path": f"m{i}.py", "size": 3, "content": f"c{i}"} for i in range(n)]


def test_split_rebuilds_and_recounts_the_whole_set_with_real_headers(monkeypatch):
    """N-change fixpoint. Branch 1 hands back one 3-file chunk (N=1, header-less). The provider
    overflows ANY multi-file chunk, so the fixpoint must split down to three singletons — N goes
    1 -> 3, so every emitted prompt now carries a real (i/3) header that did not exist at the start.
    Falsifiable: a no-fixpoint impl leaves the rejected 3-file chunk and can't reach a clean pass; an
    impl that verifies with i=1 never counts the (i/3) prompts asserted below. `bytes) ===` counts
    the per-file frames in a prompt."""
    import repo_radar.llm as llm
    budget = llm.acceptance_budget("claude-opus-5", 8192)
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [_files(3)])
    s = _StubSession(lambda p: PreflightResult(budget + 1 if p.count("bytes) ===") > 1 else budget - 1, True))
    out = llm.authoritative_chunks(s, "o/r", _files(3), "claude-opus-5")
    assert out.degraded_reason is None and len(out.chunks) == 3                          # split to singletons
    assert [f["path"] for c in out.chunks for f in c] == [f"m{i}.py" for i in range(3)]  # order/identity
    counted = [p for (_m, p, _ro) in s.calls]
    assert any(p.count("bytes) ===") == 3 and "(chunk " not in p for p in counted)       # the initial N=1 3-file chunk was counted (overflowed)
    for i in (1, 2, 3):
        assert any(f"(chunk {i}/3)" in p for p in counted)                               # final set recounted under real (i/3)


def test_singleton_provider_overflow_local_fit_terminates(monkeypatch):
    import repo_radar.llm as llm
    big = {"path":"big.py","size":100,"content":"x"*5000}
    def table(prompt): return PreflightResult(10 if ("x"*200 not in prompt) else 10**9, True)
    s = _StubSession(table); monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [[big]])
    out = llm.authoritative_chunks(s, "o/r", [big], "claude-opus-5")
    assert out.degraded_reason is None and out.chunks and "truncated" in out.chunks[0][0]["content"]


def test_template_floor_degrades_whole_repo(monkeypatch):
    import repo_radar.llm as llm
    big = {"path":"big.py","size":100,"content":"x"*5000}
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [[big]])
    out = llm.authoritative_chunks(_StubSession(lambda p: PreflightResult(10**9, True)), "o/r", [big], "claude-opus-5")
    assert out.chunks == [] and out.degraded_reason                                        # whole-repo degrade, no sends


def test_non_authoritative_falls_back_to_branch1(monkeypatch):
    import repo_radar.llm as llm
    files = _files(4); branch1 = [_files(2), _files(2)]
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: branch1)
    out = llm.authoritative_chunks(_StubSession(lambda p: PreflightResult(None, False)), "o/r", files, "claude-opus-5")
    assert out.chunks == branch1 and out.degraded_reason is None


# --- Task 10: authoritative synthesis level (split-only, coverage-preserving, cost-preserving) ---

def test_over_budget_batch_splits_into_more_batches(monkeypatch):
    import repo_radar.llm as llm
    budget = llm.acceptance_budget("claude-opus-5", 16384)
    analyses = ["A0", "A1", "A2", "A3"]
    monkeypatch.setattr(llm, "_synthesis_budget", lambda *a, **k: budget)   # Branch 1: one batch of 4
    # provider: a batch of >2 analyses overflows; <=2 fits.
    def table(prompt): return PreflightResult(budget + 1 if prompt.count("Analysis Part") > 2 else budget - 1, True)
    out = llm.authoritative_synthesis_level(_StubSession(table), "o/r", analyses, "claude-opus-5")
    assert not isinstance(out, llm.DegradedSynthesis)
    assert len(out) >= 2 and [a for b in out for a in b] == analyses            # split, order preserved
    for b in out:
        assert _StubSession(table).count("claude-opus-5", llm._build_synthesis_prompt("o/r", b), 16384).tokens <= budget


def test_max_calls_trips_on_authoritative_count_and_terminal_prompt_is_counted(monkeypatch):
    """Two guarantees: (a) the guard `calls + len(batches) + 1 > max_calls` charges the AUTHORITATIVE
    post-split count (4) -> with max_calls=4 it trips to a single terminal shot (1 send, not 4); and
    (b) that terminal run(trimmed) prompt is itself authoritatively COUNTED before it is sent (via the
    run() choke point). A stale-count guard sends 4 batches; a run() that skips preflight on the
    terminal path sends an uncounted prompt."""
    import repo_radar.llm as llm, hashlib
    monkeypatch.setattr(llm, "authoritative_synthesis_level", lambda s, fn, a, m: [[x] for x in a])  # -> 4 batches
    counted, sends = [], []
    class _Rec:
        def count(self, model, prompt, ro):
            counted.append(hashlib.sha256(prompt.encode()).hexdigest()); return PreflightResult(1, True)
    def synth(prompt, model):
        sends.append(hashlib.sha256(prompt.encode()).hexdigest())
        return ("QUICK_REFERENCE_START\nType: Library\nQUICK_REFERENCE_END\n", 0.0, model)
    llm.combine_chunk_analyses("o/r", ["A0","A1","A2","A3"], model="claude-opus-5", synthesize=synth,
                               session=_Rec(), max_calls=4)
    assert len(sends) == 1                 # guard tripped on the authoritative count of 4 -> single terminal shot
    assert sends[0] in counted             # the terminal prompt was authoritatively counted before it was sent


def test_ordinary_synthesis_is_coverage_preserving_not_truncated(monkeypatch):
    """The provider permits <=2 analyses per prompt. combine must send TWO coverage-preserving level-1
    batches whose analyses together are A0,A1,A2,A3 (no omission, in order, NO truncation) — NOT one
    truncated [A0..A3]. Falsifiable: an impl that re-batches Branch-1's [A0..A3] and truncates in run()
    drops coverage / leaves the truncation marker. Each sent prompt was counted first."""
    import repo_radar.llm as llm, hashlib
    budget = llm.acceptance_budget("claude-opus-5", 16384)
    counted, sent = [], []
    class _Rec:
        def count(self, model, prompt, ro):
            counted.append(hashlib.sha256(prompt.encode()).hexdigest())
            return PreflightResult(budget + 1 if prompt.count("--- Analysis Part") > 2 else budget - 1, True)
    def synth(prompt, model):
        sent.append((hashlib.sha256(prompt.encode()).hexdigest(), prompt)); return ("R", 0.0, model)
    llm.combine_chunk_analyses("o/r", ["A0","A1","A2","A3"], model="claude-opus-5", synthesize=synth, session=_Rec())
    level1 = [p for _d, p in sent if any(a in p for a in ("A0","A1","A2","A3"))]   # the batches carrying originals
    assert len(level1) == 2                                       # two coverage-preserving batches, not one truncated
    joined = "".join(level1)
    assert all(a in joined for a in ("A0","A1","A2","A3"))        # no omission
    assert [joined.index(a) for a in ("A0","A1","A2","A3")] == sorted(joined.index(a) for a in ("A0","A1","A2","A3"))  # in order
    assert llm._TRUNCATION_MARKER not in joined                  # no truncation
    for d, _p in sent: assert d in counted                       # each sent prompt was counted first


def test_combine_returns_accumulated_cost_when_a_later_level_degrades(monkeypatch):
    """Cost is preserved on degradation. Level 1 sends two batches (0.5 each) whose results then
    overflow even at the template floor at level 2, so authoritative_synthesis_level returns
    DegradedSynthesis. combine must return (DegradedSynthesis, 1.0) — the cost already incurred at
    level 1 is NOT discarded."""
    import repo_radar.llm as llm
    budget = llm.acceptance_budget("claude-opus-5", 16384)
    sent = []
    class _Rec:
        def count(self, model, prompt, ro):
            if len(sent) >= 2:                       # level 2: every prompt overflows, incl. the floor
                return PreflightResult(budget + 1, True)
            over = prompt.count("--- Analysis Part") > 2
            return PreflightResult(budget + 1 if over else budget - 1, True)
    def synth(prompt, model):
        sent.append(1); return ("R", 0.5, model)
    out, cost = llm.combine_chunk_analyses("o/r", ["A0","A1","A2","A3"], model="claude-opus-5",
                                           synthesize=synth, session=_Rec(), max_calls=32)
    assert isinstance(out, llm.DegradedSynthesis)
    assert cost == 1.0


# --- Task 11: thread PreflightSession through sync.generate_repo_metadata; honor both degradations ---

async def _boom(**kw):
    raise AssertionError("real acount_tokens")


@pytest.fixture(autouse=True)
def _isolate_metadata_io(monkeypatch, tmp_path):
    """Keep generate_repo_metadata's real-world side effects out of the suite: point PRISTINE_DIR at
    the test's tmp dir (contains the metadata file, symlink and degraded-response dir), give the
    api-key gate a deterministic non-empty key, and neutralize the staggering sleeps. Harmless to the
    llm-only tests above (they never touch sync, PRISTINE_DIR, the key, or sleep)."""
    import repo_radar.modes.sync as sync
    monkeypatch.setattr(sync, "PRISTINE_DIR", tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    monkeypatch.setattr("time.sleep", lambda *a, **k: None)


def _fake_args():
    # dry_run False and no status_server -> exercises the real generate/degrade path with no UI I/O.
    return types.SimpleNamespace(dry_run=False, status_server=None)


def _fake_ctx():
    import repo_radar.modes.sync as sync
    class _NoOp:
        def update(self, *a, **k): pass
        def print(self, *a, **k): pass
    return sync.SyncContext(
        meta_progress=_NoOp(),
        meta_tasks={"o/r": (0, "cyan")},
        stats={"metadata_generated": 0, "api_cost": 0.0, "errors": 0},
        stats_lock=threading.Lock(),
        sync_logger=None,
        console=_NoOp(),
    )


def _fake_task_data(tmp_path, commit):
    # task_data = (repo_config, cache_name, commit_hash, short_id, color, _). An absolute cache_name
    # makes PRISTINE_DIR / f"{cache_name}.md" resolve to <tmp_path>/repo.md regardless of PRISTINE_DIR,
    # so the written metadata file is exactly where _read_frontmatter looks.
    tmp_path = Path(tmp_path)
    tmp_path.mkdir(parents=True, exist_ok=True)
    cache_name = str(tmp_path / "repo")
    repo_config = {"full_name": "o/r", "clone_url": "https://example.com/o/r.git"}
    return (repo_config, cache_name, commit, "shortid", "cyan", None)


def _read_frontmatter(tmp_path):
    text = (Path(tmp_path) / "repo.md").read_text()
    parts = text.split("---", 2)
    body = parts[1] if len(parts) >= 3 else ""
    fm = {}
    for line in body.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fm[key.strip()] = value.strip()
    return fm


def test_exact_payload_counted_before_send_all_three_shapes(monkeypatch, tmp_path):
    """Dead-code guard across ALL THREE shapes. Run 1 forces the CHUNK branch (real authoritative_chunks
    + real combine_chunk_analyses) and proves an 8192 chunk payload AND a 16384 synthesis payload were
    each authoritatively counted before their identical-digest send. Run 2 forces the SINGLE branch and
    proves the 16384 full-repo payload was counted first. Events record (kind, requested_output, digest)
    so all three shapes are proven present."""
    import hashlib, repo_radar.modes.sync as sync
    def dig(p): return hashlib.sha256(p.encode()).hexdigest()
    def harness():
        ev = []
        class _LogSession:
            def count(self, model, prompt, ro): ev.append(("count", ro, dig(prompt))); return PreflightResult(1, True)
        monkeypatch.setattr(sync, "collect_repo_files", lambda *a, **k: _files(2))
        monkeypatch.setattr(sync, "call_llm",
            lambda model, prompt, max_tokens=8192: ev.append(("send", max_tokens, dig(prompt))) or
            ("QUICK_REFERENCE_START\nType: Library\nQUICK_REFERENCE_END\n", 0.0, None))
        return ev, _LogSession()
    def assert_counted_before_send(ev):
        for k, ro, d in ev:
            if k == "send":
                assert ("count", ro, d) in ev and ev.index(("count", ro, d)) < ev.index(("send", ro, d))
    ev, sess = harness()                                       # Run 1: chunk branch
    monkeypatch.setattr(sync, "authoritative_partition", lambda *a, **k: "chunk")
    with patch("litellm.acount_tokens", _boom):
        sync.generate_repo_metadata(_fake_task_data(tmp_path, "abc1234"), sess, _fake_args(), _fake_ctx())
    assert {ro for k, ro, _ in ev if k == "send"} >= {8192, 16384}; assert_counted_before_send(ev)
    ev2, sess2 = harness()                                     # Run 2: single branch
    monkeypatch.setattr(sync, "authoritative_partition", lambda *a, **k: "single")
    with patch("litellm.acount_tokens", _boom):
        sync.generate_repo_metadata(_fake_task_data(tmp_path / "b", "def5678"), sess2, _fake_args(), _fake_ctx())
    assert {ro for k, ro, _ in ev2 if k == "send"} == {16384}; assert_counted_before_send(ev2)


def _run_repo(monkeypatch, tmp_path, files, chunks_result, synth_level, records):
    import repo_radar.modes.sync as sync, repo_radar.llm as llm
    monkeypatch.setattr(sync, "collect_repo_files", lambda *a, **k: files)
    monkeypatch.setattr(sync, "call_llm", lambda model, prompt, max_tokens=8192: records.append(max_tokens) or ("A", 0.0, None))
    monkeypatch.setattr(sync, "authoritative_partition", lambda *a, **k: "chunk")
    monkeypatch.setattr(sync, "authoritative_chunks", lambda *a, **k: chunks_result)
    monkeypatch.setattr(llm, "authoritative_synthesis_level", synth_level)   # combine_chunk_analyses resolves it in llm
    with patch("litellm.acount_tokens", _boom):
        sync.generate_repo_metadata(_fake_task_data(tmp_path, "abc1234"), _StubSession(lambda p: PreflightResult(1, True)),
                                    _fake_args(), _fake_ctx())
    return _read_frontmatter(tmp_path)


def test_analysis_degradation_never_calls_llm_and_persists_degraded_record(monkeypatch, tmp_path):
    import repo_radar.llm as llm
    records = []
    fm = _run_repo(monkeypatch, tmp_path, _files(2), llm.PartitionResult([], "template floor"),
                   synth_level=lambda *a, **k: [], records=records)
    assert records == []                                       # zero LLM calls
    assert fm["parse_status"] == "degraded" and fm["last_commit"] == "abc1234" and fm.get("degraded_reason")


def test_synthesis_degradation_keeps_chunk_sends_then_persists_degraded(monkeypatch, tmp_path):
    import repo_radar.llm as llm
    records = []
    fm = _run_repo(monkeypatch, tmp_path, _files(2), llm.PartitionResult([_files(1), _files(1)], None),
                   synth_level=lambda *a, **k: llm.DegradedSynthesis("floor"), records=records)
    assert 8192 in records and 16384 not in records            # chunk sends happened; no synthesis send
    assert fm["parse_status"] == "degraded" and fm["last_commit"] == "abc1234"
