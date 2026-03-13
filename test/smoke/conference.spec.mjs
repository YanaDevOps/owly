import { test, expect } from '@playwright/test';

async function joinRoom(page, username) {
  await page.goto('/group/smoke/');
  await expect(page.locator('#loginform')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#connectbutton').click();
  await expect(page.locator('#profile')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#video-container')).toBeVisible({ timeout: 20_000 });
}

test('two participants join the same room and both appear in participants', async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Multi-user smoke is covered on desktop only.');

  const aliceContext = await browser.newContext({
    baseURL,
    permissions: ['camera', 'microphone'],
  });
  const bobContext = await browser.newContext({
    baseURL,
    permissions: ['camera', 'microphone'],
  });

  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  try {
    await joinRoom(alice, 'Alice');
    await joinRoom(bob, 'Bob');

    await alice.locator('#participants-toggle').click();
    await bob.locator('#participants-toggle').click();

    await expect(alice.locator('#participants-count')).toHaveText(/2/);
    await expect(bob.locator('#participants-count')).toHaveText(/2/);
    await expect(alice.locator('#users')).toContainText('Bob');
    await expect(bob.locator('#users')).toContainText('Alice');
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test('mobile project can load the room shell and expose grouped header controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile-specific smoke only.');

  const workerRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('background-blur-worker.js')) {
      workerRequests.push(request.url());
    }
  });

  await joinRoom(page, 'MobileUser');

  await expect(page.locator('#chatbutton')).toBeVisible();
  await expect(page.locator('#workspace-toggle-mobile')).toBeVisible();
  await expect(page.locator('#disconnectbutton')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/reduced-chrome-effects/);
  await expect.poll(() => workerRequests.length).toBe(0);
});
