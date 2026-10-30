'use strict';
// A fresh, minimal environment for the release scripts' child processes (unzip, plutil, git, the release
// Python, xcodebuild, gh). Publication tokens, Apple credentials and variables that change how Node,
// Python or Git behave never reach them: the tokens stay in the Node parent for its GitHub requests.
// The DMG signing and notary tools keep their own narrower allowlist in release-dmg.js.

const KEYS = Object.freeze(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'DEVELOPER_DIR', 'GH_CONFIG_DIR']);
const PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

function releaseEnv(source = process.env) {
  const env = { PATH };
  for (const key of KEYS) if (source[key]) env[key] = source[key];
  return env;
}

module.exports = { releaseEnv, KEYS, PATH };
