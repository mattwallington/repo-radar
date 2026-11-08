#!/usr/bin/env python3
"""Telehealth-only pilot for incremental metadata. Everything goes to a scratch pilot directory, never
to the installed metadata document, and nothing here runs the installed sync. Only one invocation can use
a pilot directory at a time (pilot.lock), and a durable ledger's limits survive restarts: a rerun cannot
reset the cap or buy the same request twice.

Replay a manifest of historical cases, from a fresh pilot directory with its own $40 ledger ($24 for a
scratch baseline, $16 for all replays). `plan` is free and needs no key: it reports each case's pages and
admission quote. `replay` runs the cases in order, stops the chain at the first failure and never buys a
rerun. Matt runs it, with his own key, once the pilot budget is agreed:
  python3 -I scripts/pilot-incremental-metadata.py plan   --manifest FILE --pilot-dir DIR --repo-path PATH
  python3 -I scripts/pilot-incremental-metadata.py replay --manifest FILE --pilot-dir DIR --repo-path PATH

The manifest is JSON (see docs/incremental-metadata.md). Each case names immutable commits, where its
baseline comes from and, as "output", its own directory under the pilot directory:
  {"schema": "repo-radar-pilot-replay/1", "model": "gemini/gemini-3.8-flash", "clone_url": "...", "cases": [
    {"id": "oct27-base", "kind": "full_baseline", "target": "<sha>", "output": "oct27-base"},
    {"id": "oct27", "kind": "replay", "baseline_from": "oct27-base", "base": "<sha>", "target": "<sha>",
     "weekly_trigger": false, "output": "oct27"},
    {"id": "nov3", "kind": "replay", "baseline_file": "/path/to/document.md", "base": "<sha>", "target": "<sha>",
     "weekly_trigger": false, "output": "nov3"}]}
A case's baseline must have been built at exactly its "base" commit; a later document is never relabeled
as a historical one.

The original single-case comparison remains, charged to a ledger capped at $40 ($8 incremental, $24 full),
from a healthy full document copied into the pilot directory as baseline.md and a later target commit:
  python3 -I scripts/pilot-incremental-metadata.py plan        --pilot-dir DIR --repo-path PATH --target SHA --model MODEL
  python3 -I scripts/pilot-incremental-metadata.py incremental --pilot-dir DIR --repo-path PATH --target SHA --model MODEL
  python3 -I scripts/pilot-incremental-metadata.py full        --pilot-dir DIR --repo-path PATH --target SHA --model MODEL

The provider key comes from the environment (for example GEMINI_API_KEY); nothing reads config files.
"""

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from repo_radar import summary_pipeline as mr  # noqa: E402
from repo_radar import incremental_metadata as im  # noqa: E402
from repo_radar import metadata_snapshot as snap  # noqa: E402
from repo_radar.metadata import UnsafeHeader, render_metadata_document  # noqa: E402
from repo_radar.metadata_budget import (INCREMENTAL_CAP_USD, Budget, Ledger, LockHeld,  # noqa: E402
                                        acquire_exclusive_lock)
from repo_radar.model_catalog import get_caps, is_known_model  # noqa: E402

PILOT_REPO = 'ReperioHealth/reperio-telehealth'
CAP_USD = 40.0
ALLOWANCES = {'incremental': 8.0, 'full': 24.0}
REPLAY_ALLOWANCES = {'baseline': 24.0, 'replay': 16.0}
MANIFEST_SCHEMA = 'repo-radar-pilot-replay/1'


def fail(message):
    print(f"pilot stopped: {message}", file=sys.stderr)
    sys.exit(2)


def read_baseline(path):
    """A baseline document, or a stop: unreadable, or no credential protection it should carry."""
    text = Path(path).read_text(encoding='utf-8')
    header = im.parse_frontmatter(text)
    if header is None:
        fail(f"{path} has no readable header")
    doc = im.Document(Path(path), text, hashlib.sha256(text.encode('utf-8')).hexdigest(), header, text.split('---', 2)[2])
    ok, why = im.usable_baseline(doc, PILOT_REPO)
    if not ok:
        fail(f"{path} can't be used: {why}")
    try:
        im.document_exclusions(doc)   # a generated baseline must carry its credential protection
    except im.StaleUpdate as e:
        fail(f"{path} can't be used: {e.reason}")
    return doc


