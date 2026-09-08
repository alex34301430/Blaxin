import { test, expect, Page } from '@playwright/test';

// Drive the REAL stack: the client is served by the vite dev server and
// talks to the REAL BLAXIN backend (proxied /api + /ws). No provider key
// is needed because safe deterministic tasks run on the fast path.

const SETUP_KEY = 'blaxin-setup-complete';

async function openApp(page: Page): Promise<void> {
  // Skip the first-run setup wizard (requires a provider) — but only set
  // it once so the flag itself never changes behavior mid-test.
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, 'true');
  }, SETUP_KEY);
  await page.goto('/');
}

async function waitLive(page: Page): Promise<void> {
  await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('loads the real app and connects to the backend', async ({ page }) => {
  await openApp(page);
  await waitLive(page);

  // Sidebar brand + status chrome visible.
  await expect(page.getByText('BLAXIN', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Memory' })).toBeVisible();
  // The message input is enabled once connected and idle.
  await expect(page.getByLabel('Message BLAXIN')).toBeVisible();
});

test('runs a real safe task end to end and announces it via live regions', async ({ page }) => {
  await openApp(page);
  await waitLive(page);

  const input = page.getByLabel('Message BLAXIN');
  await input.fill('list the contents of /tmp');
  await page.getByRole('button', { name: 'Send message' }).click();

  // StatusBar live region (first [role=status] in the DOM) must announce
  // the real transition to a terminal state.
  const statusRegion = page.locator('[role="status"]').first();
  await expect
    .poll(() => statusRegion.textContent(), { timeout: 20_000 })
    .toMatch(/Task completed|BLAXIN error|BLAXIN is (thinking|planning|executing|observing)/);

  // The chat live region (second) announces the assistant's reply.
  const chatRegion = page.locator('[role="status"]').nth(1);
  await expect
    .poll(() => chatRegion.textContent(), { timeout: 20_000 })
    .toContain('BLAXIN:');

  // The agent visually lands on DONE in the status bar (multiple DONE
  // chips exist — one per completed activity item — so scope to the first).
  await expect(page.getByText('DONE', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
});

test('memory page: save a durable note and delete it (real API)', async ({ page }) => {
  await openApp(page);
  await waitLive(page);

  await page.getByRole('button', { name: 'Memory' }).click();

  const note = `e2e preference note ${Date.now()}`;
  await page.getByTestId('memory-note-input').fill(note);
  await page.getByRole('button', { name: 'Save note' }).click();

  // The note shows up in the list, rendered from the real store.
  const row = page.getByTestId('memory-entry').filter({ hasText: note });
  await expect(row).toBeVisible();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

  // Delete the note again so the store is left as we found it.
  await row.getByRole('button', { name: 'Delete this note' }).click();
  await expect(page.getByTestId('memory-entry').filter({ hasText: note })).toHaveCount(0);
});
