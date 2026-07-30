"""Publish the pristine corpus as an Agent Context Snapshot.

Cloud agents reviewing a PR have none of the cross-repo knowledge a desktop agent gets from
~/repos-pristine. This emits the schema-v1 tree their consumer validates:

    <out>/manifest.json
    <out>/pristine/INDEX.md
    <out>/pristine/<repo>.md          one per repo, canonical names, never symlinks

The consumer's contract is fixed and it validates the tree as an EXACT SET, so nothing may be
written into <out> that the manifest does not declare, and nothing declared may be missing:

  - repo keys must match owner/name
  - metadataPath must be a direct child of pristine/, and never pristine/INDEX.md
  - index.path must be exactly pristine/INDEX.md
  - sourceCommit 40 lowercase hex; metadataSha256 64 lowercase hex
  - metadataSnapshotId = sha256 of the canonical manifest with that key OMITTED
  - no symlinks anywhere
  - limits: 2 MiB per metadata file, 64 MiB total, 1024 filesystem entries

For the schema-v1 profile (ASCII keys, strings, one integer) json.dumps(sort_keys, no whitespace)
is JCS-equivalent, which is what makes metadataSnapshotId reproducible across implementations.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from repo_radar import VERSION as REPO_RADAR_VERSION
from repo_radar.config import PRISTINE_DIR, load_config, load_exclusions, is_excluded
from repo_radar.constants import GREEN, CYAN, YELLOW, RED, BOLD, RESET

SHA40 = re.compile(r'^[0-9a-f]{40}$')
REPO_KEY = re.compile(r'^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$')
# repo-radar names metadata "<repo>-<short-sha>.md" beside a "<repo>.md" symlink; the snapshot
# publishes the canonical name and never the symlink, which the contract rejects outright.
CACHE_SUFFIX = re.compile(r'-[0-9a-f]{7,}$')

MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_ENTRIES = 1024


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _git(repo, *args):
    """Read-only git query in `repo`, or None. Never raises."""
    try:
        result = subprocess.run(['git', '-C', str(repo), *args],
                                capture_output=True, text=True, timeout=30)
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        return None


def owner_name(url):
    """git@github.com:Owner/Name.git or https://github.com/Owner/Name.git -> Owner/Name."""
    if not url:
        return None
    match = re.search(r'[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$', url.strip())
    return f'{match.group(1)}/{match.group(2)}' if match else None


def frontmatter(md_path):
    """The flat scalar frontmatter keys we need. Never raises."""
    try:
        text = Path(md_path).read_text(encoding='utf-8', errors='replace')
    except Exception:
        return {}
    if not text.startswith('---\n'):
        return {}
    end = text.find('\n---', 4)
    out = {}
    for line in text[4:end if end > 0 else 0].splitlines():
        if ':' in line and not line.startswith((' ', '\t', '-')):
            key, _, value = line.partition(':')
            out[key.strip()] = value.strip()
    return out


def rewrite_index(text, rename):
    """Point INDEX links at the canonical names actually present in the snapshot.

    repo-radar links to cache-named files ("reperio-mcp-1a2b3c4.md") and cache directories, but
    the snapshot publishes "reperio-mcp.md". Left alone, every INDEX link dangles inside the
    snapshot and the agent's first step — read INDEX, pick a repo — dead-ends immediately.
    """
    count = 0
    for cache_name, canon in rename.items():
        for before, after in ((f'({cache_name}.md)', f'({canon}.md)'),
                              (f'`{cache_name}/`', f'`{canon}/`')):
            if before in text:
                count += text.count(before)
                text = text.replace(before, after)
    return text, count


