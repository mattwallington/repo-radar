'use strict';
// Barrel for the Node activity-subsystem primitives (Task 2.1: ids/paths/records mirrors; Task
// 2.2a: lease; Task 2.2b: quota/reconcile). Later Phase 2 tasks build the Electron writer logic
// on top of these.
const ids = require('./ids');
const paths = require('./paths');
const records = require('./records');
const lease = require('./lease');
const quota = require('./quota');
const reconcile = require('./reconcile');

module.exports = {
  ...ids, ...paths, ...records, ...lease,
  quota, reconcile,
};
