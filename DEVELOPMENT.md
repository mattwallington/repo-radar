# Development

## Setup

```bash
# Clone
git clone https://github.com/mattwallington/repo-radar.git
cd repo-radar

# Install Python deps
pip3 install -r requirements.txt

# Run the CLI directly
./repo-radar help

# Run tests
python -m pytest repo_radar/tests/ -v

# Run the menubar app in dev mode
cd menubar
npm install
npm run dev
```

## Architecture

```
repo-radar/
├── repo-radar                 # Python CLI entry point
├── repo_radar/                # Python package
│   ├── cli.py                 # Argument parsing, mode dispatch
│   ├── config.py              # Paths, load/save config
│   ├── git.py                 # Git operations
│   ├── files.py               # File collection and filtering
│   ├── llm.py                 # Model config, chunking, rate limiting
│   ├── metadata.py            # Response parsing, index generation
│   ├── ui.py                  # Help text, formatting, status updates
│   ├── modes/                 # CLI modes (configure, sync, analyze, clean)
│   └── tests/                 # Unit tests
├── VERSION                    # Release version floor: the workflow publishes the next patch above it or higher
├── requirements.txt           # Python dependencies (litellm pinned)
├── build-local.sh             # Build, sign, notarize and verify (used by the release workflow)
├── release.sh                 # Old release script; publishing is paused
└── menubar/                   # Electron menubar app
    ├── main.js                # Main process (tray, scheduling, IPC)
    ├── entitlements.plist     # macOS hardened runtime entitlements
    ├── renderer/              # UI (progress, settings, errors)
    ├── resources/             # Bundled script + setup
    └── package.json           # Electron build config
```

**How it works:**
1. The Electron menubar app spawns `python3 repo-radar sync --status-server`
2. The Python script handles git operations, GitHub API discovery, and LLM metadata generation
3. Progress updates flow back to the menubar via HTTP POST to a local Express server (port 3847, or 3848 for dev builds)
4. Generated metadata and an `INDEX.md` are written to `~/repos-pristine/`

## Releasing

Releases publish from GitHub Actions (`.github/workflows/desktop-release.yml`) to the public, code-free [ReperioHealth/repo-radar-releases](https://github.com/ReperioHealth/repo-radar-releases), which is also the apps' update feed.

- **What publishes:** a push to `main` publishes **Repo Radar** as the Latest release. A push to `dev` publishes **Repo Radar Dev** as a prerelease. Merging to `main` is the release decision; there is no second approval. Setting `PUBLISH_DEV: 'false'` in the workflow stops Dev publishing without affecting stable.
- **Versions** come from the workflow, and nothing commits a version bump; `package.json`'s version is not used. Stable takes the next patch above the highest of every stable version in `repo-radar-releases` (published or draft), the bootstrap floor 1.0.34 and the base of the checkout's `VERSION`. So the first is 1.0.35, and with `VERSION` at 1.1.0 the next stable is at least 1.1.1. Dev uses that base, or a higher Dev base already in use, with a UTC timestamp suffix, such as `1.0.35-dev.20261030010000`. A minor or major bump is a deliberate change to `menubar/scripts/release-control.js`.
- **Release notes** are written when the draft is reserved: a link comparing the source with the previous published release of the same channel (or to the source commit, for the first one), and a link to `CHANGELOG.md` as of that commit. Keep `[Unreleased]` in the changelog current in the PR that makes the change.
- **How a run works:** it reserves a draft release keyed to its commit, builds both architectures with `build-local.sh` on a pinned macOS runner, signs and notarizes the DMGs, uploads everything with a `release-receipt.json`, checks every uploaded hash, and only then publishes. Rerunning a commit that already published does nothing. If the branch has moved on, or a newer release of the same channel exists, the run stops without publishing. Published releases are never changed: fix a bad release with a new version.
- **Setup:** until the repository has a `desktop-release` environment, runs report "not configured" and publish nothing. An admin creates that environment, limited to the `main` and `dev` branches, and provides these secrets, as organization or environment secrets: `MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `ASC_API_KEY_P8`, `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, and `RELEASES_REPO_TOKEN`, a fine-grained token with Contents read and write on only `repo-radar-releases`. Once the environment exists, a missing secret fails the run.

### When a release run fails

- **A newer push wins.** If the branch moves while a build runs, that run stops before publishing; the newer push's run publishes instead. The older run's draft stays reserved in `repo-radar-releases`, and later versions number above it.
- **Rerun the failed jobs** after fixing the cause. A rerun reuses its draft, and a commit that already published does nothing.
- **First live run.** It is the first real test of asset uploads and downloads, of Python 3.14.10 and Xcode 16.4 on the runner, and of the signing and notary credentials. Any failure stops before publishing.
- **Expired token.** `RELEASES_REPO_TOKEN` is a fine-grained token with an expiry date. Once it expires, runs fail with HTTP 401 and publish nothing; renew it and rerun.
- `queue: max` in the workflow's concurrency and the `actions: read` permission are supported by GitHub; older actionlint versions flag `queue` anyway.

### By hand

`build-local.sh` builds and verifies a signed app on your Mac without publishing it (see README, "Building a signed app locally"). If you run electron-builder yourself, run it from `menubar/`, as `build-local.sh` does: it loads the `./scripts/release-after-pack.js` hook relative to the current directory, and the build stops if the hook can't be found. To sign and notarize its DMGs, run `node menubar/scripts/release-dmg.js --dir menubar/dist --version <version> --source <commit>`. It writes `release-finalization.json` only after every step succeeds, and publishing requires that file to match the exact files. Running it again on a finalized folder only verifies it and changes nothing. If a folder's output is invalid, it refuses as it is; start again from a fresh copy of the original build output. The preserved 1.0.34 build, the first organization release, is published once by hand: put its two ZIPs, two DMGs, `latest-mac.yml` and ZIP blockmaps in one folder, run `node menubar/scripts/release-dmg.js --dir <dir> --version 1.0.34 --source 4283e7411263aca1fb32342bff48df1dc1c22392`, then `node menubar/scripts/release-control.js bootstrap --dir <dir> --version 1.0.34 --source 4283e7411263aca1fb32342bff48df1dc1c22392` with `gh` signed in as someone who can write to `repo-radar-releases`. Both refuse anything but that build's original files (pinned in `menubar/scripts/release-artifacts.js`), and they read the apps inside the ZIPs to confirm their source, version, channel and architecture. Publishing with `release.sh` stays paused.

## Dev Branch

The `dev` branch builds a separate **Repo Radar Dev** app that can run alongside production:

- Separate app ID (`com.mattwallington.repo-radar-dev`), orange icon and update download cache
- Releases are prereleases in `repo-radar-releases`, each with a `dev-mac.yml` feed
- Dev apps update only to newer Dev releases; stable apps never see them
- Uses port 3848 for status updates (production uses 3847)

```bash
git checkout dev
# make changes, commit, push: a Repo Radar Dev prerelease publishes
# when ready for production, merge dev into main through a PR: Repo Radar publishes
```
