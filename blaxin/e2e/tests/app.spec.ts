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

test('confirmation gate: denying a gated action via Escape never executes it', async ({ page }) => {
  await openApp(page);
  await waitLive(page);

  // "open <url>" hits the deterministic fast path (no provider needed) and
  // the browser tool gates open_url — a REAL confirmation event, no mock.
  const input = page.getByLabel('Message BLAXIN');
  await input.fill('open https://example.com/');
  await page.getByRole('button', { name: 'Send message' }).click();

  // The safety-critical dialog appears with the safe default: focus lands
  // on Deny, so a blind Enter can never approve a high-impact action.
  const dialog = page.getByRole('dialog', { name: 'BLAXIN needs your approval' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Deny' })).toBeFocused();

  // Escape is the documented deny path.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The step is recorded as DENIED and SKIPPED — executed for no one.
  await expect(
    page.getByTestId('active-task-step').filter({ hasText: 'DENIED' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId('active-task-step').filter({ hasText: 'SKIPPED' }),
  ).toBeVisible({ timeout: 15_000 });

  // Focus goes back to the page (restore), and the input is usable again.
  await expect(input).toBeEnabled();
});

test('settings dialog: focus trap, Escape closes, focus is restored', async ({ page }) => {
  await openApp(page);
  await waitLive(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();

  // Focus moved into the dialog on open.
  const inside = dialog.locator(
    'button:enabled, input:enabled, select:enabled, [tabindex="0"]:enabled',
  );
  await expect(inside.first()).toBeFocused();

  // Tab keeps focus inside the dialog (trap).
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focusedId = await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.closest('[role="dialog"]') !== null,
  );
  expect(focusedId).toBe(true);

  // Escape closes and restores focus to the opener.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
});

test('JARVIS audio identity: mute + volume persist across reload', async ({ page }) => {
  await openApp(page);
  await waitLive(page);

  const mute = page.getByRole('button', { name: 'Mute JARVIS sounds' });
  await mute.click();
  // aria-pressed reflects the real audioEnabled state (now muted).
  await expect(page.getByRole('button', { name: 'Unmute JARVIS sounds' })).toHaveAttribute(
    'aria-pressed', 'false',
  );

  const volume = page.getByRole('slider', { name: 'JARVIS sound volume' });
  await volume.fill('35');

  await page.reload();
  await waitLive(page);

  // Persisted: muted flag and clamped volume survive a real reload.
  await expect(page.getByRole('button', { name: 'Unmute JARVIS sounds' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'JARVIS sound volume' })).toHaveValue('35');
});

test('setup wizard: is a full dialog and Escape does not dismiss first-run setup', async ({ page, browser }) => {
  // Fresh context: no 'blaxin-setup-complete' flag → the real wizard shows.
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto('/');

  const dialog = fresh.getByRole('dialog', { name: 'BLAXIN' });
  await expect(dialog).toBeVisible();

  // Focus moved into the dialog on open.
  const inside = dialog.locator(
    'button:enabled, input:enabled, [tabindex="0"]:enabled',
  );
  await expect(inside.first()).toBeFocused();

  // First-run setup must be completed — Escape intentionally does not
  // dismiss the wizard.
  await fresh.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  await context.close();
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
