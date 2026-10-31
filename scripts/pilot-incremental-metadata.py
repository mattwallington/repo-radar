#!/usr/bin/env python3
"""Telehealth-only pilot: compare an incremental metadata update with a clean full rebuild.

Both candidates go to a scratch pilot directory, never to the installed metadata document, and every
paid request is charged to one durable ledger capped at $40 ($8 for the incremental candidate, $24 for
the full comparison, the rest held back as contingency). The ledger and its limits survive restarts:
a rerun cannot reset the cap or buy the same request twice, and only one invocation can use a pilot
directory at a time (pilot.lock). Nothing here runs the installed sync.

Setup, once (see docs/incremental-metadata.md):
  1. Copy the latest healthy full telehealth document into the pilot directory as baseline.md.
     Do not buy a new baseline.
  2. Pick a later commit of the same repository that is a descendant of the baseline's last_commit,
     changes no more than 20% of the eligible source, and falls within seven days of the baseline.

Usage (the provider key comes from the environment, e.g. ANTHROPIC_API_KEY; nothing reads config files):
  python3 -I scripts/pilot-incremental-metadata.py plan        --pilot-dir DIR --repo-path PATH --target SHA --model MODEL
  python3 -I scripts/pilot-incremental-metadata.py incremental --pilot-dir DIR --repo-path PATH --target SHA --model MODEL
  python3 -I scripts/pilot-incremental-metadata.py full        --pilot-dir DIR --repo-path PATH --target SHA --model MODEL
"""

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from repo_radar import incremental_metadata as im  # noqa: E402
from repo_radar import metadata_snapshot as snap  # noqa: E402
from repo_radar.metadata import UnsafeHeader, render_metadata_document  # noqa: E402
from repo_radar.metadata_budget import Budget, Ledger, LockHeld, acquire_exclusive_lock  # noqa: E402
from repo_radar.model_catalog import is_known_model  # noqa: E402

PILOT_REPO = 'ReperioHealth/reperio-telehealth'
CAP_USD = 40.0
ALLOWANCES = {'incremental': 8.0, 'full': 24.0}


def fail(message):
    print(f"pilot stopped: {message}", file=sys.stderr)
    sys.exit(2)


def load_pilot(args):
    pilot = Path(args.pilot_dir).resolve()
    baseline_path = pilot / 'baseline.md'
    if not baseline_path.is_file():
        fail(f"{baseline_path} is missing; copy the latest healthy full telehealth document there first")
    text = baseline_path.read_text(encoding='utf-8')
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    info = json.loads((pilot / 'pilot.json').read_text()) if (pilot / 'pilot.json').exists() else None
    if info is None:
        info = {'baseline_sha256': digest, 'target': args.target, 'model': args.model,
                'created_at': datetime.now().isoformat()}
        (pilot / 'pilot.json').write_text(json.dumps(info, indent=2) + '\n')
    for key, value in (('baseline_sha256', digest), ('target', args.target), ('model', args.model)):
        if info[key] != value:
            fail(f"this pilot was set up with {key} {info[key]}, not {value}; both candidates must use the same inputs")
    doc = im.Document(baseline_path, text, digest, im.parse_frontmatter(text), text.split('---', 2)[2])
    ok, why = im.usable_baseline(doc, PILOT_REPO)
    if not ok:
        fail(f"baseline.md can't be used: {why}")
    if not is_known_model(args.model):
        fail(f"{args.model} is not in the model catalog")
    return pilot, doc


def decide(args, doc, repo):
    target = snap.resolve_commit(repo, args.target)
    if target is None or target != args.target:
        fail(f"{args.target} is not a full commit ID in {repo}")
    decision = im.decide(repo, PILOT_REPO, doc, None, args.model, target, datetime.now())
    return decision


