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
| 3.10 (cp310) | ✅ covered | ❌ **UNCOVERED** |
| 3.11 (cp311) | ❌ **UNCOVERED** | ❌ **UNCOVERED** |
| 3.12 (cp312) | ✅ covered | ❌ **UNCOVERED** |
| 3.13 (cp313) | ✅ covered | ❌ **UNCOVERED** |
| 3.14 (cp314) | ❌ **UNCOVERED** | ❌ **UNCOVERED** |

**Covered (generated on this arm64 build host, 2026-07):**
- `cp310-arm64.lock` / `cp310-arm64.manifest.json` — from `/opt/homebrew/opt/python@3.10/bin/python3.10` (3.10.20)
- `cp312-arm64.lock` / `cp312-arm64.manifest.json` — from `~/.pyenv/versions/3.12.8/bin/python3` (3.12.8)
- `cp313-arm64.lock` / `cp313-arm64.manifest.json` — from `~/.pyenv/versions/3.13.4/bin/python3` (3.13.4)

Each was produced by `pip-compile --generate-hashes --allow-unsafe` against the root
`requirements.txt`, then round-tripped through a real clean install
(`pip install --require-hashes -r <lock>`) in a fresh venv before the manifest was derived from
that venv's actual `pip list --format=json` output (`menubar/scripts/pydeps.js --emit-manifest`).
Nothing here is synthesized — every hash and every manifest version came from a real resolve +
install.

**Uncovered — 7 of 10 cells:**
- `cp311-arm64`, `cp314-arm64` — no 3.11 or 3.14 interpreter was available on the build host at
  generation time.
- `cp310-x86_64`, `cp311-x86_64`, `cp312-x86_64`, `cp313-x86_64`, `cp314-x86_64` — **all**
  x86_64 cells. This host is arm64-only; no x86_64 interpreter (Rosetta or native) was used, so no
  x86_64 lock exists.

## This is a release blocker, not a rounding error

Per spec §3.6, an uncovered `(pyMinor, arch)` cell is **not** a soft gap — the runtime provisioner
(Task 7) **fails closed** when `deps.js#selectFor` is asked for a fingerprint whose lock/manifest
don't exist on disk: there is no fallback, no "best effort" install, no silent skip. A user (or
CI packaged-smoke run, Task 17) landing on an uncovered cell gets a hard provisioning failure, by
design — installing unpinned/unverified dependencies would defeat the entire point of this
mechanism.

**Before this ships**, one of the following must happen:

1. **Generate the remaining cells** on native or equivalent hosts (an x86_64 Mac or an
   x86_64 CI runner for the x86_64 column; a host with 3.11/3.14 installed for the missing arm64
   rows) using the same procedure as above, and check the results in here, **or**
2. **Narrow the supported interpreter matrix** to exactly the cells that are actually covered
   (i.e. change `resolveBaseInterpreter` to only accept 3.10/3.12/3.13 on arm64, and drop x86_64
   support or gate it behind an explicit "unsupported platform" message), and state the narrowed
   range explicitly in `SETUP.md` / release notes so users on an unsupported combination get a
   clear, early message instead of discovering it at provision time.

Do not silently ship with these cells unaddressed — this file is the record that the gap is known
and intentional to flag, not an oversight.

## Regenerating / checking freshness

```bash
# Regenerate a lock for a given (minor, arch) — see menubar/scripts/pydeps.js and the Task 6
# brief for the exact throwaway-venv + pip-compile + real-install + --emit-manifest sequence.

# Check all covered locks for drift against requirements.txt (exits nonzero on drift):
node menubar/scripts/pydeps.js --check
```

`--check` only verifies locks whose arch matches the current host and for which a matching
`python3.<minor>` interpreter is discoverable; other cells are reported as skipped, not failed,
since they can't be verified without the right interpreter present.
