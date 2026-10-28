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
    with pytest.raises(llm.InputBudgetUnavailable, match="token count unavailable for claude-opus-5"):
        llm.authoritative_partition(_StubSession(lambda p: PreflightResult(None, False)), "o/r", files, "claude-opus-5")
    # A local-only provider has no authoritative count; its estimate-based decision stands.
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(None, False)), "o/r", files,
                                       "gemini/gemini-3.8-flash") == "single"


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


def test_non_authoritative_falls_back_to_branch1_only_for_local_providers(monkeypatch):
    import repo_radar.llm as llm
    files = _files(4); branch1 = [_files(2), _files(2)]
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: branch1)
    unavailable = _StubSession(lambda p: PreflightResult(None, False))
    out = llm.authoritative_chunks(unavailable, "o/r", files, "gemini/gemini-3.8-flash")
    assert out.chunks == branch1 and out.degraded_reason is None
    with pytest.raises(llm.InputBudgetUnavailable):
        llm.authoritative_chunks(unavailable, "o/r", files, "claude-opus-5")


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


def test_authoritative_never_coalesces_branch1_batches(monkeypatch):
    """Monotonicity: authoritative counting may SPLIT/tighten Branch 1's partition but must NEVER
    merge across a Branch-1 boundary. Branch 1 batches against the conservative _synthesis_budget;
    acceptance_budget is much larger, so a plan that searches the whole list against the larger
    ceiling would coalesce batches Branch 1 deliberately separated (and drift the safety boundary
    toward the ~99% ceiling). Here a REAL Branch-1 partition splits into >=2 batches, yet the provider
    reports the whole union fits the authoritative ceiling — the exact condition under which the
    pre-fix code merged to one batch. The authoritative result must keep Branch 1's boundaries."""
    import repo_radar.llm as llm
    model = "claude-opus-5"
    analyses = ["A0 " * 400, "A1 " * 400, "A2 " * 400, "A3 " * 400]              # sizable, distinct
    # Establish a REAL Branch-1 partition of >=2 batches under a genuinely small conservative budget
    # (derived from the same framed-token sizes _batch_by_budget uses, so the split is deterministic).
    overhead = llm._budget_tokens(llm._build_synthesis_prompt("o/r", []), model)
    small_budget = overhead + llm._budget_tokens(llm._framed(analyses[0], 1), model) \
                            + llm._budget_tokens(llm._framed(analyses[1], 2), model)
    monkeypatch.setattr(llm, "_synthesis_budget", lambda *a, **k: small_budget)
    branch1 = llm._batch_by_budget("o/r", analyses, small_budget, model)
    assert len(branch1) >= 2                                                     # real conservative split
    acc = llm.acceptance_budget(model, 16384)
    assert acc > small_budget                                                    # the safety-boundary gap exists
    # Provider says even the WHOLE union fits the larger acceptance ceiling -> pre-fix would merge to one.
    out = llm.authoritative_synthesis_level(_StubSession(lambda p: PreflightResult(acc - 1, True)),
                                            "o/r", analyses, model)
    assert not isinstance(out, llm.DegradedSynthesis)
    assert [a for b in out for a in b] == analyses                              # order preserved, none dropped
    assert len(out) >= len(branch1)                                            # boundaries not merged (>=2)

    def cutpoints(batches):
        pts, i = set(), 0
        for b in batches:
            i += len(b); pts.add(i)
        return pts
    assert cutpoints(branch1) <= cutpoints(out)                                # no auth batch spans a Branch-1 boundary


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
    import hashlib, repo_radar.modes.sync as sync, repo_radar.llm as llm
    # A model with no output floor, so the 8192 chunk and 16384 synthesis shapes stay distinct.
    monkeypatch.setenv("AI_MODEL", "claude-sonnet-5")
    def dig(p): return hashlib.sha256(p.encode()).hexdigest()
    def harness():
        ev = []
        class _LogSession:
            def count(self, model, prompt, ro): ev.append(("count", ro, dig(prompt))); return PreflightResult(1, True)
        monkeypatch.setattr(sync, "collect_repo_files", lambda *a, **k: _files(2))
        # Record what call_llm really requests: it applies output_budget to every send.
        monkeypatch.setattr(sync, "call_llm",
            lambda model, prompt, max_tokens=8192: ev.append(("send", llm.output_budget(model, max_tokens), dig(prompt))) or
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


@pytest.mark.parametrize("model,effective_output", [("claude-opus-5", 8192), ("claude-sonnet-5-5", 16384)])
def test_oversized_file_with_count_outage_skips_metadata_and_keeps_previous(monkeypatch, tmp_path,
                                                                            model, effective_output):
    """Anthropic counts the oversized file over budget, then the count becomes unavailable. The local
    partition (the same oversized chunk) must never be sent: the repo's metadata is skipped with a
    warning, the previous metadata and commit stay, and nothing is counted as an error."""
    import repo_radar.modes.sync as sync, repo_radar.llm as llm
    monkeypatch.setenv("AI_MODEL", model)
    assert llm.output_budget(model, llm.CHUNK_OUTPUT) == effective_output
    budget = llm.acceptance_budget(model, effective_output)
    previous = "---\nfull_name: o/r\nlast_commit: oldc0mmit\nparse_status: ok\n---\n\n# previous metadata\n"
    (tmp_path / "repo.md").write_text(previous)
    monkeypatch.setattr(sync, "collect_repo_files",
                        lambda *a, **k: [{"path": "huge.py", "size": 90_000, "content": "x = 1\n" * 15_000}])
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (True, budget * 2, False))
    monkeypatch.setattr(sync, "repo_needs_chunking", lambda *a, **k: (True, budget * 2, False))
    sends = []
    monkeypatch.setattr(sync, "call_llm", lambda *a, **k: sends.append(a) or ("A", 0.0, None))
    answers = iter([PreflightResult(budget + 200_000, True)])   # then: count unavailable
    session = _StubSession(lambda p: next(answers, PreflightResult(None, False)))
    events, statuses = [], []

    class _Logger:
        def event(self, name, level, **f): events.append((name, level, f))
        def error(self, name, **f): events.append((name, "error", f))

    class _Progress:
        def update(self, *a, **k): statuses.append(k.get("status", ""))

    ctx = _fake_ctx()._replace(sync_logger=_Logger(), meta_progress=_Progress())
    with patch("litellm.acount_tokens", _boom):
        cost = sync.generate_repo_metadata(_fake_task_data(tmp_path, "newc0mmit"), session, _fake_args(), ctx)

    assert sends == [] and cost == 0.0
    assert session.calls and all(ro == effective_output for _m, _p, ro in session.calls)
    assert (tmp_path / "repo.md").read_text() == previous         # previous metadata and commit kept
    assert ctx.stats["errors"] == 0 and ctx.stats["skipped"] == 1 and ctx.stats["metadata_generated"] == 0
    [(name, level, fields)] = events
    assert (name, level) == ("metadata_skipped", "warn")
    assert "token count unavailable" in fields["reason"] and "'huge.py'" in fields["reason"]
    assert any("skipped: token count unavailable" in s for s in statuses)


