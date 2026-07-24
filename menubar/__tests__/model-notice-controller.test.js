const test = require('node:test'); const assert = require('node:assert');
const { createModelNoticeController } = require('../model-notice-controller');

function harness(over = {}) {
  const state = {
    channel: 'stable', config: { ai_model: 'claude-sonnet-4-6' }, saved: [], reconciled: 0,
    errors: [], scheduleWarnings: [], settingsOpened: 0, quitting: false, settingsOpen: false, windows: [],
    saveResult: { success: true }, reconcileResult: { success: true }, ...over,
  };
  const deps = {
    channel: state.channel,
    readConfig: () => ({ ...state.config }),
    // only a SUCCESSFUL save mutates disk state — a failed save must leave config + ack untouched
    save: (c) => { state.saved.push({ ...c }); if (state.saveResult.success) state.config = { ...c }; return state.saveResult; },
    reconcile: () => { state.reconciled++; return state.reconcileResult; },
    labels: {},
    openWindow: () => { const w = { webContents: { id: state.windows.length + 1 }, destroyed: false, destroy() { this.destroyed = true; } }; state.windows.push(w); return w; },
    showError: (e) => state.errors.push(e),
    showScheduleWarning: (e) => state.scheduleWarnings.push(e),
    isQuitting: () => state.quitting,
    openSettings: () => { state.settingsOpened++; },
    isSettingsOpen: () => state.settingsOpen,
  };
  return { ctl: createModelNoticeController(deps), state };
}

test('maybe: dev build shows nothing (stable-only)', () => {
  const { ctl, state } = harness({ channel: 'dev' });
  assert.strictEqual(ctl.maybe(), null);
  assert.strictEqual(state.windows.length, 0);
});
test('maybe: dedup — a matching ack shows nothing', () => {
  const { ctl, state } = harness();
  state.config.model_notice_ack = 'suggestion:claude-sonnet-4-6>claude-sonnet-5';
  assert.strictEqual(ctl.maybe(), null);
  assert.strictEqual(state.windows.length, 0);
});
test('maybe: opens a window for an actionable notice', () => {
  const { ctl, state } = harness();
  assert.ok(ctl.maybe());
  assert.strictEqual(state.windows.length, 1);
});
test('onAction: foreign sender is rejected (no persist, not finalized)', () => {
  const { ctl, state } = harness();
  ctl.maybe();
  ctl.onAction({ id: 999 }, 'switch');
  assert.strictEqual(state.saved.length, 0);
  assert.strictEqual(ctl.isFinalized(), false);
});
test('onAction switch: persists suggested, reconciles, destroys, finalized', () => {
  const { ctl, state } = harness();
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(state.saved[0].ai_model, 'claude-sonnet-5');
  assert.strictEqual(state.reconciled, 1);
  assert.strictEqual(w.destroyed, true);
  assert.strictEqual(ctl.isFinalized(), true);
});
test('save failure: not finalized, error surfaced, window kept, never reconciled, DISK+ACK unchanged, reopens', () => {
  const { ctl, state } = harness({ saveResult: { success: false, error: 'disk full' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(ctl.isFinalized(), false);
  assert.deepStrictEqual(state.errors, ['disk full']);
  assert.strictEqual(w.destroyed, false);
  assert.strictEqual(state.reconciled, 0);
  // a failed save must NOT mutate disk state — model + ack are untouched
  assert.strictEqual(state.config.ai_model, 'claude-sonnet-4-6');
  assert.strictEqual(state.config.model_notice_ack, undefined);
  // ...so a fresh controller on the same (unchanged) config reopens the notice next launch
  const { ctl: ctl2 } = harness({ config: { ...state.config } });
  assert.ok(ctl2.maybe(), 'notice reopens because the ack was never written');
});
test('maybe: deferred when Settings is open (avoids the stale-Settings-snapshot clobber)', () => {
  const { ctl, state } = harness({ settingsOpen: true }); // actionable notice, but Settings is open
  assert.strictEqual(ctl.maybe(), null);
  assert.strictEqual(state.windows.length, 0, 'no notice window while Settings is open');
});
test('idempotent: a second action after finalize does nothing', () => {
  const { ctl, state } = harness();
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(state.saved.length, 1);
});
test('compound Keep: persists effective + acks resulting suggestion; re-run dedups', () => {
  const { ctl, state } = harness({ config: { ai_model: 'gemini/gemini-2.0-flash' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'keep');
  assert.strictEqual(state.saved[0].ai_model, 'gemini/gemini-2.5-flash');
  assert.strictEqual(state.saved[0].model_notice_ack, 'suggestion:gemini/gemini-2.5-flash>gemini/gemini-3.5-flash');
  assert.strictEqual(ctl.maybe(), null, 'resulting config dedups the follow-on suggestion');
});
test('closeDecision is pure: handle normally, allow when finalized', () => {
  const { ctl } = harness();
  const w = ctl.maybe();
  assert.strictEqual(ctl.closeDecision(), 'handle');
  ctl.finalize('keep'); // suggestion close/keep is ack-only -> finalized
  assert.strictEqual(ctl.isFinalized(), true);
  assert.strictEqual(ctl.closeDecision(), 'allow');
});
test('quit escape: closeDecision allows close even when a failing save left it un-finalized', () => {
  const { ctl, state } = harness({ saveResult: { success: false, error: 'x' } });
  const w = ctl.maybe();
  ctl.finalize('switch');
  assert.strictEqual(ctl.isFinalized(), false);
  assert.strictEqual(ctl.closeDecision(), 'handle');
  state.quitting = true;
  assert.strictEqual(ctl.closeDecision(), 'allow');
});
test('getView: foreign sender gets null; the real sender gets the view', () => {
  const { ctl } = harness();
  const w = ctl.maybe();
  assert.strictEqual(ctl.getView({ id: 999 }), null);
  assert.ok(ctl.getView(w.webContents));
});
test('schedule-warning surfaced when reconcile fails (save still ok -> finalized)', () => {
  const { ctl, state } = harness({ reconcileResult: { success: false, error: 'no launchctl' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(ctl.isFinalized(), true, 'schedule failure is non-fatal');
  assert.deepStrictEqual(state.scheduleWarnings, ['no launchctl']);
});
test('migration Review: persists effective (heals retired id) and opens Settings', () => {
  const { ctl, state } = harness({ config: { ai_model: 'claude-3-5-sonnet-20241022' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'review');
  assert.strictEqual(state.saved[0].ai_model, 'claude-sonnet-5');
  assert.strictEqual(state.settingsOpened, 1);
});
