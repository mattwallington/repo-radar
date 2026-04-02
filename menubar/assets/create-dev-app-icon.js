#!/usr/bin/env node

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const assetsDir = __dirname;
const iconsetDir = path.join(assetsDir, 'DevAppIcon.iconset');

// Create a 1024x1024 app icon with orange theme and "DEV" badge
async function createDevAppIcon() {
    console.log('Creating dev app icon...');

    const size = 1024;
    const center = size / 2;
    const loopRadius = 340;
    const dotRadius = 100;
    const orange = 'rgb(255,140,0)';

    // Orange icon with DEV banner
    const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2a2a2a"/>
          <stop offset="100%" stop-color="#1a1a1a"/>
        </linearGradient>
      </defs>
      <!-- Rounded square background -->
      <rect width="${size}" height="${size}" rx="220" ry="220" fill="url(#bg)"/>
      <!-- Loop -->
      <circle cx="${center}" cy="${center - 30}" r="${loopRadius}" fill="none" stroke="${orange}" stroke-width="80"/>
      <!-- Top dot -->
      <circle cx="${center}" cy="${center - 30 - loopRadius}" r="${dotRadius}" fill="${orange}"/>
      <!-- Bottom dot -->
      <circle cx="${center}" cy="${center - 30 + loopRadius}" r="${dotRadius}" fill="${orange}"/>
      <!-- DEV banner -->
      <rect x="0" y="820" width="${size}" height="204" rx="0" fill="${orange}"/>
      <text x="${center}" y="955" font-family="Helvetica Neue, Arial, sans-serif" font-weight="bold" font-size="150" fill="#1a1a1a" text-anchor="middle">DEV</text>
    </svg>
    `;

    // Save source PNG
    const sourcePng = path.join(assetsDir, 'icon-dev-app-1024.png');
    await sharp(Buffer.from(svg)).png().toFile(sourcePng);
    console.log('  ✓ Created icon-dev-app-1024.png');

    // Create iconset
    if (!fs.existsSync(iconsetDir)) {
        fs.mkdirSync(iconsetDir);
    }

    const sizes = [
        { size: 16, name: 'icon_16x16.png' },
        { size: 32, name: 'icon_16x16@2x.png' },
        { size: 32, name: 'icon_32x32.png' },
        { size: 64, name: 'icon_32x32@2x.png' },
        { size: 128, name: 'icon_128x128.png' },
        { size: 256, name: 'icon_128x128@2x.png' },
        { size: 256, name: 'icon_256x256.png' },
        { size: 512, name: 'icon_256x256@2x.png' },
        { size: 512, name: 'icon_512x512.png' },
        { size: 1024, name: 'icon_512x512@2x.png' }
    ];

    for (const { size, name } of sizes) {
        await sharp(sourcePng)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toFile(path.join(iconsetDir, name));
    }

    // Convert to icns
    const icnsPath = path.join(assetsDir, 'icon-dev.icns');
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, { stdio: 'inherit' });
    execSync(`rm -rf "${iconsetDir}"`);

    console.log('  ✓ Created icon-dev.icns');
    console.log('\n✅ Dev app icon created!');
}

createDevAppIcon().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
