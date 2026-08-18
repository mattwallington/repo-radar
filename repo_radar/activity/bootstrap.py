import argparse, os, sys
from repo_radar.activity import ids
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
    if not (ids.valid_activity_id(aid) and token and fd and fd.isdigit()):
        print("repo-radar: activity: bootstrap missing/invalid handoff env", file=sys.stderr)
        return 0                                   # best-effort: never block the sync
    # ActivityWriter never raises; a failed adopt/admit leaves it INACTIVE and writes NOTHING
    # (no false ack — finding 4). Signal that with a non-zero exit; the dispatcher does not abort.
    from repo_radar.activity import HANDOFF_REJECTED_EXIT
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
