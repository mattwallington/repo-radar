#!/usr/bin/env node

const sharp = require('sharp');
const path = require('path');

const assetsDir = __dirname;
const outputIcon = path.join(assetsDir, 'icon-purple.png');

// Brand purple color
const purpleColor = { r: 102, g: 45, b: 145, alpha: 1 }; // #662D91

async function createPurpleIcon() {
    console.log('Creating purple background icon with full loop and round dots...');
    
    // Create a high-resolution icon (512x512)
    const size = 512;
    const radius = Math.floor(size * 0.225); // 22.5% radius for rounded corners
    
    // Scale factor from the original 22px design
    const scale = size / 22;
    const center = size / 2; // 256
    const loopRadius = 8 * scale; // ~184
    const strokeWidth = 2 * scale; // ~46
    const dotRadius = 2.5 * scale; // ~58
    
    // Create complete SVG with purple rounded background and white loop with dots
    const completeSVG = `
        <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="purpleGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:rgb(${purpleColor.r + 20},${purpleColor.g + 20},${purpleColor.b + 20});stop-opacity:1" />
                    <stop offset="100%" style="stop-color:rgb(${purpleColor.r},${purpleColor.g},${purpleColor.b});stop-opacity:1" />
                </linearGradient>
            </defs>
            
            <!-- Purple rounded square background -->
            <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#purpleGrad)"/>
            
            <!-- White complete circular loop -->
            <circle cx="${center}" cy="${center}" r="${loopRadius}" fill="none" stroke="white" stroke-width="${strokeWidth}"/>
            
            <!-- Top round dot -->
            <circle cx="${center}" cy="${center - loopRadius}" r="${dotRadius}" fill="white"/>
            
            <!-- Bottom round dot -->
            <circle cx="${center}" cy="${center + loopRadius}" r="${dotRadius}" fill="white"/>
        </svg>
    `;
    
    // Render the complete SVG
    await sharp(Buffer.from(completeSVG))
        .png()
        .toFile(outputIcon);
    
    console.log(`✓ Created purple icon: ${outputIcon}`);
    console.log(`  Size: ${size}x${size}`);
    console.log(`  Color: rgb(${purpleColor.r}, ${purpleColor.g}, ${purpleColor.b})`);
    console.log(`  Icon: Full circular loop with round dots at top and bottom`);
}

createPurpleIcon().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
