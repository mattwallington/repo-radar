'use strict';
const { execFileSync } = require('child_process');

class NoInterpreterError extends Error {}

const PROBE =
  'import sys,platform,sysconfig;' +
  "print(sys.version_info[0],sys.version_info[1],sys.version_info[2],sys.implementation.name,platform.machine(),(sysconfig.get_config_var('SOABI') or 'none'))";

function probe(exe) {
  try {
    const out = execFileSync(exe, ['-c', PROBE], { encoding: 'utf8', timeout: 8000 })
      .trim()
      .split(/\s+/);
    return { version: [+out[0], +out[1], +out[2]], impl: out[3], arch: out[4], abi: out[5] };
  } catch (e) {
    return null;
  }
}

function _pyenvWhich() {
  try {
    return (
      execFileSync('pyenv', ['which', 'python3'], { encoding: 'utf8', timeout: 8000 }).trim() ||
      null
    );
  } catch (e) {
    return null;
  }
}

function resolveBaseInterpreter(opts = {}) {
  const candidates = (
    opts.candidates || [
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      _pyenvWhich(),
      'python3',
    ]
  ).filter(Boolean);
  for (const exe of candidates) {
    const info = probe(exe);
    if (info && info.version[0] === 3 && info.version[1] >= 10 && info.version[1] < 15) {
      // opts.accept lets a caller further constrain the accepted set — e.g. require a
      // checked-in dependency lock for the interpreter's env (spec §3.6). Skip to the
      // next candidate when rejected, so a covered interpreter later in the list wins.
      if (opts.accept && !opts.accept(exe, info)) continue;
      return { exe, ...info };
    }
  }
  throw new NoInterpreterError(
    'no CPython 3.10-3.14 interpreter found' + (opts.accept ? ' with a checked-in dependency lock' : '')
  );
}

module.exports = { NoInterpreterError, probe, resolveBaseInterpreter };