def write_rejected(pilot, mode, candidate):
    """Save a candidate that was built but can't be accepted as owner-only rejected-<mode>.json."""
    name = f"rejected-{mode}.json"
    payload = {'fields': candidate.fields, 'analysis': candidate.analysis, 'coverage_note': candidate.coverage_note,
               'coverage': im.coverage_line(mode, candidate.omitted, candidate.coverage_note, candidate.outside_selection),
               'omitted': [{'path': p, 'reason': why} for p, why in candidate.omitted],
               'outside_collector_selection': candidate.outside_selection}
    fd = os.open(pilot / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write('\n')
    os.chmod(pilot / name, 0o600)
    return name


def write_result(pilot, mode, record):
    path = pilot / f"results-{mode}.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
    print(json.dumps(record, indent=2, sort_keys=True))


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['plan', 'incremental', 'full'])
    parser.add_argument('--pilot-dir', required=True)
    parser.add_argument('--repo-path', required=True, help='a clone of reperio-telehealth (read through Git objects only)')
    parser.add_argument('--target', required=True, help='the full commit ID both candidates describe')
    parser.add_argument('--model', required=True, help='the configured metadata model, used for both candidates')
    args = parser.parse_args(argv)

    # One invocation per pilot at a time, held from before any setup write through the last result
    # write, so two runs can't both pass the ledger's cap and duplicate checks.
    pilot_dir = Path(args.pilot_dir).resolve()
    if not pilot_dir.is_dir():
        fail(f"{pilot_dir} is not a directory")
    try:
        lock = acquire_exclusive_lock(pilot_dir / 'pilot.lock')
    except LockHeld:
        fail(f"another pilot invocation is using {pilot_dir}; wait for it to finish")
    try:
        return run(args)
    finally:
        os.close(lock)


def run(args):
    pilot, doc = load_pilot(args)
    repo = Path(args.repo_path).resolve()
    decision = decide(args, doc, repo)
    ledger = Ledger(pilot / 'ledger.json', CAP_USD, ALLOWANCES)
    print(f"baseline {doc.info['last_commit'][:12]} -> target {args.target[:12]}: {decision.strategy} ({decision.reason})")
    print(f"ledger: ${ledger.spent():.2f} of ${CAP_USD:.2f} spent "
          f"(incremental ${ledger.spent('incremental'):.2f}/${ALLOWANCES['incremental']:.2f}, "
          f"full ${ledger.spent('full'):.2f}/${ALLOWANCES['full']:.2f})")
    if args.mode == 'plan':
        return 0
    if decision.strategy != 'incremental':
        fail("the target isn't a small, recent change from the baseline; wait for one rather than buying a new baseline")

    from repo_radar.preflight import PreflightSession
    budget = Budget(args.model, ledger=ledger, label=args.mode)
    started = time.monotonic()
    record = {'mode': args.mode, 'model': args.model, 'baseline_commit': doc.info['last_commit'], 'target': args.target,
              'baseline_sha256': doc.sha256, 'started_at': datetime.now().isoformat()}
    candidate = None
    try:
        with PreflightSession() as session:
            if args.mode == 'incremental':
                candidate = im.run_incremental(repo, PILOT_REPO, doc, decision, args.model, session, budget)
            else:
                candidate = im.run_full(repo, PILOT_REPO, args.target, args.model, session, budget,
                                        baseline=im.document_commit(repo, doc))
        coverage = im.coverage_line(args.mode, candidate.omitted, candidate.coverage_note, candidate.outside_selection)
        fields = candidate.fields
        text = render_metadata_document(
            PILOT_REPO, doc.info.get('cache_dir', ''), doc.info.get('clone_url', ''), args.target, datetime.now().isoformat(),
            fields['quick_reference'], fields['brief'], fields['related_repos'], candidate.analysis,
            {'generation_strategy': args.mode, 'generation_model': args.model, 'pilot': 'true', 'coverage': coverage})
    except im.StaleUpdate as e:
        record.update(status='stopped', reason=im.safe_reason(e.reason))
    except UnsafeHeader as e:
        record.update(status='failed', reason=im.safe_reason(f"the candidate's header is unsafe: {e}"))
    except Exception as e:
        record.update(status='failed', reason=im.safe_reason(f"{type(e).__name__}: {e}"))
    else:
        (pilot / f"{args.mode}.md").write_text(text)
        record.update(status='complete', output=f"{args.mode}.md", coverage_note=candidate.coverage_note,
                      coverage=coverage, omitted=[{'path': p, 'reason': why} for p, why in candidate.omitted],
                      outside_collector_selection=candidate.outside_selection)
    if candidate is not None and record['status'] != 'complete':
        # Paid-for but rejected: keep it as evidence (never as a document), with what it cost below.
        record['rejected_candidate'] = write_rejected(pilot, args.mode, candidate)
    usage = budget.summary()
    record['cost'] = (f"${usage['cost_usd']:.4f}" if usage['cost_usd'] is not None else
                      f"cost unknown (known subtotal ${usage['known_cost_usd']:.4f}; "
                      f"${usage['retained_reservation_usd']:.4f} stays reserved)")
    record.update(elapsed_seconds=round(time.monotonic() - started, 1), usage=usage,
                  ledger_spent_usd=round(ledger.spent(), 4), ledger_spent_this_mode_usd=round(ledger.spent(args.mode), 4))
    write_result(pilot, args.mode, record)
    return 0 if record['status'] == 'complete' else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
