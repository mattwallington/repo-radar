'use strict';
// Barrel for the Node activity-subsystem primitives (Task 2.1: ids/paths/records mirrors; Task
// 2.2a: lease; Task 2.2b: quota/reconcile; Task 2.2c: redact/writer -- the Electron manual-path
// producer facade). Later Phase 2 tasks (Electron integration) build on top of these.
const ids = require('./ids');
const paths = require('./paths');
const records = require('./records');
const lease = require('./lease');
const quota = require('./quota');
const reconcile = require('./reconcile');
const redact = require('./redact');
const writer = require('./writer');
const read = require('./read');
const limits = require('./limits');

// Mirrors repo_radar/activity/__init__.py's HANDOFF_REJECTED_EXIT: the adopter's exit code that
// authorizes Electron's trigger-glue.js `handOff` (Task 2.3) to finalize `failed` itself. Defined
// here (the Node "menubar/activity" barrel, the direct analog of the Python package's
// __init__.py) so there is exactly one Node-side definition, not one independently copied into
// trigger-glue.js.
const HANDOFF_REJECTED_EXIT = 66;

module.exports = {
  // Small self-contained primitives -- flattened to the top level (a single well-known export
  // each, low collision risk), matching the existing ids/paths/records/lease precedent.
  ...ids, ...paths, ...records, ...lease, ...redact,
  // Stateful subsystems with several generically-named functions and/or internal test seams --
  // namespaced to avoid top-level collisions, matching the existing quota/reconcile precedent.
  quota, reconcile, writer,
  // Task 3.6: the reader facade -- namespaced (not flattened) since `listActivities`/
  // `buildExport`/`validateFilter`/`InvalidFilter` are generic names that would otherwise risk
  // colliding with a future top-level export, same reasoning as quota/reconcile/writer above.
  // `limits` is exposed too (Task 4.1's IPC handler validates against the same bounds read.js
  // enforces internally, and needs the shared constants object, not a private copy).
  read, limits,
  HANDOFF_REJECTED_EXIT,
};
