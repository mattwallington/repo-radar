'use strict';
// Ruling P5-4 (Codex final verdict, BLOCKER): retention MUST run before the View Errors cache is
// recomputed, not after.
//
// `activityQuota._spawnPythonRetain(home)` is `spawnSync` -- the Python `retain` entrypoint has
// already finished deleting by the time it returns. main.js's sync `close` handler used to
// refresh the cached View-Errors target FIRST and spawn retention SECOND, so the cache could name
// an activity that retention deleted microseconds later: the tray kept offering "⚠️ View Errors"
// and the deep link opened a missing item, until the next 30s tick happened to correct it.
//
// The reviewer's repro is encoded literally below: ONE 90-day-expired `failed` activity (the only
// problem-bearing item in the store, so `viewErrorsTarget` is certain to select it) plus 50 recent
// `succeeded` ones (so the expired item falls outside the protective newest-50 window and its
// `problem` age gate -- 90 days -- genuinely expires). This is the REAL Python retention pass, not
// a stub: `repo_radar/activity/quota.py`'s `_retain_locked` matrix decides what dies.
//
// Two orderings are asserted:
//   * the OLD order (refresh, then retain)  -> the cached target is `missing` afterwards. This is
//     the bug, encoded as a test so it can never come back silently.
//   * the NEW order (retain, then refresh)  -> whatever the cache names is live (or it names
//     nothing at all); `getActivity` never reports `missing` for it.
//
// The third test is the one that binds this file to the shipped code: main.js cannot be
// `require()`d outside a running Electron process (the same constraint retention-wiring.test.js
// documents), so it READS main.js, extracts the real relative order of the retain spawn and the
// cache refresh at BOTH call sites (the sync `close` handler and the startup setTimeout), and
// REPLAYS that exact order against a real store. Restore the old ordering in main.js and this test
// fails on the store, not merely on a source-order assertion.
//
// Retention age is decided by the newest SEGMENT MTIME (quota.py `_classify` -> `scan.mtime`),
// exactly as repo_radar/tests/test_activity_retain.py backdates with `os.utime` -- so the expired
// fixture backdates both its record timestamps (what Node's reader sorts on) and its segment mtime
// (what Python's retention matrix measures).
//
// Every tmp dir is `rr-` prefixed and removed in a `finally`, per the repo's tmp-dir policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const A = require('../index');
const read = require('../read');
const { quota } = A;

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

// The default runner `_spawnPythonRetain` falls back to is `python3` + REPO_ROOT as cwd (see
// quota-delegation.test.js's own `configurePythonRunner(null)` "real default" comment). A bare
// `python3 --version` is not enough here: this test needs an interpreter that can actually IMPORT
// the retention entrypoint from this checkout, so the guard imports the very module the spawn will
// run. Skips (never fails) when no such interpreter is available, with the reason attached.
function pythonSkipReason() {
  try {
    execFileSync('python3', ['-c', 'import repo_radar.activity.retain'],
      { cwd: REPO_ROOT, stdio: 'ignore' });
    return false;
  } catch (e) {
    return 'no python3 able to import repo_radar.activity.retain from this checkout';
  }
}
const SKIP = pythonSkipReason();

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-retention-then-target-'));
}

function startRec(aid, seq, ts) {
  return {
    schema_version: 1, activity_id: aid, type: 'start', seq, ts,
    kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
  };
}
function terminalRec(aid, seq, ts, outcome) {
  return {
    schema_version: 1, activity_id: aid, type: 'terminal', seq, ts,
    outcome, summary: {}, by: 'deadbeef',
  };
}

// A SETTLED activity: a conforming start + terminal on one segment, no ledger entry and no held
// owner.lock, so both Python's `_classify` and Node's reader see a finished run (never 'running').
// `ageDays` backdates the segment mtime, which is what the §7 age matrix measures.
function seedSettled(home, { outcome, ts, ageDays }) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  const text = [startRec(aid, 0, ts), terminalRec(aid, 1, ts, outcome)]
    .map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(seg, text, { mode: 0o600 });
  if (ageDays) {
    const when = (Date.now() / 1000) - (ageDays * 86400);
    fs.utimesSync(seg, when, when);
  }
  return aid;
}

// The reviewer's store: one 100-day-old `failed` (the only problem-bearing item) + 50 fresh
// `succeeded` ones, so the failed item is candidate #51 by mtime -- outside the protective
// newest-50 window -- and older than the 90-day problem gate.
function seedReviewerStore(home) {
  A.secureMkdir(A.quotaDir(home));
  const expired = seedSettled(home,
    { outcome: 'failed', ts: '2026-05-24T09:00:00-07:00', ageDays: 100 });
  for (let i = 0; i < 50; i++) {
    seedSettled(home, { outcome: 'succeeded', ts: '2026-08-31T09:00:00-07:00', ageDays: 0 });
  }
  return expired;
}

