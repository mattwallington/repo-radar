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
const limits = require('../limits');

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
// 8. Never throws. `limits.LIST_MAX` is the documented monkeypatch seam (limits.js's own header):
//    read.js reads it through the shared module object at call time, so a bad bound makes the very
//    `listActivities` call inside `viewErrorsTarget` raise `InvalidFilter`. The tray must see
//    `null`, not an exception.
// -----------------------------------------------------------------------------------------------
test('viewErrorsTarget: a reader throw yields null rather than propagating', () => {
  const home = tmpHome();
  const realMax = limits.LIST_MAX;
  try {
    seedSegment(home, AID.a, [
      startRec(AID.a, 0, '2026-08-14T09:00:00-07:00'),
      terminalRec(AID.a, 1, '2026-08-14T09:01:00-07:00', 'failed'),
    ]);
    limits.LIST_MAX = -1; // `{ limit: -1 }` -> InvalidFilter from validateFilter
    assert.throws(() => read.listActivities(home, { limit: limits.LIST_MAX }), read.InvalidFilter,
      'guard: the seam must really make listActivities throw, or this test proves nothing');
    assert.strictEqual(read.viewErrorsTarget(home), null);
  } finally {
    limits.LIST_MAX = realMax;
    cleanup(home);
  }
});
