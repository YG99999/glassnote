import { chromium } from 'playwright';

// Set GLASSNOTE_BROWSER_CHANNEL=msedge to use an installed Edge instead.
export function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(process.env.GLASSNOTE_BROWSER_CHANNEL ? { channel: process.env.GLASSNOTE_BROWSER_CHANNEL } : {}),
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
}
