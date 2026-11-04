#!/usr/bin/env node

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const publicDir = path.join(__dirname, '..', 'public');
const iconPath = path.join(publicDir, 'icon-192x192.png');

const BG_COLOR = { r: 26, g: 26, b: 46, alpha: 1 }; // #1a1a2e
const ICON_SIZE = 120;

const sizes = [
  { width: 2048, height: 2732, name: 'splash-2048x2732.png' },
  { width: 1668, height: 2388, name: 'splash-1668x2388.png' },
  { width: 1536, height: 2048, name: 'splash-1536x2048.png' },
  { width: 1125, height: 2436, name: 'splash-1125x2436.png' },
  { width: 1242, height: 2688, name: 'splash-1242x2688.png' },
  { width: 828,  height: 1792, name: 'splash-828x1792.png'  },
  { width: 750,  height: 1334, name: 'splash-750x1334.png'  },
  { width: 640,  height: 1136, name: 'splash-640x1136.png'  },
];

async function generateSplash({ width, height, name }) {
  const outputPath = path.join(publicDir, name);

  // Resize icon to 120x120
  const iconBuffer = await sharp(iconPath)
    .resize(ICON_SIZE, ICON_SIZE)
    .toBuffer();

  // Calculate center position
  const left = Math.floor((width - ICON_SIZE) / 2);
  const top = Math.floor((height - ICON_SIZE) / 2);

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: BG_COLOR,
    },
  })
    .composite([
      {
        input: iconBuffer,
        left,
        top,
      },
    ])
    .png()
    .toFile(outputPath);

  console.log(`✅ Generated ${name} (${width}x${height})`);
}

async function main() {
  console.log('Generating iOS splash screens...\n');

  for (const size of sizes) {
    await generateSplash(size);
  }

  console.log('\n✨ All splash screens generated successfully!');
}

main().catch((err) => {
  console.error('Error generating splash screens:', err);
  process.exit(1);
});
