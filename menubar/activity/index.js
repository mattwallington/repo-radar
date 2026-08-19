'use strict';
// Barrel for the Node activity-subsystem primitives (Task 2.1: ids/paths/records mirrors; Task
// 2.2a: lease). Later Phase 2 tasks build the Electron quota/writer logic on top of these.
const ids = require('./ids');
const paths = require('./paths');
const records = require('./records');
const lease = require('./lease');

module.exports = { ...ids, ...paths, ...records, ...lease };
