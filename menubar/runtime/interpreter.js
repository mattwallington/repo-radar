'use strict';
const { execFileSync } = require('child_process');

class NoInterpreterError extends Error {}

const PROBE =
  'import sys,platform,sysconfig,os;' +
  "print(sys.version_info[0],sys.version_info[1],sys.version_info[2],sys.implementation.name,platform.machine(),(sysconfig.get_config_var('SOABI') or 'none'));" +
  'print(os.path.realpath(sys.executable))';

function probe(exe) {
  try {
    // line 1: version/impl/arch/abi (whitespace-split); line 2: the REAL executable path
    const lines = execFileSync(exe, ['-c', PROBE], { encoding: 'utf8', timeout: 8000 }).trim().split('\n');
    const out = lines[0].trim().split(/\s+/);
    const realExe = lines[1] ? lines[1].trim() : exe;
    return { exe: realExe, version: [+out[0], +out[1], +out[2]], impl: out[3], arch: out[4], abi: out[5] };
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

const SUPPORTED_MINORS = [14, 13, 12, 11, 10]; // newest first
const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'];

// The unversioned defaults keep their preference. The versioned Homebrew executables
// follow, so a supported Python is still found after Homebrew's default python3 moves
// past 3.14. The opt/ path covers a formula that is installed but not linked into bin.
function defaultCandidates(pyenvWhich = _pyenvWhich) {
  const candidates = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', pyenvWhich(), 'python3'];
  for (const minor of SUPPORTED_MINORS) {
    for (const prefix of HOMEBREW_PREFIXES) {
      candidates.push(
        `${prefix}/bin/python3.${minor}`,
        `${prefix}/opt/python@3.${minor}/bin/python3.${minor}`
      );
    }
  }
  return candidates;
}

// opts.probe / opts.pyenvWhich are test seams; production uses the real probes.
function resolveBaseInterpreter(opts = {}) {
  const probeFn = opts.probe || probe;
  const candidates = (opts.candidates || defaultCandidates(opts.pyenvWhich)).filter(Boolean);
  for (const exe of candidates) {
    const info = probeFn(exe);
    if (info && info.version[0] === 3 && info.version[1] >= 10 && info.version[1] < 15) {
      // opts.accept lets a caller further constrain the accepted set — e.g. require a
      // checked-in dependency lock for the interpreter's env (spec §3.6). Skip to the
      // next candidate when rejected, so a covered interpreter later in the list wins.
      if (opts.accept && !opts.accept(exe, info)) continue;
      return { ...info }; // info.exe is the resolved real executable (Codex minor)
    }
  }
  throw new NoInterpreterError(
    'no CPython 3.10-3.14 interpreter found' + (opts.accept ? ' with a checked-in dependency lock' : '')
  );
}

module.exports = { NoInterpreterError, probe, defaultCandidates, resolveBaseInterpreter };
