const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Landmark only — the BEHAVIOR is proven by model-notice-controller.test.js.
assert.ok(/require\(['"]\.\/model-notice-controller['"]\)/.test(src), 'requires the controller');
assert.ok(/before-quit['"]\s*,\s*\(\)\s*=>\s*\{\s*appIsQuitting = true/.test(src), 'before-quit sets appIsQuitting');
assert.ok(/modelNoticeController\.maybe\(\)/.test(src), 'trigger is called at startup');
assert.ok(/persistConfig\(config, \{ reconcileSchedule: true/.test(src), 'save-config uses persistConfig');
assert.ok(/event\.sender/.test(src) === false || /getView\(event\.sender\)/.test(src), 'IPC forwards sender to the controller for binding');
console.log('model-notice wiring landmark OK');
