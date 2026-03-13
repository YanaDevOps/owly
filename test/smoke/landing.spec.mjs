import { test, expect } from '@playwright/test';

test('landing page renders the join form hero', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#title')).toHaveText('Owly');
  await expect(page.locator('#group')).toBeVisible();
  await expect(page.locator('#submitbutton')).toBeVisible();
  await expect(page.locator('.home-subtitle')).toBeVisible();
});
