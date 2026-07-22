'use strict';
const path = require('path');
const fs = require('fs');

class ChannelError extends Error {}

function resolveChannel(buildInfoPath) {
  let ch;
  try { ch = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')).channel; }
  catch (e) { throw new ChannelError(`build-info unreadable: ${e.message}`); }
  if (ch !== 'stable' && ch !== 'dev') throw new ChannelError(`invalid channel: ${ch}`);
  return ch;
}

function layout(home, channel) {
  const root = path.join(home, '.repo-radar');
  const channelDir = path.join(root, channel);
  return {
    root,
    execLock: path.join(root, '.exec.lock'),
    channelDir,
    activationLock: path.join(channelDir, '.activation.lock'),
    desired: path.join(channelDir, 'desired.json'),
    generations: path.join(channelDir, 'generations'),
    current: path.join(channelDir, 'current'),
    runSync: path.join(channelDir, 'run-sync.sh'),
    provisionLog: path.join(channelDir, 'provision.log'),
  };
}

function generationDir(home, channel, genId) {
  return path.join(layout(home, channel).generations, genId);
}

function cliPath(home, channel) {
  return path.join(home, '.local', 'bin', channel === 'dev' ? 'repo-radar-dev' : 'repo-radar');
}

module.exports = { ChannelError, resolveChannel, layout, generationDir, cliPath };
