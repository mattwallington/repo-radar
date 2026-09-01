'use strict';
// Task 4.4 / Ruling P4-12: `read.viewErrorsTarget(home, { configuredSecrets })` -- the ONE thing
// the tray's "⚠️ View Errors" affordance is allowed to ask. It answers "is there anything worth
// showing, and which activity is it?" with an id or `null`, and it NEVER throws: the tray menu is
// rebuilt on a 30s timer and on every tray click, so a reader that could raise there would take
// the whole menu down.
//
// The motivating incident this closes: the tray offered "View Errors", the click opened a window
// built solely from `status.json`'s `errorList`, and that list was empty -- because the failure
// was a PRE-ATTEMPT dev-guard block, which never produces per-repo errors. The first test below is
// exactly that store: one `blocked` terminal, no error events, no `errorList` anywhere. It must
// yield a real id.
//
// Seeding style mirrors read.test.js (raw JSONL written straight onto segment paths via the
// paths.js primitives -- this is the READ side only). Every tmp dir is `rr-` prefixed and removed
// in a `finally`, per the repo's post-incident tmp-dir policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const read = require('../read');
const paths = require('../paths');
const reconcileMod = require('../reconcile');
const redactMod = require('../redact');

// The same shape activity/ids.js validates and renderer/activity.js re-checks before it will
// select anything. Asserted on the returned id because that id is handed to `showActivityWindow`,
// which puts it in a URL fragment -- and, through the IPC handler, into a filesystem path.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-view-errors-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function startRec(aid, seq, ts, over = {}) {
  return {
    schema_version: 1, activity_id: aid, type: 'start', seq, ts,
    kind: 'sync', channel: 'dev', trigger: 'manual', created_by: 'electron', ...over,
  };
}
function eventRec(aid, seq, ts, level, name, over = {}) {
  return {
    schema_version: 1, activity_id: aid, type: 'event', seq, ts,
    level, event: name, fields: {}, ...over,
  };
}
function terminalRec(aid, seq, ts, outcome, over = {}) {
  return {
    schema_version: 1, activity_id: aid, type: 'terminal', seq, ts,
    outcome, summary: {}, by: 'deadbeef', ...over,
  };
}

function seedSegment(home, aid, records, producer = 'electron', writerId = 'deadbeef') {
  A.secureMkdir(A.activityDir(home, aid));
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(A.segmentPath(home, aid, producer, writerId), text);
}

// A complete, uneventful run: `succeeded`, no warn/error events, nothing rejected.
function seedClean(home, aid, day) {
  seedSegment(home, aid, [
    startRec(aid, 0, `2026-08-${day}T00:00:00-07:00`),
    eventRec(aid, 1, `2026-08-${day}T00:00:01-07:00`, 'info', 'repo.synced'),
    terminalRec(aid, 2, `2026-08-${day}T00:01:00-07:00`, 'succeeded'),
  ]);
}

const AID = {
  a: '00000000-0000-4000-8000-00000000000a',
  b: '00000000-0000-4000-8000-00000000000b',
  c: '00000000-0000-4000-8000-00000000000c',
};

