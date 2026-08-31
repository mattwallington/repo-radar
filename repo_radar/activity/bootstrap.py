import argparse, os, sys
from repo_radar.activity import ids, HANDOFF_REJECTED_EXIT
from repo_radar.activity.writer import ActivityWriter

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True); ap.add_argument("--channel", required=True)
    ap.add_argument("--trigger", required=True)
    a = ap.parse_args(argv)
    home = os.environ.get("HOME")
    aid = os.environ.get("REPO_RADAR_ACTIVITY_ID")
    token = os.environ.get("REPO_RADAR_ACTIVITY_OWNER_TOKEN")
    fd = os.environ.get("REPO_RADAR_ACTIVITY_LOCK_FD")
    # Three-way classification (Codex B4), mirroring cli.py's _establish_activity: bootstrap is
    # adopt-only (it never mints), so ALL THREE handoff env vars ABSENT means no handoff was ever
    # signaled -- a benign no-op (the shell dispatcher didn't wire one for this invocation),
    # unchanged. But if ANY of the three is set, this IS a handoff attempt, and it must be the
    # COMPLETE, valid tuple or be treated as CORRUPT -- exit HANDOFF_REJECTED_EXIT (66), writing
    # NOTHING -- rather than silently `return 0` as if nothing had been attempted at all, which
    # would let a caller believe recording is merely "off" while the upstream handoff item stays
    # unresolved and this process proceeds (or is silently skipped) under no clear identity.
    handoff_present = bool(aid) or bool(token) or bool(fd)
    handoff_complete = bool(aid) and bool(token) and bool(fd) and fd.isdigit() and ids.valid_activity_id(aid)
    if not handoff_present:
        return 0                                   # no handoff signaled at all -- best-effort no-op
    if not handoff_complete:
        print("repo-radar: activity: bootstrap handoff rejected (partial/malformed env)", file=sys.stderr)
        return HANDOFF_REJECTED_EXIT                # 66 -> a watching Electron finalizes `failed`
    # ActivityWriter never raises; a failed adopt/admit leaves it INACTIVE and writes NOTHING
    # (no false ack — finding 4). Signal that with a non-zero exit; the dispatcher does not abort.
    w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                       producer="dispatcher", inherited_id=aid,
                       inherited_fd=int(fd), owner_token=token)
    if w._handoff_rejected:                        # corrupt lease handoff (§5)
        print("repo-radar: activity: bootstrap handoff rejected", file=sys.stderr)
        return HANDOFF_REJECTED_EXIT               # 66 -> a watching Electron finalizes `failed`
    if not w._active:                              # admission refused (benign) -> NOT a rejection
        print("repo-radar: activity: bootstrap recording disabled", file=sys.stderr)
        return 0
    w.start()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
