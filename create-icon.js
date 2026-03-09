/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Icon generator — creates a speed-gauge PNG for the app.
 * @author       Cloud Nimbus LLC
 */

const fs = require('fs');

// Minimal 32x32 PNG with a speed gauge icon (blue circle with arrow)
// This is a valid minimal PNG - just a solid blue square as placeholder
// For a real icon, replace icon.png with a proper design

const { createCanvas } = (() => {
  try {
    return require('canvas');
  } catch {
    return { createCanvas: null };
  }
})();

if (createCanvas) {
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.beginPath();
  ctx.arc(128, 128, 120, 0, Math.PI * 2);
  ctx.fillStyle = '#2255cc';
  ctx.fill();

  // Speed gauge arc
  ctx.beginPath();
  ctx.arc(128, 128, 90, Math.PI * 0.8, Math.PI * 2.2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Needle
  ctx.beginPath();
  ctx.moveTo(128, 128);
  const angle = Math.PI * 1.3;
  ctx.lineTo(128 + Math.cos(angle) * 70, 128 + Math.sin(angle) * 70);
  ctx.strokeStyle = '#ff6644';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(128, 128, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  fs.writeFileSync('icon.png', canvas.toBuffer('image/png'));
  console.log('Icon created!');
} else {
  // Fallback: create a minimal valid 1x1 PNG that Electron can load
  // Then the user can replace it with a real icon
  const minimalPng = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, // 16x16
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x91, 0x68, 0x36, // 8-bit RGB
    0x00, 0x00, 0x00, 0x3B, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
    0x78, 0x9C, 0x62, 0x60, 0x40, 0x06, 0x8C, 0x8C, // zlib compressed
    0x0C, 0x0C, 0xFF, 0xFF, 0x63, 0x20, 0x0E, 0x30,
    0x32, 0x32, 0x30, 0xFC, 0x07, 0x01, 0x46, 0x46,
    0x06, 0x86, 0xFF, 0x40, 0x06, 0x23, 0x23, 0x03,
    0xC3, 0x7F, 0x20, 0x83, 0x91, 0x91, 0x81, 0xE1,
    0x3F, 0x90, 0xC1, 0xC8, 0xC8, 0xC0, 0xF0, 0x1F,
    0xC8, 0x60, 0x64, 0x64, 0x60, 0xF8, 0x0F, 0x00,
    0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x34, 0xF2,
    0x0C, 0x45,
    0x71, 0xAB, 0x2C, 0xE5, // CRC
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
    0xAE, 0x42, 0x60, 0x82,
  ]);
  fs.writeFileSync('icon.png', minimalPng);
  console.log('Minimal icon.png created (placeholder - replace with a real icon)');
}
