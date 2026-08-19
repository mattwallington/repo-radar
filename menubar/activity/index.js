'use strict';
// Barrel for the Node activity-subsystem primitives (Task 2.1: ids/paths/records mirrors).
// Later Phase 2 tasks build the Electron lease/writer logic on top of these.
const ids = require('./ids');
const paths = require('./paths');
const records = require('./records');

module.exports = { ...ids, ...paths, ...records };
