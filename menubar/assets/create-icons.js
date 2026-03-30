const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function createIcons() {
  const size = 22;
  const center = 11;
  const loopRadius = 8;
  const dotRadius = 2.5;
  
  // White icon (idle) - complete circular loop with round dots
  const whiteIconSVG = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <!-- Complete circular loop -->
      <circle cx="${center}" cy="${center}" r="${loopRadius}" fill="none" stroke="white" stroke-width="2"/>
      <!-- Top dot -->
      <circle cx="${center}" cy="${center - loopRadius}" r="${dotRadius}" fill="white"/>
      <!-- Bottom dot -->
      <circle cx="${center}" cy="${center + loopRadius}" r="${dotRadius}" fill="white"/>
    </svg>
  `;
  
  await sharp(Buffer.from(whiteIconSVG))
    .png()
    .toFile('icon.png');
  
  // Yellow icon (syncing) - complete circular loop with round dots
  const yellowIconSVG = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <!-- Complete circular loop -->
      <circle cx="${center}" cy="${center}" r="${loopRadius}" fill="none" stroke="rgb(255,200,0)" stroke-width="2"/>
      <!-- Top dot -->
      <circle cx="${center}" cy="${center - loopRadius}" r="${dotRadius}" fill="rgb(255,200,0)"/>
      <!-- Bottom dot -->
      <circle cx="${center}" cy="${center + loopRadius}" r="${dotRadius}" fill="rgb(255,200,0)"/>
    </svg>
  `;
  
  await sharp(Buffer.from(yellowIconSVG))
    .png()
    .toFile('icon-syncing.png');
  
  // Red icon (error) - complete circular loop with round dots
  const redIconSVG = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <!-- Complete circular loop -->
      <circle cx="${center}" cy="${center}" r="${loopRadius}" fill="none" stroke="rgb(244,67,54)" stroke-width="2"/>
      <!-- Top dot -->
      <circle cx="${center}" cy="${center - loopRadius}" r="${dotRadius}" fill="rgb(244,67,54)"/>
      <!-- Bottom dot -->
      <circle cx="${center}" cy="${center + loopRadius}" r="${dotRadius}" fill="rgb(244,67,54)"/>
    </svg>
  `;
  
  await sharp(Buffer.from(redIconSVG))
    .png()
    .toFile('icon-error.png');
  
  // Green icon (success) - complete circular loop with round dots
  const greenIconSVG = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <!-- Complete circular loop -->
      <circle cx="${center}" cy="${center}" r="${loopRadius}" fill="none" stroke="rgb(13,188,121)" stroke-width="2"/>
      <!-- Top dot -->
      <circle cx="${center}" cy="${center - loopRadius}" r="${dotRadius}" fill="rgb(13,188,121)"/>
      <!-- Bottom dot -->
      <circle cx="${center}" cy="${center + loopRadius}" r="${dotRadius}" fill="rgb(13,188,121)"/>
    </svg>
  `;
  
  await sharp(Buffer.from(greenIconSVG))
    .png()
    .toFile('icon-success.png');
  
  console.log('✓ Icons created successfully!');
  console.log('  - icon.png (white - idle) - Full loop with round dots');
  console.log('  - icon-syncing.png (yellow - syncing) - Full loop with round dots');
  console.log('  - icon-success.png (green - success) - Full loop with round dots');
  console.log('  - icon-error.png (red - error) - Full loop with round dots');
}

createIcons().catch(err => {
  console.error('Error creating icons:', err);
  process.exit(1);
});
