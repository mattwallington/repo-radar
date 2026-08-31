'use strict';
// Node mirror of repo_radar/activity/redact.py -- write-time credential/secret masking. writer.js
// runs every event/control/terminal free-text field value and `detail` through `Redactor.scrub`
// BEFORE the record is built/encoded, so a leaked token never lands in a segment on disk.
//
// Regex forms copied verbatim from redact.py (same patterns; Python's leading `(?i)` inline flag
// -> the JS `i` flag applied to the whole pattern, which is exactly equivalent here since none of
// these patterns rely on Python's PER-GROUP inline-flag scoping; `\b` word-boundary semantics are
// identical across both engines for these ASCII-anchored patterns). `g` (global) is required on
// every form so `.replace` masks ALL occurrences in the text, matching Python's `pattern.sub`
// (which replaces every match by default, not just the first).
const _FORMS = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._-]{16,}/gi, '[REDACTED authorization]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED github token]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED github token]'],
  [/sk-(?:ant-)?[A-Za-z0-9._-]{16,}/g, '[REDACTED api key]'],
  [/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED google key]'],
  [/\/\/[^/@\s]+@/g, '//<redacted>@'],
];

class Redactor {
  constructor(configuredSecrets) {
    // Longest-first (mirrors redact.py's `sorted({...}, key=len, reverse=True)`): if one
    // configured secret is a PREFIX of another longer one, masking the SHORTER pattern first
    // would leave the longer secret's un-matched tail exposed in plain text (e.g. "abc" masking
    // first inside "abcdef123456" would strand "def123456"). De-duplicated via a Set first, same
    // as Python's set-comprehension; order among equal-length secrets doesn't matter since none
    // can be a substring of another at the same length.
    const list = Array.isArray(configuredSecrets) ? configuredSecrets : Array.from(configuredSecrets || []);
    this._secrets = [...new Set(list.filter((s) => s))].sort((a, b) => b.length - a.length);
  }

  scrub(text) {
    if (text === null || text === undefined) return text; // mirrors `if text is None: return text`
    let s = String(text);
    for (const secret of this._secrets) {
      // Literal substring replace-ALL (never regex-interpreted), matching Python's `str.replace`.
      s = s.replaceAll(secret, '[REDACTED]');
    }
    for (const [pat, repl] of _FORMS) {
      s = s.replace(pat, repl);
    }
    return s;
  }
}

module.exports = { Redactor };
