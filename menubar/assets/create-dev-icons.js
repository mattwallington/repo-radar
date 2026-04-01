const sharp = require('sharp');

// Create orange-tinted menubar icons for dev builds
async function createDevIcons() {
  const size = 22;
  const center = 11;
  const loopRadius = 8;
  const dotRadius = 2.5;
  const orange = 'rgb(255,140,0)';

  // Dev idle icon (orange instead of white)
  const idleSVG = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${center}" cy="${center}" r="${loopRadius}" fill="none" stroke="${orange}" stroke-width="2"/>
      <circle cx="${center}" cy="${center - loopRadius}" r="${dotRadius}" fill="${orange}"/>
      <circle cx="${center}" cy="${center + loopRadius}" r="${dotRadius}" fill="${orange}"/>
    </svg>
  `;

  await sharp(Buffer.from(idleSVG)).png().toFile('icon-dev.png');

  console.log('✓ Dev icons created');
  console.log('  - icon-dev.png (orange - dev idle)');
}

createDevIcons().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