def discover(src, exclusions):
    """Find publishable repositories. Returns (repos, skipped, rename, excluded)."""
    repos, skipped, rename, excluded = {}, [], {}, []
    for md in sorted(Path(src).iterdir()):
        if md.name == 'INDEX.md' or md.suffix != '.md' or md.is_symlink() or not md.is_file():
            continue
        stem = md.stem                              # reperio-mcp-1a2b3c4
        canon = CACHE_SUFFIX.sub('', stem)          # reperio-mcp
        clone = Path(src) / stem

        meta = frontmatter(md)
        key = meta.get('full_name') or owner_name(_git(clone, 'remote', 'get-url', 'origin'))
        # git HEAD is authoritative for the commit the metadata describes; frontmatter is the
        # fallback for a repo whose clone has been removed.
        commit = _git(clone, 'rev-parse', 'HEAD') or meta.get('last_commit')

        if key and is_excluded(key, exclusions):
            excluded.append(key)
            continue
        if not key or not REPO_KEY.match(key):
            skipped.append((stem, f'no owner/name key (got {key!r})'))
            continue
        if not commit or not SHA40.match(commit.lower()):
            skipped.append((stem, f'no 40-hex sourceCommit (got {commit!r})'))
            continue
        if key in repos:
            skipped.append((stem, f'duplicate key {key}'))
            continue

        repos[key] = {'src': md, 'canon': canon, 'commit': commit.lower()}
        rename[stem] = canon
    return repos, skipped, rename, excluded


def build_manifest(repos, out, generated_at, generator_version):
    """Write the tree and return (manifest_with_id, snapshot_id)."""
    manifest_repos = {}
    for key, repo in sorted(repos.items()):
        dest = Path(out) / 'pristine' / f"{repo['canon']}.md"
        shutil.copyfile(repo['src'], dest)
        manifest_repos[key] = {
            'metadataPath': f"pristine/{repo['canon']}.md",
            'metadataSha256': sha256_file(dest),
            'sourceCommit': repo['commit'],
        }

    manifest = {
        'schemaVersion': 1,
        'generatedAt': generated_at,
        'generatorVersion': generator_version,
        'index': {'path': 'pristine/INDEX.md',
                  'sha256': sha256_file(Path(out) / 'pristine/INDEX.md')},
        'repos': manifest_repos,
    }
    # The id is the hash of the manifest WITHOUT the id — including it would be self-referential.
    snapshot_id = 'sha256:' + hashlib.sha256(canonical(manifest).encode('utf-8')).hexdigest()
    return {**manifest, 'metadataSnapshotId': snapshot_id}, snapshot_id


def expected_repo_keys(config, exclusions):
    """The repositories the corpus is SUPPOSED to contain: configured, minus excluded."""
    keys = set()
    for repo in (config or {}).get('repositories', []):
        full_name = (repo.get('full_name') or '').strip()
        if full_name and not is_excluded(full_name, exclusions):
            keys.add(full_name)
    return keys


