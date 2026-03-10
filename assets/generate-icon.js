#!/usr/bin/env node
/**
 * Generate app icons from SVG source
 * Creates: icon.png, icon.icns, icon.ico
 * Requires: sharp (npm install sharp)
 */

import sharp from 'sharp';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = join(__dirname, 'icon.svg');
const iconsetDir = join(__dirname, 'icon.iconset');

const sizes = [16, 32, 64, 128, 256, 512, 1024];

async function generate() {
  const svgBuffer = readFileSync(svgPath);

  // Create iconset directory
  if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true });
  mkdirSync(iconsetDir);

  // Generate PNGs for each size
  for (const size of sizes) {
    const filename = size === 1024
      ? `icon_512x512@2x.png`
      : `icon_${size}x${size}.png`;

    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(join(iconsetDir, filename));

    // Also generate @2x variants
    if (size <= 512 && size * 2 <= 1024) {
      await sharp(svgBuffer)
        .resize(size * 2, size * 2)
        .png()
        .toFile(join(iconsetDir, `icon_${size}x${size}@2x.png`));
    }

    console.log(`  Generated ${size}x${size}`);
  }

  // Generate standalone icon.png (512x512)
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(join(__dirname, 'icon.png'));
  console.log('  Generated icon.png (512x512)');

  // Generate large icon for preview (1024x1024)
  await sharp(svgBuffer)
    .resize(1024, 1024)
    .png()
    .toFile(join(__dirname, 'icon-1024.png'));
  console.log('  Generated icon-1024.png');

  // Convert to .icns using macOS iconutil
  try {
    execSync(`iconutil -c icns "${iconsetDir}" -o "${join(__dirname, 'icon.icns')}"`);
    console.log('  Generated icon.icns');
  } catch (e) {
    console.log('  Skipped .icns (iconutil not available or failed)');
  }

  // Clean up iconset directory
  rmSync(iconsetDir, { recursive: true });
  console.log('\n  Done! Icons generated in assets/');
}

generate().catch(console.error);
