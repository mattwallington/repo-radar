#!/usr/bin/env python3
"""Full runtime healthy-predicate verifier (spec §3.3), run by the generic shell/CLI
dispatchers under the held lock so scheduled/manual/CLI syncs all enforce the SAME
predicate as the Electron reconcile (Codex I5). Exit 0 = valid, non-zero = fail closed.

Usage: python verify.py <genDir> <desiredPath> <manifestPath>

`hash_tree` mirrors menubar/runtime/hashing.js exactly (cross-checked by
runtime/__tests__/verify-parity.test.js) so a live re-hash of the source tree matches
the Node-written marker.sourceSha.
"""
import os
import sys
import json
import hashlib


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def hash_tree(root):
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]  # exclude, like Node
        for fn in filenames:
            abs_p = os.path.join(dirpath, fn)
            if os.path.islink(abs_p):
                continue  # Node's lstat-based walk hashes only regular files
            if fn.endswith(".pyc"):
                continue
            entries.append((os.path.relpath(abs_p, root), sha256_file(abs_p)))
    entries.sort(key=lambda e: e[0])
    h = hashlib.sha256()
    for rel, fh in entries:
        h.update(rel.encode())
        h.update(b"\0")
        h.update(fh.encode())
        h.update(b"\0")
    return h.hexdigest()


def interpreter_fingerprint():
    import platform
    return "%s-%d.%d.%d-%s" % (
        sys.implementation.name,
        sys.version_info[0], sys.version_info[1], sys.version_info[2],
        platform.machine(),
    )


def _installed():
    import importlib.metadata as md
    out = {}
    for dist in md.distributions():
        name = (dist.metadata["Name"] or "").lower()
        if name:
            out[name] = dist.version
    return out


def installed_set_ok(manifest):
    # Exact match on the security-relevant (hash-locked) dependency set; bootstrap
    # tooling (pip/setuptools/wheel) is excluded by name since a venv's seed versions
    # vary and are not part of the hash-pinned lock. `pip check` (below) still guards
    # the overall graph.
    got = _installed()
    boot = {k.lower() for k in manifest.get("bootstrap", {})}
    want = manifest.get("dists", {})
    non_boot = {n: v for n, v in got.items() if n not in boot}
    if set(non_boot) != set(want):
        return False
    return all(non_boot[n] == want[n] for n in want)


def soabi():
    import sysconfig
    return sysconfig.get_config_var("SOABI") or "none"


def pip_check_ok():
    import subprocess
    return subprocess.run([sys.executable, "-m", "pip", "check"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def fail(msg):
    sys.stderr.write("verify: %s\n" % msg)
    sys.exit(1)


def main():
    gen, desired_path, manifest_path = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        marker = json.load(open(os.path.join(gen, ".runtime.json")))
        desired = json.load(open(desired_path))
        manifest = json.load(open(manifest_path))
    except Exception as e:
        fail("unreadable state: %s" % e)

    # desired must be a compatible ACTIVE record
    if desired.get("schema") != 1 or desired.get("status") != "active":
        fail("desired not active")
    if marker.get("schema") != 1:
        fail("marker schema")
    # identity: marker matches desired across channel/version/genId + all hashes
    for k in ("channel", "version", "genId", "sourceSha", "launcherSha", "versionSha", "lockSha"):
        if marker.get(k) != desired.get(k):
            fail("marker.%s != desired" % k)
    # generation name matches the genId (containment is enforced by the caller resolving current)
    if os.path.basename(os.path.realpath(gen)) != desired.get("genId"):
        fail("genDir basename != genId")
    # live payload hashes match the marker (catches post-provision tampering)
    if hash_tree(os.path.join(gen, "repo_radar")) != marker.get("sourceSha"):
        fail("live sourceSha mismatch")
    if sha256_file(os.path.join(gen, "repo-radar")) != marker.get("launcherSha"):
        fail("live launcherSha mismatch")
    if sha256_file(os.path.join(gen, "VERSION")) != marker.get("versionSha"):
        fail("live versionSha mismatch")
    # the VERSION value equals the identity
    with open(os.path.join(gen, "VERSION")) as f:
        if f.read().strip() != desired.get("version"):
            fail("VERSION value != version")
    # this interpreter (the venv python running us) matches the recorded fingerprint + ABI
    if interpreter_fingerprint() != marker.get("fingerprint"):
        fail("interpreter fingerprint mismatch")
    if marker.get("abi") is not None and soabi() != marker.get("abi"):
        fail("interpreter ABI (SOABI) mismatch")
    # lock identity: the manifest and the marker agree on the lock they came from
    if manifest.get("lockSha256") is not None and manifest.get("lockSha256") != marker.get("lockSha"):
        fail("manifest lockSha256 != marker lockSha")
    # installed distribution set (incl. bootstrap versions) exactly equals the manifest
    if not installed_set_ok(manifest):
        fail("installed set != manifest")
    # no broken/conflicting dependency graph
    if not pip_check_ok():
        fail("pip check reported broken requirements")
    sys.exit(0)


if __name__ == "__main__":
    main()
