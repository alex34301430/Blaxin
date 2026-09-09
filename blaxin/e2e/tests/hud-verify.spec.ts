import { test, expect } from '@playwright/test';
test('HUD structure + real data', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('blaxin-setup-complete', 'true'); });
  await page.goto('/');
  await expect(page.getByTestId('boot-overlay')).toBeVisible();
  // Boot leaves when the real backend connects + snapshots arrive
  await expect(page.getByTestId('boot-overlay')).toHaveCount(0, { timeout: 15000 });
  // HUD header identity (scoped to main — the sidebar also says BLAXIN)
  const hud = page.locator('main');
  await expect(hud.locator('.jh-status-pill')).toContainText('ONLINE');
  // Panels
  await expect(hud.getByText('NEURAL_STATUS')).toBeVisible();
  await expect(hud.getByText('MEMORY_BANK')).toBeVisible();
  await expect(hud.getByText('TASK_QUEUE')).toBeVisible();
  await expect(hud.getByText('AGENT_TERMINAL')).toBeVisible();
  await expect(hud.getByText('NETWORK_HUB')).toBeVisible();
  await expect(hud.getByText('SECURITY_VAULT')).toBeVisible();
  await expect(page.getByTestId('activity-ticker')).toBeVisible();
  // Device id is real (BLX-…)
  await expect(page.locator('.jh-header-stat', { hasText: 'ID:' })).toContainText('BLX-');
  // Network stats come from real telemetry (numeric rate present)
  await expect(hud.getByText('NETWORK_HUB').locator('../..')).toContainText('RX:');
  // Run a real slash-command via composer → deterministic router reply
  const input = page.getByLabel('Message BLAXIN');
  await input.fill('/status');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[role="status"]').nth(1)).toContainText('BLAXIN:', { timeout: 10000 });
  await expect(page.locator('.jh-terminal-body')).toContainText('AGENT STATE', { timeout: 10000 });
  console.log('HUD VERIFY: PASS');
});
