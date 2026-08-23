#!/usr/bin/env node
// Generate application and cross-platform tray icons. electron-builder picks
// these up from build/ for the packaged app.
//
// Skip-if-exists: a hand-crafted build/icon.png|ico is preserved on rerun.
// Delete the file you want regenerated to refresh it.

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC_SVG = path.join(ROOT, 'src', 'client', 'public', 'logo-icon.svg');
const OUT_DIR = path.join(ROOT, 'build');
const OUT_PNG = path.join(OUT_DIR, 'icon.png');
const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
const TRAY_SVG = path.join(OUT_DIR, 'tray-icon.svg');
const TRAY_TEMPLATE = path.join(OUT_DIR, 'trayTemplate.png');
const TRAY_TEMPLATE_2X = path.join(OUT_DIR, 'trayTemplate@2x.png');
const TRAY_LINUX = path.join(OUT_DIR, 'tray-linux.png');

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(SRC_SVG)) {
    console.error(`Icon source not found: ${SRC_SVG}`);
    process.exit(1);
  }
  if (!fs.existsSync(TRAY_SVG)) {
    console.error(`Tray icon source not found: ${TRAY_SVG}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const svgBuf = fs.readFileSync(SRC_SVG);

  if (fs.existsSync(OUT_PNG)) {
    console.log(`  build/icon.png exists — skipping (delete to regenerate)`);
  } else {
    await sharp(svgBuf, { density: 384 })
      .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(OUT_PNG);
    console.log(`  Wrote build/icon.png (1024x1024)`);
  }

  if (fs.existsSync(OUT_ICO)) {
    console.log(`  build/icon.ico exists — skipping (delete to regenerate)`);
  } else {
    const { default: pngToIco } = await import('png-to-ico');
    const sourceBuf = fs.existsSync(OUT_PNG) ? fs.readFileSync(OUT_PNG) : svgBuf;
    const isPngSource = fs.existsSync(OUT_PNG);
    const buffers = await Promise.all(
      ICO_SIZES.map((size) =>
        sharp(sourceBuf, isPngSource ? {} : { density: Math.max(96, size * 4) })
          .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer()
      )
    );
    const ico = await pngToIco(buffers);
    fs.writeFileSync(OUT_ICO, ico);
    console.log(`  Wrote build/icon.ico (${ICO_SIZES.join('/')})`);
  }

  const traySvgBuf = fs.readFileSync(TRAY_SVG);
  for (const [target, size] of [[TRAY_TEMPLATE, 16], [TRAY_TEMPLATE_2X, 32]]) {
    if (fs.existsSync(target)) {
      console.log(`  ${path.relative(ROOT, target)} exists — skipping (delete to regenerate)`);
      continue;
    }
    await sharp(traySvgBuf, { density: size * 8 })
      .resize(size, size)
      .withMetadata({ density: size === 16 ? 72 : 144 })
      .png()
      .toFile(target);
    console.log(`  Wrote ${path.relative(ROOT, target)} (${size}x${size})`);
  }

  if (fs.existsSync(TRAY_LINUX)) {
    console.log(`  build/tray-linux.png exists — skipping (delete to regenerate)`);
  } else {
    const background = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="1" y="1" width="30" height="30" rx="7" fill="#1e1e1e"/></svg>'
    );
    const whiteMark = await sharp(traySvgBuf, { density: 256 })
      .resize(22, 22)
      .negate({ alpha: false })
      .png()
      .toBuffer();
    await sharp(background)
      .composite([{ input: whiteMark, left: 5, top: 5 }])
      .png()
      .toFile(TRAY_LINUX);
    console.log('  Wrote build/tray-linux.png (32x32)');
  }
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
