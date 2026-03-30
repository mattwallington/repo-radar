const sharp = require('sharp');

async function createSpinningFrames() {
  const size = 22;
  const numFrames = 32;
  
  // Create 32 frames of rotation for ultra-smooth animation
  for (let i = 0; i < numFrames; i++) {
    const angle = (i * 360) / numFrames;
    
    // SVG with rotation transform
    const syncIconSVG = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <g transform="rotate(${angle} 11 11)">
          <circle cx="11" cy="11" r="8" fill="none" stroke="rgb(255,200,0)" stroke-width="2"/>
          <path d="M 11 3 L 8 6 L 14 6 Z" fill="rgb(255,200,0)"/>
          <path d="M 11 19 L 8 16 L 14 16 Z" fill="rgb(255,200,0)"/>
        </g>
      </svg>
    `;
    
    await sharp(Buffer.from(syncIconSVG))
      .png()
      .toFile(`icon-syncing-${i}.png`);
  }
  
  console.log(`✓ Created ${numFrames} animation frames`);
}

createSpinningFrames().catch(err => {
  console.error('Error creating animation frames:', err);
  process.exit(1);
});

