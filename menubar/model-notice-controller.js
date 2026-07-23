'use strict';
const { computeModelNotice, noticeSignature, renderNoticeText, planFinalize, persistConfig } = require('./model-notice');

// Dependency-injected coordinator. All Electron/IO is injected so behavior is unit-testable.
function createModelNoticeController(deps) {
  let win = null;
  let finalized = false;

  function maybe() {
    if (deps.channel !== 'stable') return null;
    const config = deps.readConfig();
    const notice = computeModelNotice(config.ai_model);
    if (!notice) return null;
    const sig = noticeSignature(notice);
    if (config.model_notice_ack === sig) return null;
    finalized = false;
    win = deps.openWindow(notice, sig);
    win.sig = sig; win.notice = notice;
    return win;
  }

  function getView(sender) {
    if (!win || sender !== win.webContents) return null;
    return renderNoticeText(win.notice, deps.labels);
  }

  function finalize(action) {
    if (finalized || !win) return;
    const plan = planFinalize(action, deps.readConfig(), win.sig);
    if (plan.staleOrGone) { finalized = true; win.destroy(); win = null; return; }
    if (!plan.valid) return; // disallowed/invalid target: ignore, do NOT finalize
    const res = persistConfig(plan.nextConfig, { reconcileSchedule: plan.reconcileSchedule, save: deps.save, reconcile: deps.reconcile });
    if (!res.ok) { deps.showError(res.error); return; } // benign; keep window, ack unchanged, re-shows next launch
    if (res.schedule && res.schedule.ok === false) deps.showScheduleWarning(res.schedule.error);
    finalized = true; win.destroy(); win = null;
    if (plan.openSettings) deps.openSettings();
  }

  function onAction(sender, action) {
    if (!win || sender !== win.webContents) return; // foreign sender rejected
    if (typeof action !== 'string') return;
    finalize(action);
  }

  // Pure decision for main's `close` handler: 'handle' -> preventDefault + finalize('close').
  function closeDecision() {
    if (finalized || deps.isQuitting()) return 'allow'; // done, or quitting (never trap app.quit)
    return 'handle';
  }

  return { maybe, getView, onAction, closeDecision, finalize, isFinalized: () => finalized };
}

module.exports = { createModelNoticeController };