function runRealRetain(home) {
  quota.configurePythonRunner(null);              // real default: python3 + REPO_ROOT
  const r = quota._spawnPythonRetain(home);
  assert.ifError(r.error, `retain spawn failed: ${r.error && r.error.message}`);
  assert.strictEqual(r.status, 0,
    `retain entrypoint must exit 0 (stderr: ${r.stderr && r.stderr.toString()})`);
  return r;
}

test('the OLD order (refresh, then retain) caches a target the real retention pass then deletes',
  { skip: SKIP }, () => {
    const home = tmpHome();
    try {
      const expired = seedReviewerStore(home);

      // main.js's pre-fix close handler, in order: refresh the cache, THEN spawn retention.
      const cached = read.viewErrorsTarget(home);
      assert.strictEqual(cached, expired,
        'the expired failure is the only problem-bearing item, so it must be the selected target');

      runRealRetain(home);

      assert.strictEqual(fs.existsSync(A.activityDir(home, expired)), false,
        'the 100-day-old failure is outside newest-50 and past the 90-day problem gate: retention must delete it');

      // The bug: the tray would still be offering this id, and the deep link opens nothing.
      const opened = read.getActivity(home, cached);
      assert.strictEqual(opened.item, null);
      assert.strictEqual(opened.reason, 'missing',
        'this is the defect being fixed -- a cache computed before retention names a deleted activity');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

test('the NEW order (retain, then refresh) never names a deleted activity',
  { skip: SKIP }, () => {
    const home = tmpHome();
    try {
      const expired = seedReviewerStore(home);

      // main.js's fixed close handler, in order: spawn retention, THEN refresh the cache.
      runRealRetain(home);

      assert.strictEqual(fs.existsSync(A.activityDir(home, expired)), false,
        'same retention outcome -- the ordering fix changes WHEN the cache is computed, not what is pruned');

      const cached = read.viewErrorsTarget(home);
      if (cached === null) {
        // The honest answer for this store: the only incident is gone, so there is nothing to open
        // and the tray must not offer the affordance at all.
        assert.ok(true);
      } else {
        const opened = read.getActivity(home, cached);
        assert.notStrictEqual(opened.reason, 'missing',
          `a post-retention cache must only ever name a LIVE activity, got missing for ${cached}`);
        assert.ok(opened.item !== null, 'a non-null target must open to a real item');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });


// -------------------------------------------------------------------------------------------
// Binding the repro to the shipped ordering in main.js
// -------------------------------------------------------------------------------------------

// Comment-stripped main.js source, line-based (a `//` inside a string literal is never touched) --
// same `codeOf` helper retention-wiring.test.js / view-errors-wiring.test.js use.
function mainSrc() {
  return fs.readFileSync(MAIN_JS, 'utf8').split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

function slice(src, startAnchor, endAnchor) {
  const a = src.indexOf(startAnchor);
  assert.notStrictEqual(a, -1, `anchor not found in main.js: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notStrictEqual(b, -1, `end anchor not found in main.js: ${endAnchor}`);
  return src.slice(a, b);
}

// The order in which `retain` and `refresh` actually occur inside a main.js slice, by first
// occurrence. Both must be present -- a slice missing either is itself the regression.
function orderOf(text, label) {
  const at = {
    retain: text.indexOf('activityQuota._spawnPythonRetain('),
    refresh: text.indexOf('_refreshViewErrorsTarget()'),
  };
  assert.notStrictEqual(at.retain, -1, `${label}: no retain spawn found`);
  assert.notStrictEqual(at.refresh, -1,
    `${label}: no _refreshViewErrorsTarget() found -- the menu is never rebuilt from the post-retention store`);
  return Object.keys(at).sort((x, y) => at[x] - at[y]);
}

// Replays a main.js ordering against a real store and returns whatever the LAST refresh cached
// (null if the refresh found nothing worth offering).
function replay(home, order) {
  let cached = null;
  for (const step of order) {
    if (step === 'retain') runRealRetain(home);
    else cached = read.viewErrorsTarget(home);
  }
  return cached;
}

for (const site of [
  {
    label: "the sync `close` handler",
    anchors: ["currentSyncProcess.on('close'", "currentSyncProcess.on('error'"],
  },
  {
    label: 'the startup missed-syncs setTimeout',
    anchors: ['setTimeout(() => {\n    reconcileRunReceipt();', '}, 2000);'],
  },
]) {
  test(`main.js's REAL ordering in ${site.label}, replayed against a real store, never caches a deleted activity`,
    { skip: SKIP }, () => {
      const home = tmpHome();
      try {
        const expired = seedReviewerStore(home);
        const order = orderOf(slice(mainSrc(), site.anchors[0], site.anchors[1]), site.label);

        const cached = replay(home, order);

        assert.strictEqual(fs.existsSync(A.activityDir(home, expired)), false,
          'the expired failure must be gone once retention has run');
        if (cached !== null) {
          const opened = read.getActivity(home, cached);
          assert.notStrictEqual(opened.reason, 'missing',
            `${site.label} caches a DELETED activity (order was: ${order.join(' -> ')}) -- ` +
            'the tray would offer "View Errors" for an id the deep link cannot open');
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
}