@pytest.mark.parametrize("stage", ["single", "chunk", "synthesis"])
def test_rejected_reply_is_not_retried_as_a_rate_limit(monkeypatch, tmp_path, stage):
    """call_llm rejects an incomplete reply, and its message ("429 characters of text") contains 429.
    The real retry loops must not read that as a rate limit: one attempt, no retry sleep or fallback,
    one incomplete-response error, and the previous metadata and commit stay. For synthesis, the
    chunk sends succeed first and the rejection passes both nested synthesis catches."""
    import repo_radar.modes.sync as sync, repo_radar.llm as llm
    monkeypatch.setenv("AI_MODEL", "claude-sonnet-5-5")
    previous = "---\nfull_name: o/r\nlast_commit: oldc0mmit\nparse_status: ok\n---\n\n# previous metadata\n"
    (tmp_path / "repo.md").write_text(previous)
    monkeypatch.setattr(sync, "collect_repo_files", lambda *a, **k: _files(2))
    monkeypatch.setattr(sync, "authoritative_partition", lambda *a, **k: "single" if stage == "single" else "chunk")
    ev = []

    def send(model, prompt, max_tokens=8192):
        failing = stage != "synthesis" or max_tokens == 16384
        ev.append(("send", "fail" if failing else "ok"))
        if failing:
            raise llm.IncompleteResponseError(f"{model} returned an incomplete response "
                                              "(finish_reason='length', 429 characters of text); not using it")
        return "A", 0.0, None

    monkeypatch.setattr(sync, "call_llm", send)
    monkeypatch.setattr("time.sleep", lambda *a, **k: ev.append(("sleep",)))
    monkeypatch.setattr(sync, "get_fallback_model", lambda m: ev.append(("fallback",)) or "gemini/gemini-3.8-flash")
    errors, statuses = [], []

    class _Logger:
        def event(self, name, level, **f): pass
        def error(self, name, **f): errors.append((name, f["error_type"]))

    class _Progress:
        def update(self, *a, **k): statuses.append(k.get("status", ""))

    ctx = _fake_ctx()._replace(sync_logger=_Logger(), meta_progress=_Progress())
    with patch("litellm.acount_tokens", _boom):
        cost = sync.generate_repo_metadata(_fake_task_data(tmp_path, "newc0mmit"),
                                           _StubSession(lambda p: PreflightResult(1, True)), _fake_args(), ctx)

    failed_at = ev.index(("send", "fail"))
    assert ev[failed_at:] == [("send", "fail")], ev               # one attempt; no retry sleep or fallback
    assert (("send", "ok") in ev) == (stage == "synthesis")      # only synthesis follows successful chunks
    assert errors == [("metadata_failed", "IncompleteResponseError")] and cost == 0.0
    assert ctx.stats["errors"] == 1 and ctx.stats["metadata_generated"] == 0
    assert any("Incomplete response" in s for s in statuses) and not any("Rate limit" in s for s in statuses)
    assert (tmp_path / "repo.md").read_text() == previous         # previous metadata and commit kept


