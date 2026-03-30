#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('📦 Creating distribution package...\n');

const distDir = path.join(__dirname, '..', 'dist');
const timestamp = new Date().toISOString().split('T')[0];

// Check if dist directory exists
if (!fs.existsSync(distDir)) {
  console.error('❌ Error: dist/ directory not found. Run "npm run build" first.');
  process.exit(1);
}

// Find the built app
const macArm64Dir = path.join(distDir, 'mac-arm64');
const macX64Dir = path.join(distDir, 'mac-x64');

function createZip(sourceDir, outputName) {
  const appPath = path.join(sourceDir, 'Repo Radar.app');
  if (!fs.existsSync(appPath)) {
    console.log(`⚠️  Skipping ${outputName} - app not found`);
    return null;
  }

  const zipPath = path.join(distDir, outputName);
  console.log(`📦 Creating ${outputName}...`);
  
  try {
    execSync(`cd "${sourceDir}" && zip -r "${zipPath}" "Repo Radar.app" -x "*.DS_Store"`, {
      stdio: 'ignore'
    });
    
    const stats = fs.statSync(zipPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`✓ Created ${outputName} (${sizeMB} MB)`);
    return zipPath;
  } catch (err) {
    console.error(`❌ Error creating ${outputName}:`, err.message);
    return null;
  }
}

// Create distribution packages
const packages = [];

if (fs.existsSync(macArm64Dir)) {
  const zipName = `Repo-Radar-${timestamp}-arm64.zip`;
  const zipPath = createZip(macArm64Dir, zipName);
  if (zipPath) packages.push(zipPath);
}

if (fs.existsSync(macX64Dir)) {
  const zipName = `Repo-Radar-${timestamp}-x64.zip`;
  const zipPath = createZip(macX64Dir, zipName);
  if (zipPath) packages.push(zipPath);
}

// Copy setup guide
const docPath = path.join(__dirname, '..', 'SETUP.md');
if (fs.existsSync(docPath)) {
  const destPath = path.join(distDir, 'SETUP.md');
  fs.copyFileSync(docPath, destPath);
  console.log('✓ Copied setup guide');
  packages.push(destPath);
}

console.log('\n✅ Distribution packages created in dist/:\n');
packages.forEach(p => {
  console.log(`   ${path.basename(p)}`);
});

console.log('\n📤 Ready to distribute!\n');

