'use strict';
const fs = require('fs');

const SCHEMA = 1;

// Atomically publish the per-channel intent record. Writing to a temp file then
// renaming means a reader never observes a partial write. Mode 0600.
function publishDesired(desiredPath, obj) {
  const record = { schema: SCHEMA, ...obj };
  const tmp = `${desiredPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, desiredPath);
  return record;
}

function readDesired(desiredPath) {
  try {
    return JSON.parse(fs.readFileSync(desiredPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function schemaCompatible(obj) {
  return !!obj && obj.schema === SCHEMA;
}

module.exports = { SCHEMA, publishDesired, readDesired, schemaCompatible };
