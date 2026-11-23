import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 5198;
const baseURL = 'http://127.0.0.1:' + port;
const localChrome = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const dataDirectory = mkdtempSync(join(tmpdir(), 'groovebox-e2e-'));
process.once('exit', () => rmSync(dataDirectory, { recursive: true, force: true }));

export default defineConfig({
  testDir: './test',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    // Keep provider mocks deterministic. The offline-shell spec explicitly enables workers.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'desktop',
      grepInvert: /@mobile/,
      use: { ...(localChrome ? { channel: 'chrome' } : {}), viewport: { width: 1440, height: 900 } },
    },
    ...(process.env.PLAYWRIGHT_WEBKIT === '1' ? [{
      name: 'webkit',
      grepInvert: /@mobile/,
      use: { browserName: 'webkit', viewport: { width: 1440, height: 900 } },
    }] : []),
    ...(process.env.PLAYWRIGHT_FIREFOX === '1' ? [{
      name: 'firefox',
      grepInvert: /@mobile/,
      use: { browserName: 'firefox', viewport: { width: 1440, height: 900 } },
    }, {
      name: 'firefox-mobile',
      grep: /@mobile/,
      use: { browserName: 'firefox', viewport: { width: 412, height: 915 }, hasTouch: true },
    }] : []),
    {
      name: 'mobile',
      grep: /@mobile/,
      use: { ...devices['Pixel 7'], ...(localChrome ? { channel: 'chrome' } : {}) },
    },
  ],
  webServer: {
    command: 'npm start',
    url: baseURL,
    env: {
      GROOVEBOX_DATA_DIR: dataDirectory,
      HOST: '127.0.0.1',
      PORT: String(port),
      BAIDU_CLIENT_ID: '',
      BAIDU_CLIENT_SECRET: '',
      BAIDU_REDIRECT_URI: '',
    },
  },
});
