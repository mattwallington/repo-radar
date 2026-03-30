#!/usr/bin/env node

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const assetsDir = __dirname;
const iconsetDir = path.join(assetsDir, 'AppIcon.iconset');
const sourceIcon = path.join(assetsDir, 'icon.png');

// Create iconset directory
if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir);
}

// Define all required icon sizes for macOS
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

async function createIcons() {
    console.log('Creating app icon from toolbar icon...');
    
    // Generate all required sizes
    for (const { size, name } of sizes) {
        const outputPath = path.join(iconsetDir, name);
        await sharp(sourceIcon)
            .resize(size, size, {
                kernel: sharp.kernel.nearest, // Keep sharp edges for pixel art
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toFile(outputPath);
        console.log(`  ✓ Created ${name}`);
    }
    
    // Convert iconset to icns using iconutil
    console.log('\nConverting to .icns...');
    const icnsPath = path.join(assetsDir, 'icon.icns');
    
    try {
        execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, {
            stdio: 'inherit'
        });
        console.log(`  ✓ Created icon.icns`);
        
        // Clean up iconset directory
        execSync(`rm -rf "${iconsetDir}"`);
        console.log('  ✓ Cleaned up temporary files');
        
        console.log('\n✅ App icon created successfully!');
        console.log('Rebuild the app to see the new icon.');
    } catch (error) {
        console.error('Error creating .icns file:', error.message);
        process.exit(1);
    }
}

createIcons().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