@pytest.mark.parametrize("case", ["401", "400-credit", "503", "timeout"])
def test_count_errors_fail_or_skip_through_the_real_preflight(monkeypatch, tmp_path, case):
    """The real PreflightSession counts each repo through Anthropic's Count Tokens handler, with only
    the HTTP transport stubbed. A rejected count (401, a 400 credit error) fails each repo as an error
    with nothing generated. A transient one (503, timeout) skips both repos with the cause in the
    reason, and the second repo reuses it without another count request. Previous metadata stays."""
    import asyncio, socket, httpx
    import repo_radar.modes.sync as sync
    from repo_radar.preflight import PreflightSession
    from litellm.llms.custom_httpx.aiohttp_transport import LiteLLMAiohttpTransport
    monkeypatch.setattr(socket.socket, "connect", lambda *a, **k: (_ for _ in ()).throw(OSError("blocked")))
    monkeypatch.setenv("AI_MODEL", "claude-sonnet-5-5")
    monkeypatch.setattr(sync, "collect_repo_files", lambda *a, **k: _files(2))
    generated, requests = [], []
    monkeypatch.setattr(sync, "call_llm", lambda *a, **k: generated.append(a) or ("A", 0.0, None))
    body = {"type": "error", "error": {"type": "x", "message": "raw-provider-body"}}
    replies = {"401": httpx.Response(401, json=body), "503": httpx.Response(503, json=body),
               "400-credit": httpx.Response(400, json={"type": "error", "error": {
                   "type": "invalid_request_error", "message": "Your credit balance is too low (raw-provider-body)"}})}

    async def transport(self, request):
        requests.append(request.url.path)
        if case == "timeout":
            await asyncio.sleep(5)
        return replies[case]

    monkeypatch.setattr(LiteLLMAiohttpTransport, "handle_async_request", transport)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", transport)
    events = []

    class _Logger:
        def event(self, name, level, **f): events.append((name, f["reason"]))
        def error(self, name, **f): events.append((name, f["error_type"], f["detail"]))

    ctx = _fake_ctx()._replace(sync_logger=_Logger())
    previous = "---\nfull_name: o/r\nlast_commit: oldc0mmit\nparse_status: ok\n---\n\n# previous metadata\n"
    with patch("litellm.acount_tokens", _boom), PreflightSession(timeout_s=0.2) as session:
        for repo in ("a", "b"):
            (tmp_path / repo).mkdir()
            (tmp_path / repo / "repo.md").write_text(previous)
            sync.generate_repo_metadata(_fake_task_data(tmp_path / repo, "newc0mmit"), session, _fake_args(), ctx)

    assert generated == [] and ctx.stats["metadata_generated"] == 0
    assert all((tmp_path / r / "repo.md").read_text() == previous for r in ("a", "b"))
    if case in ("401", "400-credit"):
        status = case[:3]
        assert requests == ["/v1/messages/count_tokens"] * 2               # an error, not the breaker
        assert ctx.stats["errors"] == 2 and not ctx.stats.get("skipped")
        assert sync._finalize_outcome(errors=ctx.stats["errors"], warns=0, degraded=False) == "failed"
        for name, error_type, detail in events:
            assert (name, error_type) == ("metadata_failed", "TokenCountRejected")
            assert f"token count rejected (HTTP {status}) for claude-sonnet-5-5" in detail
            assert "raw-provider-body" not in detail and "test-key-not-real" not in detail
        assert len(events) == 2
    else:
        reason = "TimeoutError" if case == "timeout" else "AnthropicError (HTTP 503)"
        assert requests == ["/v1/messages/count_tokens"]                    # the second repo hits the breaker
        assert ctx.stats["errors"] == 0 and ctx.stats["skipped"] == 2
        assert [n for n, *_ in events] == ["metadata_skipped"] * 2
        assert all(f"token count unavailable for claude-sonnet-5-5 ({reason})" in r for _n, r in events)
