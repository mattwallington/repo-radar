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
