#!/usr/bin/env node
// Export the canonical SVG icon to the raster sizes required by iOS/Safari.
// Uses the Playwright Chrome already needed by the project's E2E tests.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readFile(join(root, 'icons/app-icon.svg'), 'utf8');
const images = [
  ['app-icon-192.png', 192],
  ['app-icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  for (const [filename, size] of images) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!DOCTYPE html><html><head><style>
        html, body { margin: 0; background: #f4f0e7; }
        svg { display: block; width: ${size}px; height: ${size}px; }
      </style></head><body>${source}</body></html>`);
      await page.evaluate(() => document.fonts.ready);
      await page.locator('svg').screenshot({ path: join(root, 'icons', filename), animations: 'disabled' });
      console.log(`${filename}: ${size}×${size}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
