#!/usr/bin/env node

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const assetsDir = __dirname;
const outputIcon = path.join(assetsDir, 'icon.png');

// Brand purple color
const purpleColor = { r: 102, g: 45, b: 145 };

async function createHighResIcon() {
    console.log('Creating high-resolution app icon...');
    
    const size = 1024; // High resolution base
    const iconSize = Math.floor(size * 0.70); // Icon takes 70% of canvas
    const strokeWidth = Math.floor(size * 0.08); // 8% stroke width
    const arrowSize = Math.floor(size * 0.12); // Arrow size
    const innerRadius = (iconSize - strokeWidth) / 2;
    const outerRadius = iconSize / 2;
    const center = size / 2;
    
    // Create SVG with high-quality sync icon
    const svg = `
        <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="purpleGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:rgb(${purpleColor.r + 20},${purpleColor.g + 20},${purpleColor.b + 20});stop-opacity:1" />
                    <stop offset="100%" style="stop-color:rgb(${purpleColor.r},${purpleColor.g},${purpleColor.b});stop-opacity:1" />
                </linearGradient>
            </defs>
            
            <!-- Rounded square background -->
            <rect x="0" y="0" width="${size}" height="${size}" 
                  rx="${Math.floor(size * 0.225)}" 
                  ry="${Math.floor(size * 0.225)}" 
                  fill="url(#purpleGrad)"/>
            
            <!-- White sync circle -->
            <g transform="translate(${center}, ${center})">
                <!-- Main circle ring -->
                <circle cx="0" cy="0" r="${outerRadius}" 
                        fill="none" 
                        stroke="white" 
                        stroke-width="${strokeWidth}"
                        stroke-linecap="round"
                        stroke-dasharray="${Math.PI * outerRadius * 1.5} ${Math.PI * outerRadius * 0.5}"
                        transform="rotate(-45)"/>
                
                <!-- Bottom right arrow pointing down-right (clockwise) -->
                <g transform="rotate(90)">
                    <path d="M ${outerRadius - strokeWidth/2} ${-arrowSize}
                             L ${outerRadius + arrowSize} 0
                             L ${outerRadius - strokeWidth/2} ${arrowSize}"
                          fill="none"
                          stroke="white"
                          stroke-width="${strokeWidth}"
                          stroke-linecap="round"
                          stroke-linejoin="round"/>
                </g>
                
                <!-- Top left arrow pointing up-left (clockwise continuation) -->
                <g transform="rotate(-90)">
                    <path d="M ${-outerRadius + strokeWidth/2} ${-arrowSize}
                             L ${-outerRadius - arrowSize} 0
                             L ${-outerRadius + strokeWidth/2} ${arrowSize}"
                          fill="none"
                          stroke="white"
                          stroke-width="${strokeWidth}"
                          stroke-linecap="round"
                          stroke-linejoin="round"/>
                </g>
            </g>
        </svg>
    `;
    
    // Convert SVG to PNG
    await sharp(Buffer.from(svg))
        .png()
        .toFile(outputIcon);
    
    console.log(`✓ Created high-resolution icon: ${outputIcon}`);
    console.log(`  Resolution: ${size}x${size}px`);
    console.log('  No more graininess! 🎨');
}

createHighResIcon().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
