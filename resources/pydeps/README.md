# resources/pydeps — checked-in Python dependency locks

Each `<tag>.lock` / `<tag>.manifest.json` pair is generated for one `(pyMinor, arch)` cell of the
supported interpreter matrix, where `<tag>` is `cp3<minor>-<arch>` (e.g. `cp310-arm64`). The
runtime provisioner (`menubar/runtime/deps.js`, wired up in Task 7) selects the pair matching the
active interpreter's fingerprint, installs the lock with `pip install --require-hashes`, and then
verifies the resulting venv's installed set exactly matches the manifest via
`verifyInstalledSet`.

The supported interpreter range (per `menubar/runtime/interpreter.js`'s
`resolveBaseInterpreter`) is **CPython 3.10 through 3.14**, on **arm64** and **x86_64**. That's a
5 × 2 = 10-cell matrix.

## Coverage matrix

| pyMinor \ arch | arm64 | x86_64 |
|---|---|---|
| 3.10 (cp310) | ✅ covered | ✅ covered |
| 3.11 (cp311) | ✅ covered | ✅ covered |
| 3.12 (cp312) | ✅ covered | ✅ covered |
| 3.13 (cp313) | ✅ covered | ✅ covered |
| 3.14 (cp314) | ✅ covered | ✅ covered |

**All 10 cells covered.** The full matrix was generated in two passes:

**Pass 1 (2026-07, arm64 build host):**
- `cp310-arm64` — from `/opt/homebrew/opt/python@3.10/bin/python3.10` (3.10.20)
- `cp312-arm64` — from `~/.pyenv/versions/3.12.8/bin/python3` (3.12.8)
- `cp313-arm64` — from `~/.pyenv/versions/3.13.4/bin/python3` (3.13.4)

**Pass 2 (2026-07, same arm64 build host, matrix completion):**
- `cp311-arm64` — from `/opt/homebrew/opt/python@3.11/bin/python3.11` (3.11.15), installed via
  `brew install python@3.11`.
- `cp314-arm64` — from `/opt/homebrew/opt/python@3.14/bin/python3.14` (3.14.4), already present
  via `brew install python@3.14`.
- `cp310-x86_64` through `cp314-x86_64` (3.10.20, 3.11.15, 3.12.13, 3.13.12, 3.14.3) — this host
  has no sudo access to stand up a second, x86_64-native Homebrew prefix at `/usr/local`, so these
  interpreters were obtained as real, single-architecture `macos-x86_64` CPython builds from
  [`astral-sh/python-build-standalone`](https://github.com/astral-sh/python-build-standalone) via
  `uv python install cpython-3.1N.M-macos-x86_64-none`, then executed with `arch -x86_64` so
  Rosetta 2 translates the actual x86_64 machine code (not an arm64 binary relabeled — every one
  was probed with `platform.machine()` and confirmed to report `x86_64` before use, per
  `menubar/runtime/interpreter.js`'s `probe()`). This is the same category of prebuilt interpreter
  GitHub Actions' `setup-python` and tools like `uv`/`rye` use; it is a real CPython build, not a
  synthesized one. The PATH-installed `~/.local/bin/python3.1N` shims uv creates by default were
  deleted immediately after use so they don't shadow the host's native arm64 Homebrew/pyenv
  interpreters on `PATH` going forward — only the underlying
  `~/.local/share/uv/python/cpython-3.1N-macos-x86_64-none/` install trees remain, referenced by
  full path.

Each cell was produced by the same recipe: `pip-compile --generate-hashes --allow-unsafe` against
the root `requirements.txt` (relative path, run from repo root, so `# via -r requirements.txt`
provenance comments match across all ten locks), then round-tripped through a **real clean
install** (`pip install --require-hashes -r <lock>` into a fresh venv, `pip check` confirmed
clean), before the manifest was derived from that venv's actual `pip list --format=json` output
(`menubar/scripts/pydeps.js --emit-manifest`). Nothing here is synthesized, and no arm64 lock was
reused or relabeled for an x86_64 cell — every hash and every manifest version came from a real
resolve + install on an interpreter that was probed and confirmed to match its cell's
`(pyMinor, arch)` tag.

**One real build wrinkle worth recording:** `litellm==1.93.0` ships a Rust extension
(`litellm.rust_bridge`, built via `maturin`/`pyo3`) with no prebuilt `macosx_x86_64` wheel on
PyPI for this host's toolchain, so the x86_64 install step builds it from source. The first
attempt (`cp310-x86_64`) failed with `error[E0463]: can't find crate for 'core'` /
`'std'` because only the `aarch64-apple-darwin` Rust target was installed
(`rustup target list --installed`). Running `rustup target add x86_64-apple-darwin` once (real
fix, not a workaround) resolved it, and the same toolchain state carried through the remaining
four x86_64 cells (`cp311`–`cp314`) without incident. The first (failed) `cp310-x86_64` manifest
was discarded and regenerated from a clean install after the fix — nothing partial or broken was
left checked in.

## Regenerating / checking freshness

```bash
# Regenerate a lock for a given (minor, arch) — see menubar/scripts/pydeps.js and the Task 6
# brief for the exact throwaway-venv + pip-compile + real-install + --emit-manifest sequence.

# Check all covered locks for drift against requirements.txt (exits nonzero on drift):
node menubar/scripts/pydeps.js --check
```

`--check` only verifies locks whose arch matches the current host and for which a matching
`python3.<minor>` interpreter is discoverable; other cells are reported as skipped, not failed,
since they can't be verified without the right interpreter present. On this arm64 host, the last
run of `--check` reported all 5 arm64 locks (`cp310`–`cp314`) `OK` (0 drifted) and skipped the 5
x86_64 locks (cross-arch, cannot verify locally) — exit code 0.
