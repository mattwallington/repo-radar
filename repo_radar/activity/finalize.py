import argparse, os, sys
from repo_radar.activity import ids
from repo_radar.activity.writer import ActivityWriter

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", default="sync"); ap.add_argument("--channel", required=True)
    ap.add_argument("--trigger", required=True); ap.add_argument("--outcome", required=True)
    ap.add_argument("--reason", default=None)
    a = ap.parse_args(argv)
    home = os.environ.get("HOME")
    aid = os.environ.get("REPO_RADAR_ACTIVITY_ID")
    token = os.environ.get("REPO_RADAR_ACTIVITY_OWNER_TOKEN")
    fd = os.environ.get("REPO_RADAR_ACTIVITY_LOCK_FD")
    try:
        if ids.valid_activity_id(aid) and token and fd:      # adopt shell-held lease
            w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                               producer="dispatcher", inherited_id=aid,
                               inherited_fd=int(fd), owner_token=token)
        else:                                                # self-contained incident
            w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                               producer="dispatcher")
            w.start()
        summary = {"reason": a.reason} if a.reason else {}
        w.terminal(a.outcome, **summary)
    except Exception as e:
        print(f"repo-radar: activity: finalize failed: {e}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
