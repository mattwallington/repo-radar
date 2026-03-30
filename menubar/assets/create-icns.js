#!/usr/bin/env node

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function createIconSet() {
    console.log('Creating .icns file for Application icon...');
    
    const assetsDir = __dirname;
    const purpleIcon = path.join(assetsDir, 'icon-purple.png');
    const iconsetDir = path.join(assetsDir, 'icon.iconset');
    
    // Check if icon-purple.png exists, if not create it
    if (!fs.existsSync(purpleIcon)) {
        console.log('icon-purple.png not found, creating it...');
        await execAsync(`cd "${assetsDir}" && node create-purple-icon.js`);
    }
    
    // Create iconset directory
    if (!fs.existsSync(iconsetDir)) {
        fs.mkdirSync(iconsetDir);
    }
    
    // Required icon sizes for macOS
    const sizes = [
        { size: 16, name: 'icon_16x16' },
        { size: 32, name: 'icon_16x16@2x' },
        { size: 32, name: 'icon_32x32' },
        { size: 64, name: 'icon_32x32@2x' },
        { size: 128, name: 'icon_128x128' },
        { size: 256, name: 'icon_128x128@2x' },
        { size: 256, name: 'icon_256x256' },
        { size: 512, name: 'icon_256x256@2x' },
        { size: 512, name: 'icon_512x512' },
        { size: 1024, name: 'icon_512x512@2x' }
    ];
    
    // Generate each size
    for (const { size, name } of sizes) {
        await sharp(purpleIcon)
            .resize(size, size, {
                kernel: sharp.kernel.lanczos3,
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toFile(path.join(iconsetDir, `${name}.png`));
        console.log(`  ✓ ${name}.png (${size}x${size})`);
    }
    
    // Convert iconset to icns using macOS iconutil
    console.log('\nConverting to .icns format...');
    try {
        await execAsync(`iconutil -c icns "${iconsetDir}" -o "${path.join(assetsDir, 'icon.icns')}"`);
        console.log('✓ Created icon.icns');
        
        // Clean up iconset directory
        await execAsync(`rm -rf "${iconsetDir}"`);
        console.log('✓ Cleaned up temporary files');
    } catch (err) {
        console.error('Error creating .icns:', err.message);
        process.exit(1);
    }
}

createIconSet().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
