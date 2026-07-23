'use strict';
const fs = require('fs');

const SCHEMA = 1;
// Explicit build-intent transition (Codex C2 / Matt): a build first publishes
// PROVISIONING (fail-closed — no active runtime; every entry point refuses), then
// publishes the complete ACTIVE identity just before the atomic `current` flip.
// A failed provision leaves desired at PROVISIONING, so all entry points stay closed.
const PROVISIONING = 'provisioning';
const ACTIVE = 'active';

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

// A runtime may be served only when desired is a compatible ACTIVE record.
function isActive(obj) {
  return schemaCompatible(obj) && obj.status === ACTIVE;
}

module.exports = { SCHEMA, PROVISIONING, ACTIVE, publishDesired, readDesired, schemaCompatible, isActive };