def publish_mode(args):
    """Build a snapshot at --out. Returns 0 only if it is complete and within limits."""
    print(f'{BOLD}Publish Context Snapshot{RESET}')
    print()

    src = Path(getattr(args, 'src', None) or PRISTINE_DIR).expanduser().resolve()
    if not getattr(args, 'out', None):
        print(f'{RED}--out is required{RESET}')
        return 1
    out = Path(args.out).expanduser().resolve()

    if not src.is_dir():
        print(f'{RED}error: {src} is not a directory{RESET}')
        return 1
    index_src = src / 'INDEX.md'
    if not index_src.is_file():
        print(f'{RED}error: {index_src} missing — the contract requires pristine/INDEX.md{RESET}')
        return 1

    config = load_config() or {}
    exclusions = load_exclusions(config)
    repos, skipped, rename, excluded = discover(src, exclusions)
    if not repos:
        print(f'{RED}error: no publishable repositories found{RESET}')
        return 1

    if args.dry_run:
        print(f'{CYAN}[DRY RUN]{RESET} would publish {len(repos)} repositories to {out}')
        for key in sorted(repos):
            print(f'    {key}')
        return 0

    # Refusing to remove anything we did not create. The contract validates <out> as an exact
    # set, so a stale file from a previous run fails the review — but blindly rmtree-ing a path
    # the user typed is not an acceptable way to guarantee that.
    if out.exists():
        if not (out / 'manifest.json').is_file():
            print(f'{RED}error: {out} exists and is not a previous snapshot{RESET}')
            print(f'{YELLOW}  Refusing to delete it. Choose an empty path or remove it '
                  f'yourself.{RESET}')
            return 1
        shutil.rmtree(out)
    (out / 'pristine').mkdir(parents=True)

    index_text, links = rewrite_index(index_src.read_text(encoding='utf-8'), rename)
    (out / 'pristine/INDEX.md').write_text(index_text, encoding='utf-8', newline='\n')

    generated_at = (getattr(args, 'generated_at', None)
                    or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
    generator_version = (getattr(args, 'generator_version', None)
                         or f'repo-radar/{REPO_RADAR_VERSION}')
    manifest, snapshot_id = build_manifest(repos, out, generated_at, generator_version)
    (out / 'manifest.json').write_text(canonical(manifest), encoding='utf-8', newline='\n')

    # Local limit checks, so a bad snapshot fails here rather than mid-review.
    files = [p for p in out.rglob('*') if p.is_file()]
    entries = len(files) + len([p for p in out.rglob('*') if p.is_dir()])
    total = sum(p.stat().st_size for p in files)
    problems = [f'{p.relative_to(out)} is {p.stat().st_size}B > {MAX_FILE}'
                for p in files if p.stat().st_size > MAX_FILE]
    if total > MAX_TOTAL:
        problems.append(f'total {total}B > {MAX_TOTAL}')
    if entries > MAX_ENTRIES:
        problems.append(f'{entries} entries > {MAX_ENTRIES}')

    published = set(manifest['repos'])
    indexed = set(re.findall(r'^###\s+(\S+/\S+)', index_text, re.M))
    expected = expected_repo_keys(config, exclusions)

    print(f'snapshot     : {out}')
    print(f'metadataSnapshotId = {snapshot_id}')
    print(f'repos        : {len(published)} published, {len(skipped)} skipped, '
          f'{len(excluded)} excluded')
    print(f'size         : {total / 1024:.0f} KB across {entries} entries')
    print(f'INDEX links  : {links} rewritten to canonical names')
    print(f'INDEX covers : {len(indexed)} repos')

    # Set equality, not a count. Three views of the corpus must name the SAME repositories:
    # what the config says should exist, what the index advertises, and what the manifest ships.
    # A count check passes when one repo is silently swapped for another; agents then either
    # cannot find a repo the index promised, or read metadata nothing points at.
    failures = []
    for label, actual in (('INDEX', indexed), ('manifest', published)):
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing:
            failures.append(f'{len(missing)} configured repositor'
                            f'{"ies" if len(missing) != 1 else "y"} missing from {label}: '
                            f'{", ".join(missing)}')
        if extra:
            failures.append(f'{len(extra)} repositor{"ies" if len(extra) != 1 else "y"} in '
                            f'{label} but not configured: {", ".join(extra)}')

    for stem, why in skipped:
        failures.append(f'skipped {stem}: {why}')
    for problem in problems:
        failures.append(f'LIMIT VIOLATION: {problem}')

    if failures:
        print()
        print(f'{RED}✗ Snapshot is INCOMPLETE — {len(failures)} problem'
              f'{"s" if len(failures) != 1 else ""}:{RESET}')
        for failure in failures:
            print(f'  {RED}- {failure}{RESET}')
        return 1

    print()
    print(f'{GREEN}✓ Snapshot complete{RESET} — configured, INDEX and manifest all agree on '
          f'{len(expected)} repositories')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog='repo-radar publish',
                                     description='Publish the pristine corpus as a snapshot')
    parser.add_argument('--out', required=True, help='output directory')
    parser.add_argument('--src', default=None, help='corpus directory (default: pristine dir)')
    parser.add_argument('--generator-version', default=None)
    parser.add_argument('--generated-at', default=None, help='RFC3339 Z (default: now)')
    parser.add_argument('--dry-run', '-n', action='store_true')
    return publish_mode(parser.parse_args(argv))


if __name__ == '__main__':
    sys.exit(main())