def load_pilot(args):
    pilot = Path(args.pilot_dir).resolve()
    baseline_path = pilot / 'baseline.md'
    if not baseline_path.is_file():
        fail(f"{baseline_path} is missing; copy the latest healthy full telehealth document there first")
    digest = hashlib.sha256(baseline_path.read_bytes()).hexdigest()
    info = json.loads((pilot / 'pilot.json').read_text()) if (pilot / 'pilot.json').exists() else None
    if info is None:
        info = {'baseline_sha256': digest, 'target': args.target, 'model': args.model,
                'created_at': datetime.now().isoformat()}
        (pilot / 'pilot.json').write_text(json.dumps(info, indent=2) + '\n')
    for key, value in (('baseline_sha256', digest), ('target', args.target), ('model', args.model)):
        if info[key] != value:
            fail(f"this pilot was set up with {key} {info[key]}, not {value}; both candidates must use the same inputs")
    doc = read_baseline(baseline_path)
    if not is_known_model(args.model):
        fail(f"{args.model} is not in the model catalog")
    return pilot, doc


def decide(args, doc, repo, deadline):
    target = snap.resolve_commit(repo, args.target)
    if target is None or target != args.target:
        fail(f"{args.target} is not a full commit ID in {repo}")
    try:
        return im.decide(repo, PILOT_REPO, doc, None, args.model, target, datetime.now(), deadline=deadline)
    except snap.ResourceLimit as e:
        fail(f"listing the changes stopped: {e}")


