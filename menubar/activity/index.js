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

module.exports = {
  // Small self-contained primitives -- flattened to the top level (a single well-known export
  // each, low collision risk), matching the existing ids/paths/records/lease precedent.
  ...ids, ...paths, ...records, ...lease, ...redact,
  // Stateful subsystems with several generically-named functions and/or internal test seams --
  // namespaced to avoid top-level collisions, matching the existing quota/reconcile precedent.
  quota, reconcile, writer,
};
