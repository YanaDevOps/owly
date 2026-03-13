import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const fakeMediaArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

export default defineConfig({
  testDir: './test/smoke',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:19110',
    browserName: 'chromium',
    channel: 'msedge',
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: fakeMediaArgs,
    },
  },
  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1366, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        channel: 'msedge',
        permissions: ['camera', 'microphone'],
        launchOptions: {
          args: fakeMediaArgs,
        },
      },
    },
  ],
  webServer: {
    command: 'go run . -insecure -http 127.0.0.1:19110 -static ./static -groups ./testdata/smoke/groups -data ./testdata/smoke/data',
    cwd: rootDir,
    port: 19110,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      GOCACHE: path.join(rootDir, 'tmp-gocache'),
      GOMODCACHE: path.join(rootDir, 'tmp-gomodcache'),
    },
  },
});