def write_owner_only(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.chmod(path, 0o600)


def write_rejected(pilot, mode, candidate):
    """Save a candidate that was built but can't be accepted as owner-only rejected-<mode>.json."""
    name = f"rejected-{mode}.json"
    payload = {'fields': candidate.fields, 'analysis': candidate.analysis, 'coverage_note': candidate.coverage_note,
               'coverage': im.coverage_line(mode, candidate.omitted, candidate.coverage_note, candidate.outside_selection),
               'omitted': [{'path': p, 'reason': why} for p, why in candidate.omitted],
               'outside_collector_selection': candidate.outside_selection}
    write_owner_only(pilot / name, json.dumps(payload, indent=2, sort_keys=True) + '\n')
    return name


def write_result(pilot, mode, record):
    """The full record goes to an owner-only file (its usage can hold a refused reply's text); the terminal
    gets the short summary run_case prints."""
    write_owner_only(pilot / f"results-{mode}.json", json.dumps(record, indent=2, sort_keys=True) + '\n')
    print(json.dumps({k: record.get(k) for k in ('mode', 'status', 'reason', 'cost', 'elapsed_seconds', 'ledger_spent_usd')},
                     sort_keys=True))


def cost_text(usage):
    return (f"${usage['cost_usd']:.4f}" if usage['cost_usd'] is not None else
            f"cost unknown (known subtotal ${usage['known_cost_usd']:.4f}; "
            f"${usage['retained_reservation_usd']:.4f} stays reserved)")


# ---- the replay manifest -------------------------------------------------------------------------------

def load_manifest(path):
    try:
        manifest = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        fail(f"{path} can't be read: {e}")
    if not isinstance(manifest, dict) or manifest.get('schema') != MANIFEST_SCHEMA:
        fail(f"{path} is not a {MANIFEST_SCHEMA} manifest")
    if not isinstance(manifest.get('model'), str) or not is_known_model(manifest['model']):
        fail(f"{manifest.get('model')!r} is not in the model catalog")
    cases, seen = manifest.get('cases'), set()
    if not isinstance(cases, list) or not cases:
        fail("the manifest lists no cases")
    for case in cases:
        identity = case.get('id') if isinstance(case, dict) else None
        if not isinstance(identity, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', identity) or identity in seen:
            fail(f"case id {identity!r} must be unique, lowercase letters, digits and dashes")
        output = case.get('output', identity)
        if not isinstance(output, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', output):
            fail(f"{identity}: output must be a directory name under the pilot directory")
        kind = case.get('kind')
        commits = ['target'] + (['base'] if kind == 'replay' else [])
        for key in commits:
            if not snap.SHA.fullmatch(str(case.get(key, ''))):
                fail(f"{identity}: {key} must be a full commit ID")
        if kind == 'replay':
            sources = [key for key in ('baseline_from', 'baseline_file') if case.get(key)]
            if len(sources) != 1:
                fail(f"{identity}: name exactly one of baseline_from and baseline_file")
            if case.get('baseline_from') and case['baseline_from'] not in seen:
                fail(f"{identity}: baseline_from must name an earlier case")
        elif kind != 'full_baseline':
            fail(f"{identity}: kind must be full_baseline or replay")
        seen.add(identity)
    return manifest


def validate_outputs(manifest, pilot):
    """Every case gets its own directory directly under the pilot directory, on a Mac's case-insensitive
    disk and through any symlink. Checked before the first case, so a collision can't skip one."""
    root, seen = pilot.resolve(), {}
    for case in manifest['cases']:
        name = case.get('output', case['id'])
        path = pilot / name
        resolved = path.resolve()
        if resolved.parent != root:
            fail(f"{case['id']}: output {name} must be a directory directly under {root}")
        if path.exists() and not path.is_dir():
            fail(f"{case['id']}: output {name} already exists and isn't a directory")
        key = str(resolved).casefold()
        if key in seen:
            fail(f"{case['id']} and {seen[key]} would share the output directory {name}")
        seen[key] = case['id']


def result_identity(manifest, case, doc):
    """What a completed result must have been built from to count as this case."""
    replay = case['kind'] == 'replay'
    return {'case': case['id'], 'kind': case['kind'], 'model': manifest['model'], 'base': case.get('base'),
            'target': case['target'], 'baseline_sha256': doc.sha256 if doc else None,
            'prompt_version': mr.PROMPT_VERSION if replay else None,
            'pipeline_version': im.PIPELINE_VERSION if replay else None,
            'weekly_trigger': bool(case_days(case)) if replay else None}


def verify_completed(manifest, case, doc, done, directory):
    """Refuse to count a completed result as this case unless it is exactly this case and its candidate is
    still the one it produced. Missing fields count as different. Nothing is rebuilt or overwritten."""
    for key, value in result_identity(manifest, case, doc).items():
        if key not in done or done[key] != value:
            fail(f"{case['id']} has a completed result for different inputs ({key}: {done.get(key)!r}, not {value!r}); "
                 f"nothing is bought or overwritten here, so use a fresh pilot directory")
    candidate = directory / 'candidate.md'
    if not candidate.is_file() or hashlib.sha256(candidate.read_bytes()).hexdigest() != done.get('candidate_sha256'):
        fail(f"{case['id']}'s candidate is missing or isn't the one its result recorded; nothing is bought or overwritten")
    if read_baseline(candidate).info.get('last_commit') != case['target']:
        fail(f"{case['id']}'s candidate describes another commit; nothing is bought or overwritten")


def require_commit(repo, sha, identity):
    if snap.resolve_commit(repo, sha) != sha:
        fail(f"{identity}: {sha} is not a commit in {repo}")


def case_dir(pilot, case):
    directory = pilot / case.get('output', case['id'])
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def case_baseline(pilot, manifest, case):
    """The case's baseline document, or None when an earlier case hasn't built it yet."""
    if case.get('baseline_file'):
        return read_baseline(case['baseline_file'])
    source = next(c for c in manifest['cases'] if c['id'] == case['baseline_from'])
    path = pilot / source.get('output', source['id']) / 'candidate.md'
    return read_baseline(path) if path.is_file() else None


def check_baseline(case, doc):
    if doc.info.get('last_commit') != case['base']:
        fail(f"{case['id']}: its baseline was built at {doc.info.get('last_commit')}, not {case['base']}; "
             f"a later document is never relabeled as a historical baseline")


def case_days(case):
    """The historical cases turn the age trigger off: today's clock must not replace the experiment."""
    return im.DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS if case.get('weekly_trigger', True) else 0


def plan_session(model):
    """Free and offline: a provider that counts over the network gets a local estimate instead."""
    caps = get_caps(model)
    if caps is not None and caps.count_strategy == 'anthropic_api':
        return contextlib.nullcontext(mr.LocalEstimate())
    from repo_radar.preflight import PreflightSession
    return PreflightSession()


def plan_replay(args, manifest, pilot, repo):
    """Each case's page counts and admission quote: no ledger, no provider, no paid request."""
    model = manifest['model']
    proxy = next((read_baseline(c['baseline_file']) for c in manifest['cases'] if c.get('baseline_file')), None)
    plans = []
    with plan_session(model) as session:
        for case in manifest['cases']:
            require_commit(repo, case['target'], case['id'])
            if case['kind'] == 'full_baseline':
                plans.append({'case': case['id'], 'kind': 'full_baseline', 'target': case['target'],
                              'allowance_usd': REPLAY_ALLOWANCES['baseline'],
                              'note': 'a full build at this commit; not quoted here (a telehealth full build was about $20)'})
                continue
            require_commit(repo, case['base'], case['id'])
            doc = case_baseline(pilot, manifest, case)
            deadline = snap.Deadline(im.ATTEMPT_SECONDS)   # one allowance for this case, from before selection
            estimated_from = None
            if doc is None:
                # Its baseline doesn't exist until the earlier case runs, so its section titles and size
                # come from another document. Pages and map counts are real.
                if proxy is None:
                    fail(f"{case['id']}: no document to estimate its editor size from")
                doc, estimated_from = proxy, proxy.path.name
            else:
                check_baseline(case, doc)
            decision = None
            spool = tempfile.mkdtemp(prefix='plan-pages-', dir=case_dir(pilot, case))
            started = time.monotonic()
            try:
                if estimated_from is None:
                    decision = im.decide(repo, PILOT_REPO, doc, None, model, case['target'], datetime.now(),
                                         full_rebuild_days=case_days(case), deadline=deadline)
                prepared = im.prepare_diff(repo, doc, case['base'], case['target'], spool, deadline)
                preparation = time.monotonic() - started
                budget = Budget(model)
                pipeline = mr.Pipeline(PILOT_REPO, doc, prepared, model, session, budget, deadline.at, deadline.clock)
                quote = pipeline.admission()
            except snap.ResourceLimit as e:
                fail(f"{case['id']}: {e}; nothing was spent")
            except im.StaleUpdate as e:
                fail(f"{case['id']}: {e.reason}; nothing was spent")
            finally:
                shutil.rmtree(spool, ignore_errors=True)
            rates = budget.rates
            total = quote.total_usd
            plans.append({
                'case': case['id'], 'kind': 'replay', 'base': case['base'], 'target': case['target'],
                'decision': decision.strategy if decision else 'not checked: baseline not built yet',
                'decision_reason': decision.reason if decision else None, 'weekly_trigger': bool(case_days(case)),
                'pages': quote.pages, 'diff_pages': quote.diff_pages, 'omission_pages': quote.omission_pages,
                'filtered_bytes': prepared.pages.total_bytes, 'changed_records': len(prepared.changes),
                'omissions': dict(Counter(o.reason for o in prepared.pages.omissions)),
                'preparation_seconds': round(preparation, 1), 'map_input_tokens': quote.map_input_tokens,
                'worst_case_merge_calls': quote.merge_calls, 'edit_base_tokens': quote.edit_base_tokens,
                'quote_usd': round(total, 4) if total is not None else None, 'cap_usd': INCREMENTAL_CAP_USD,
                'within_cap': total is not None and total <= INCREMENTAL_CAP_USD,
                'rates_per_mtok': [round(rates.input * 1e6, 4), round(rates.output * 1e6, 4)] if rates else None,
                'rate_valid_until': rates.valid_until if rates else None,
                'editor_size_estimated_from': estimated_from})
    record = {'mode': 'plan', 'model': model, 'cases': plans, 'at': datetime.now().isoformat()}
    write_owner_only(pilot / 'plan.json', json.dumps(record, indent=2, sort_keys=True) + '\n')
    print(json.dumps(record, indent=2, sort_keys=True))
    return 0


def section_diff(old, new):
    """Which sections a candidate changed, by content: exact text kept, removed and added."""
    # Rendering normalizes the document's final newlines, which isn't a change to a section.
    old_sections = [s.text.rstrip('\n') for s in im.split_sections(im._analysis_of(old))]
    new_sections = [s.text.rstrip('\n') for s in im.split_sections(im._analysis_of(new))]
    titles = lambda texts: [t.split('\n', 1)[0][:120] for t in texts]   # noqa: E731
    return {'kept': sum(1 for t in old_sections if t in new_sections),
            'removed': titles([t for t in old_sections if t not in new_sections]),
            'added': titles([t for t in new_sections if t not in old_sections])}


def stage_summary(calls):
    """Calls and latencies per stage, from the saved evidence."""
    stages = {}
    for call in calls:
        entry = stages.setdefault(call['stage'], {'calls': 0, 'seconds': []})
        entry['calls'] += 1
        if call.get('seconds') is not None:
            entry['seconds'].append(call['seconds'])
    return {name: {'calls': e['calls'], 'max_seconds': max(e['seconds'], default=None),
                   'mean_seconds': round(sum(e['seconds']) / len(e['seconds']), 3) if e['seconds'] else None}
            for name, e in stages.items()}


def render_candidate(manifest, case, doc, candidate, strategy, decision, target):
    """A scratch document with the provenance a real publication carries, so a later case can start from
    it. The pilot flag keeps it from being mistaken for an installed document."""
    provenance = im._provenance(strategy, manifest['model'], decision, doc, target, datetime.now(), candidate.coverage_note,
                                candidate.omitted, candidate.outside_selection, candidate.exclusions)
    fields = candidate.fields
    return render_metadata_document(
        PILOT_REPO, (doc.info.get('cache_dir', '') if doc else '') or manifest.get('cache_dir', ''),
        (doc.info.get('clone_url', '') if doc else '') or manifest.get('clone_url', ''), target, datetime.now().isoformat(),
        fields['quick_reference'], fields['brief'], fields['related_repos'], candidate.analysis,
        {'generation_id': uuid.uuid4().hex, 'pilot': 'true', **provenance})


def run_case(manifest, case, doc, repo, directory, ledger):
    """Build one case into its own directory. Returns the result record; a failure is recorded, not raised."""
    from repo_radar.preflight import PreflightSession
    model, target = manifest['model'], case['target']
    baseline = case['kind'] == 'full_baseline'
    budget = Budget(model, cap=None if baseline else INCREMENTAL_CAP_USD, ledger=ledger, label='baseline' if baseline else 'replay')
    started = time.monotonic()
    record = {**result_identity(manifest, case, doc), 'started_at': datetime.now().isoformat()}
    candidate = None
    deadline = snap.Deadline(im.ATTEMPT_SECONDS)   # for a replay, one allowance from before its selection
    try:
        if baseline:
            decision = im.Decision('full', 'pilot baseline', None, target, None, None, None, None)
            with PreflightSession() as session:
                candidate = im.run_full(repo, PILOT_REPO, target, model, session, budget, inherited=snap.NO_EXCLUSIONS)
        else:
            decision = im.decide(repo, PILOT_REPO, doc, None, model, target, datetime.now(), full_rebuild_days=case_days(case),
                                 deadline=deadline)
            if decision.strategy != 'incremental':
                raise im.StaleUpdate(f"this case decides {decision.strategy} ({decision.reason}), not a replay; "
                                     f"no fallback is bought")
            with PreflightSession() as session:
                candidate = im.run_incremental(repo, PILOT_REPO, doc, decision, model, session, budget,
                                               spool_dir=directory / 'pages', evidence_dir=directory, case=case['id'],
                                               deadline=deadline)
        text = render_candidate(manifest, case, doc, candidate, 'full' if baseline else 'incremental', decision, target)
    except im.StaleUpdate as e:
        record.update(status='stopped', reason=im.safe_reason(e.reason))
    except snap.ResourceLimit as e:
        record.update(status='stopped', reason=im.safe_reason(str(e)))
    except UnsafeHeader as e:
        record.update(status='failed', reason=im.safe_reason(f"the candidate's header is unsafe: {e}"))
    except Exception as e:
        record.update(status='failed', reason=im.safe_reason(f"{type(e).__name__}: {e}"))
    else:
        write_owner_only(directory / 'candidate.md', text)
        new = read_baseline(directory / 'candidate.md')
        record.update(status='complete', output=str(directory / 'candidate.md'), candidate_sha256=new.sha256,
                      coverage=new.info.get('coverage'), section_diff=section_diff(doc, new) if doc else None)
    if candidate is not None and record['status'] != 'complete':
        record['rejected_candidate'] = write_rejected(directory, case['id'], candidate)
    usage = budget.summary()
    notes = directory / 'notes.json'
    evidence = json.loads(notes.read_text(encoding='utf-8')) if notes.exists() else None
    if evidence:
        record.update(stages=stage_summary(evidence['calls']), pages=len(evidence['pages']),
                      pages_covered=len({page for n in evidence['notes'] for page in n['pages']}
                                        | {p['id'] for p in evidence['pages'] if p['kind'] == 'omissions'}),
                      omissions=dict(Counter(o['reason'] for o in evidence['omissions'])))
    record.update(cost=cost_text(usage), usage=usage, elapsed_seconds=round(time.monotonic() - started, 1),
                  ledger_spent_usd=round(ledger.spent(), 4), ledger_spent_this_label_usd=round(ledger.spent(budget.label), 4))
    write_owner_only(directory / 'result.json', json.dumps(record, indent=2, sort_keys=True) + '\n')
    print(json.dumps({k: record.get(k) for k in ('case', 'status', 'reason', 'pages', 'cost', 'elapsed_seconds',
                                                 'ledger_spent_usd')}, sort_keys=True))
    return record


def replay(args, manifest, pilot, repo):
    """Run the cases in order. Each uses one no-repeat ledger; the chain stops at the first failure, and a
    case that stopped earlier is never bought again from this directory."""
    ledger = Ledger(pilot / 'ledger.json', CAP_USD, REPLAY_ALLOWANCES)
    for case in manifest['cases']:
        directory = case_dir(pilot, case)
        doc = None
        require_commit(repo, case['target'], case['id'])
        if case['kind'] == 'replay':
            require_commit(repo, case['base'], case['id'])
            doc = case_baseline(pilot, manifest, case)
            if doc is None:
                fail(f"{case['id']}: its baseline case hasn't produced a document")
            check_baseline(case, doc)
        previous = directory / 'result.json'
        if previous.exists():
            done = json.loads(previous.read_text(encoding='utf-8'))
            if done.get('status') == 'complete':
                verify_completed(manifest, case, doc, done, directory)
                print(f"{case['id']}: already complete; not bought again")
                continue
            fail(f"{case['id']} already stopped ({done.get('reason')}); no rerun is bought here, so start a fresh pilot "
                 f"directory if the budget allows one")
        record = run_case(manifest, case, doc, repo, directory, ledger)
        if record['status'] != 'complete':
            print(f"pilot stopped at {case['id']}: {record.get('reason')}", file=sys.stderr)
            return 2
    print(f"ledger: ${ledger.spent():.2f} of ${CAP_USD:.2f} spent")
    return 0


# ---- entry points --------------------------------------------------------------------------------------

def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['plan', 'replay', 'incremental', 'full'])
    parser.add_argument('--pilot-dir', required=True)
    parser.add_argument('--repo-path', required=True, help='a clone of reperio-telehealth (read through Git objects only)')
    parser.add_argument('--manifest', help='a replay manifest: its cases, commits and model')
    parser.add_argument('--target', help='single case: the full commit ID both candidates describe')
    parser.add_argument('--model', help='single case: the configured metadata model, used for both candidates')
    args = parser.parse_args(argv)
    if args.mode == 'replay' and not args.manifest:
        fail("replay needs --manifest")
    if args.manifest and args.mode not in ('plan', 'replay'):
        fail(f"--manifest works only with plan or replay, not {args.mode}")
    if not args.manifest and not (args.target and args.model):
        fail("a single-case run needs --target and --model")

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
        if args.manifest:
            manifest = load_manifest(args.manifest)
            validate_outputs(manifest, pilot_dir)
            repo = Path(args.repo_path).resolve()
            return (plan_replay if args.mode == 'plan' else replay)(args, manifest, pilot_dir, repo)
        return run(args)
    finally:
        os.close(lock)


def run(args):
    pilot, doc = load_pilot(args)
    repo = Path(args.repo_path).resolve()
    deadline = snap.Deadline(im.ATTEMPT_SECONDS)   # one allowance for this run, from before selection
    decision = decide(args, doc, repo, deadline)
    ledger = Ledger(pilot / 'ledger.json', CAP_USD, ALLOWANCES)
    print(f"baseline {doc.info['last_commit'][:12]} -> target {args.target[:12]}: {decision.strategy} ({decision.reason})")
    print(f"ledger: ${ledger.spent():.2f} of ${CAP_USD:.2f} spent "
          f"(incremental ${ledger.spent('incremental'):.2f}/${ALLOWANCES['incremental']:.2f}, "
          f"full ${ledger.spent('full'):.2f}/${ALLOWANCES['full']:.2f})")
    if args.mode == 'plan':
        return 0
    if decision.strategy != 'incremental':
        fail(f"the target decides {decision.strategy} ({decision.reason}) from this baseline; "
             f"wait for a usable one rather than buying a new baseline")

    from repo_radar.preflight import PreflightSession
    budget = Budget(args.model, ledger=ledger, label=args.mode)
    started = time.monotonic()
    record = {'mode': args.mode, 'model': args.model, 'baseline_commit': doc.info['last_commit'], 'target': args.target,
              'baseline_sha256': doc.sha256, 'started_at': datetime.now().isoformat()}
    candidate = None
    try:
        with PreflightSession() as session:
            if args.mode == 'incremental':
                candidate = im.run_incremental(repo, PILOT_REPO, doc, decision, args.model, session, budget,
                                               spool_dir=pilot / 'pages-incremental', evidence_dir=pilot, case=args.mode,
                                               deadline=deadline)
            else:
                candidate = im.run_full(repo, PILOT_REPO, args.target, args.model, session, budget,
                                        baseline=im.document_commit(repo, doc), inherited=im.document_exclusions(doc))
        coverage = im.coverage_line(args.mode, candidate.omitted, candidate.coverage_note, candidate.outside_selection)
        fields = candidate.fields
        text = render_metadata_document(
            PILOT_REPO, doc.info.get('cache_dir', ''), doc.info.get('clone_url', ''), args.target, datetime.now().isoformat(),
            fields['quick_reference'], fields['brief'], fields['related_repos'], candidate.analysis,
            {'generation_strategy': args.mode, 'generation_model': args.model, 'pilot': 'true', 'coverage': coverage,
             im.EXCLUSIONS_KEY: snap.encode_exclusions(candidate.exclusions)})
    except im.StaleUpdate as e:
        record.update(status='stopped', reason=im.safe_reason(e.reason))
    except snap.ResourceLimit as e:
        record.update(status='stopped', reason=im.safe_reason(str(e)))
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
    record['cost'] = cost_text(usage)
    record.update(elapsed_seconds=round(time.monotonic() - started, 1), usage=usage,
                  ledger_spent_usd=round(ledger.spent(), 4), ledger_spent_this_mode_usd=round(ledger.spent(args.mode), 4))
    write_result(pilot, args.mode, record)
    return 0 if record['status'] == 'complete' else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
