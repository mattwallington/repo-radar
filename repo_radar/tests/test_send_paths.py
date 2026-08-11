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
