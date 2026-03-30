#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔨 Build with Auto-Versioning\n');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Parse current version
const versionParts = packageJson.version.split('.').map(Number);
let [major, minor, patch] = versionParts;

// Auto-increment patch version
patch += 1;
const newVersion = `${major}.${minor}.${patch}`;

console.log(`📦 Current version: ${packageJson.version}`);
console.log(`📦 New version: ${newVersion}`);

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

console.log('✓ Updated package.json\n');

// Update root VERSION file to stay in sync
const versionFilePath = path.join(__dirname, '..', '..', 'VERSION');
if (fs.existsSync(versionFilePath)) {
  fs.writeFileSync(versionFilePath, newVersion + '\n');
  console.log('✓ Updated VERSION file\n');
} else {
  console.log('⚠ VERSION file not found at repo root\n');
}

// Create build info file
const buildDate = new Date().toISOString();
const buildInfo = {
    version: newVersion,
    buildDate: buildDate,
    buildTimestamp: Date.now()
};

const buildInfoPath = path.join(__dirname, '..', 'build-info.json');
fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));

console.log(`📅 Build date: ${new Date(buildDate).toLocaleString()}`);
console.log(`✓ Created build-info.json\n`);

// Run electron-builder
console.log('🚀 Running electron-builder...\n');
try {
    execSync('npx electron-builder --mac --arm64 --x64', {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env }
    });
    
    console.log('\n✅ Build complete!');
    console.log(`   Version: ${newVersion}`);
    console.log(`   Build date: ${new Date(buildDate).toLocaleString()}`);
    console.log(`   DMG files: dist/Repo Radar-${newVersion}-*.dmg\n`);
} catch (error) {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
}