// -----------------------------------------------------------------------------------------------
// 1. The motivating incident: a pre-attempt dev-guard block. No error EVENTS, no `errorList` --
//    just a `blocked` terminal carrying its reason. This is what the old error window showed as an
//    empty page.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: a dev-guard `blocked` incident with no errorList is a non-null target', () => {
  const home = tmpHome();
  try {
    seedSegment(home, AID.a, [
      startRec(AID.a, 0, '2026-08-14T09:00:00-07:00'),
      terminalRec(AID.a, 1, '2026-08-14T09:00:00-07:00', 'blocked', {
        summary: { reason: 'Dev sync blocked: stable is not provably managed (legacy-install).' },
      }),
    ]);

    // `configuredSecrets` is passed on every reader call (defense in depth, spec §4) -- it must
    // not change which activity is selected.
    const target = read.viewErrorsTarget(home, { configuredSecrets: ['ghp_deadbeefdeadbeef'] });
    assert.strictEqual(target, AID.a);
    assert.match(target, UUID_V4_RE, 'the id handed to showActivityWindow must be a validated UUIDv4');
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 2. Nothing to show -> no affordance. This is the half that makes an empty view impossible.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: a clean store yields null', () => {
  const home = tmpHome();
  try {
    seedClean(home, AID.a, '10');
    seedClean(home, AID.b, '12');
    assert.strictEqual(read.viewErrorsTarget(home), null);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 3. Newest PROBLEM-BEARING, not newest overall -- a clean run after a failure must not hide it.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: an older failure still wins over a newer clean run', () => {
  const home = tmpHome();
  try {
    seedSegment(home, AID.a, [
      startRec(AID.a, 0, '2026-08-10T00:00:00-07:00'),
      eventRec(AID.a, 1, '2026-08-10T00:00:01-07:00', 'error', 'repo.failed'),
      terminalRec(AID.a, 2, '2026-08-10T00:02:00-07:00', 'failed'),
    ]);
    seedClean(home, AID.b, '12');

    assert.strictEqual(read.viewErrorsTarget(home), AID.a);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 4. ... but among several problem-bearing items the NEWEST is the one that opens.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: the newest problem-bearing item wins over older ones', () => {
  const home = tmpHome();
  try {
    seedSegment(home, AID.a, [
      startRec(AID.a, 0, '2026-08-10T00:00:00-07:00'),
      terminalRec(AID.a, 1, '2026-08-10T00:02:00-07:00', 'failed'),
    ]);
    seedClean(home, AID.b, '11');
    seedSegment(home, AID.c, [
      startRec(AID.c, 0, '2026-08-12T00:00:00-07:00'),
      terminalRec(AID.c, 1, '2026-08-12T00:02:00-07:00', 'interrupted'),
    ]);

    assert.strictEqual(read.viewErrorsTarget(home), AID.c);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 5. `hasProblems` without a failure-like outcome still counts -- a run that succeeded but logged
//    a warn/error event carries Problems, and the tray must be able to reach them.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: a `succeeded` run that carries Problems is still a target', () => {
  const home = tmpHome();
  try {
    seedSegment(home, AID.a, [
      startRec(AID.a, 0, '2026-08-12T00:00:00-07:00'),
      eventRec(AID.a, 1, '2026-08-12T00:00:01-07:00', 'warn', 'repo.degraded'),
      terminalRec(AID.a, 2, '2026-08-12T00:01:00-07:00', 'succeeded'),
    ]);

    const target = read.viewErrorsTarget(home);
    assert.strictEqual(target, AID.a);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 6/7. The two "no history at all" shapes. Neither may offer an affordance, and neither may throw.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: a missing store yields null', () => {
  const home = tmpHome(); // fresh tmp dir -- Library/Logs/repo-radar/activity was never created
  try {
    assert.strictEqual(read.viewErrorsTarget(home), null);
  } finally {
    cleanup(home);
  }
});

test('viewErrorsTarget: an unreadable store (available:false) yields null', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = tmpHome();
  const base = path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
  fs.mkdirSync(base, { recursive: true });
  fs.chmodSync(base, 0o000);
  try {
    assert.strictEqual(read.viewErrorsTarget(home), null);
  } finally {
    fs.chmodSync(base, 0o700); // so the rm below can actually descend
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 8/9. Never throws, at either level.
//
// `_safeScanActivity` contains a per-activity failure (the documented `reconcileMod.reconcile`
// injection seam) and surfaces it AS an incident -- an activity the reader cannot scan is exactly
// the kind of thing the user should be able to open. A failure OUTSIDE that containment (root
// enumeration) has no item to attach to and must degrade to "no affordance".
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: an activity that cannot be scanned is surfaced, not silently skipped', () => {
  const home = tmpHome();
  const realReconcile = reconcileMod.reconcile;
  try {
    seedClean(home, AID.a, '12'); // otherwise a clean store -> null
    reconcileMod.reconcile = () => { throw new Error('injected reconcile failure'); };
    assert.strictEqual(read.viewErrorsTarget(home), AID.a);
  } finally {
    reconcileMod.reconcile = realReconcile;
    cleanup(home);
  }
});

test('viewErrorsTarget: a throw outside per-activity containment yields null rather than propagating', () => {
  const home = tmpHome();
  const realList = paths.listOwnedSubdirsDetailed;
  try {
    seedSegment(home, AID.a, [
      startRec(AID.a, 0, '2026-08-14T09:00:00-07:00'),
      terminalRec(AID.a, 1, '2026-08-14T09:01:00-07:00', 'failed'),
    ]);
    assert.strictEqual(read.viewErrorsTarget(home), AID.a, 'guard: the store really has a target');

    paths.listOwnedSubdirsDetailed = () => { throw new Error('injected enumeration failure'); };
    assert.strictEqual(read.viewErrorsTarget(home), null);
  } finally {
    paths.listOwnedSubdirsDetailed = realList;
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 10. Ruling P4-14, the cost shape. The tray must not pay for rendering it never displays: this
//     path returns an id and nothing else, so no Redactor may be constructed and no string may be
//     scrubbed or bounded. `read.js` builds its Redactor as `new redactMod.Redactor(...)` through
//     the shared module object, so replacing the class here observes every construction.
//
//     The `listActivities` half is not decoration -- it proves the spy is actually wired to the
//     seam, so the assertion above cannot pass because the probe was broken.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: renders nothing -- no Redactor is ever constructed (P4-14)', () => {
  const home = tmpHome();
  const RealRedactor = redactMod.Redactor;
  let constructed = 0;
  try {
    for (const [aid, day] of [[AID.a, '10'], [AID.b, '11'], [AID.c, '12']]) {
      seedSegment(home, aid, [
        startRec(aid, 0, `2026-08-${day}T00:00:00-07:00`),
        eventRec(aid, 1, `2026-08-${day}T00:00:01-07:00`, 'info', 'repo.synced'),
        eventRec(aid, 2, `2026-08-${day}T00:00:02-07:00`, 'error', 'repo.failed'),
        terminalRec(aid, 3, `2026-08-${day}T00:01:00-07:00`, 'failed'),
      ]);
    }
    redactMod.Redactor = class extends RealRedactor {
      constructor(...args) { super(...args); constructed += 1; }
    };

    assert.strictEqual(read.viewErrorsTarget(home, { configuredSecrets: ['ghp_deadbeefdeadbeef'] }), AID.c);
    assert.strictEqual(constructed, 0,
      'viewErrorsTarget must not build a Redactor -- it renders no producer-supplied text at all');

    read.listActivities(home, {}, { configuredSecrets: ['ghp_deadbeefdeadbeef'] });
    assert.ok(constructed > 0, 'guard: the spy is wired to the real seam, so the assertion above means something');
  } finally {
    redactMod.Redactor = RealRedactor;
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 11. PARITY, the property that makes Ruling P4-14's fast path safe. `viewErrorsTarget` now derives
//     ordering, outcome and problem-bearing WITHOUT building the DTOs, so the one thing that can
//     silently go wrong is disagreeing with the item the window would actually show. This computes
//     the answer the old implementation computed -- `listActivities` newest-first, first summary
//     with `hasProblems || PROBLEM_OUTCOMES.has(outcome)` -- over a store deliberately stocked with
//     every shape the predicate's six rules react to, and requires the two to match exactly.
// -----------------------------------------------------------------------------------------------
function viaListActivities(home) {
  const result = read.listActivities(home, {});
  if (!result.available) return null;
  for (const item of result.items) {
    if (item.hasProblems || read.PROBLEM_OUTCOMES.has(item.outcome)) return item.id;
  }
  return null;
}

const SHAPES = {
  clean: '00000000-0000-4000-8000-0000000000c1',
  warned: '00000000-0000-4000-8000-0000000000c2',
  failed: '00000000-0000-4000-8000-0000000000c3',
  blocked: '00000000-0000-4000-8000-0000000000c4',
  duplicateTerminal: '00000000-0000-4000-8000-0000000000c5',
  noStart: '00000000-0000-4000-8000-0000000000c6',
  badSegmentName: '00000000-0000-4000-8000-0000000000c7',
  corruptLine: '00000000-0000-4000-8000-0000000000c8',
  multiWriter: '00000000-0000-4000-8000-0000000000c9',
};
// Oldest first, so seeding in this order also makes each successive shape the newest.
const SHAPE_ORDER = ['clean', 'warned', 'failed', 'blocked', 'duplicateTerminal', 'noStart',
  'badSegmentName', 'corruptLine', 'multiWriter'];

// One activity per shape, each on its own day. The shapes are chosen to hit all six rules of the
// shared problem-bearing predicate plus the routine cases that must NOT trigger it.
function seedShape(home, shape, day) {
  const aid = SHAPES[shape];
  const d = String(day);
  const ts = (n) => `2026-08-${d}T00:0${n}:00-07:00`;
  const dir = () => A.activityDir(home, aid);
  switch (shape) {
    case 'clean': // routine: succeeded, info only
      return seedSegment(home, aid, [
        startRec(aid, 0, ts(0)), eventRec(aid, 1, ts(1), 'info', 'repo.synced'),
        terminalRec(aid, 2, ts(2), 'succeeded')]);
    case 'warned': // rule (a) via warn, with a routine outcome
      return seedSegment(home, aid, [
        startRec(aid, 0, ts(0)), eventRec(aid, 1, ts(1), 'warn', 'repo.degraded'),
        terminalRec(aid, 2, ts(2), 'succeeded')]);
    case 'failed': // rules (a) + (b)
      return seedSegment(home, aid, [
        startRec(aid, 0, ts(0)), eventRec(aid, 1, ts(1), 'error', 'repo.failed'),
        terminalRec(aid, 2, ts(2), 'failed')]);
    case 'blocked': // rule (b) alone -- the motivating incident, no events at all
      return seedSegment(home, aid, [
        startRec(aid, 0, ts(0)), terminalRec(aid, 1, ts(1), 'blocked', { summary: { reason: 'guard' } })]);
    case 'duplicateTerminal': // rule (f): two identical ROUTINE terminals is still a writer anomaly
      return seedSegment(home, aid, [
        startRec(aid, 0, ts(0)), terminalRec(aid, 1, ts(1), 'succeeded'),
        terminalRec(aid, 2, ts(1), 'succeeded')]);
    case 'noStart': // no valid start -> 'unknown' + a no-start integrity finding
      return seedSegment(home, aid, [eventRec(aid, 0, ts(0), 'info', 'repo.synced')]);
    case 'badSegmentName': { // rule (e): an entry the reader refused outright
      A.secureMkdir(dir());
      fs.writeFileSync(path.join(dir(), 'not-a-segment.jsonl'), '{}\n');
      return seedSegment(home, aid, [
        startRec(aid, 0, ts(0)), terminalRec(aid, 1, ts(1), 'succeeded')]);
    }
    case 'corruptLine': { // rule (d): a parse-level integrity finding on an otherwise clean run
      A.secureMkdir(dir());
      const text = [JSON.stringify(startRec(aid, 0, ts(0))), '{ not json',
        JSON.stringify(terminalRec(aid, 1, ts(1), 'succeeded'))].join('\n') + '\n';
      return fs.writeFileSync(A.segmentPath(home, aid, 'electron', 'deadbeef'), text);
    }
    case 'multiWriter': // routine, but two segments -> exercises mergeHeads and its writerId tie-break
      seedSegment(home, aid, [startRec(aid, 0, ts(0)),
        eventRec(aid, 1, ts(1), 'info', 'a')], 'electron', 'deadbeef');
      return seedSegment(home, aid, [eventRec(aid, 2, ts(1), 'info', 'b'),
        terminalRec(aid, 3, ts(2), 'succeeded')], 'python', 'cafebabe');
    default:
      throw new Error(`unseeded shape ${shape}`);
  }
}

test('viewErrorsTarget: per shape, agrees with the listActivities-derived answer', () => {
  // A store of ONE activity per case, so every shape's problem-bearing verdict is pinned on its
  // own -- in a mixed store the newest match masks the rest, and rules (d)/(e) would never be the
  // selected answer.
  for (const shape of SHAPE_ORDER) {
    const home = tmpHome();
    try {
      seedShape(home, shape, 12);
      const expected = viaListActivities(home); // the pre-P4-14 implementation, verbatim
      assert.strictEqual(read.viewErrorsTarget(home), expected, `shape ${shape} disagreed`);
      // Guard: the routine shapes must really be null and the rest really an id, or "agreement"
      // would be satisfied by both sides being uniformly blind.
      const routine = ['clean', 'multiWriter'].includes(shape);
      assert.strictEqual(expected, routine ? null : SHAPES[shape],
        `shape ${shape} is miscategorised by the reference implementation itself`);
    } finally {
      cleanup(home);
    }
  }
});

test('viewErrorsTarget: agrees with the listActivities-derived answer as a mixed store narrows', () => {
  // The same shapes together, then narrowed one activity at a time (newest dropped each round):
  // nine different stores, so ORDERING -- not just per-item classification -- is compared too.
  const home = tmpHome();
  try {
    SHAPE_ORDER.forEach((shape, i) => seedShape(home, shape, 10 + i));

    for (let i = SHAPE_ORDER.length; i > 0; i--) {
      const expected = viaListActivities(home);
      assert.strictEqual(read.viewErrorsTarget(home), expected,
        `disagreed with listActivities over a store of ${i} activities`);
      fs.rmSync(A.activityDir(home, SHAPES[SHAPE_ORDER[i - 1]]), { recursive: true, force: true });
    }
    assert.strictEqual(read.viewErrorsTarget(home), null, 'the emptied store offers nothing');
  } finally {
    cleanup(home);
  }
});
