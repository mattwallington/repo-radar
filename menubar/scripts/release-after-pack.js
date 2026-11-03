'use strict';
// electron-builder afterPack hook (package.json build.afterPack). electron-builder 24 always names the
// updater download cache after the npm package ("repo-radar-updater") and ignores a configured
// updaterCacheDirName, so Dev and stable would share one cache. This runs after electron-builder has
// written Contents/Resources/app-update.yml and before signing: it checks the feed, sets the cache name
// for the build's channel, and checks the result. The channel comes from the packaged version and must
// agree with the bundle ID.

const fs = require('fs');
const path = require('path');
const { APP_UPDATE, BUNDLE_IDS, channelOf, checkAppUpdate, dumpFeed } = require('./release-artifacts');

function setUpdaterCache(file, channel) {
  const want = APP_UPDATE[channel];
  const doc = require('js-yaml').load(fs.readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object') throw new Error(`${file} is not a mapping`);
  for (const key of ['provider', 'owner', 'repo']) {
    if (doc[key] !== want[key]) throw new Error(`${file} ${key} is ${doc[key]}, expected ${want[key]}`);
  }
  doc.updaterCacheDirName = want.updaterCacheDirName;
  const text = dumpFeed(doc);
  checkAppUpdate(text, channel);
  fs.writeFileSync(file, text);
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { packager, appOutDir, targets } = context;
  const file = path.join(packager.getResourcesDir(appOutDir), 'app-update.yml');
  const updating = targets.some((t) => t.name === 'zip' || t.name === 'dmg');
  if (!fs.existsSync(file)) {
    if (updating) throw new Error(`electron-builder wrote no app-update.yml for this ZIP/DMG build: ${file}`);
    return;
  }
  const { version, id } = packager.appInfo;
  const channel = channelOf(version);
  if (!channel) throw new Error(`packaged version ${version} is neither stable (x.y.z) nor Dev (x.y.z-dev.N)`);
  if (id !== BUNDLE_IDS[channel]) throw new Error(`a ${channel} build must have bundle ID ${BUNDLE_IDS[channel]}, not ${id}`);
  setUpdaterCache(file, channel);
}

module.exports = { afterPack, setUpdaterCache };
