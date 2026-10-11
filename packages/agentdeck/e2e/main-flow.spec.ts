import { expect, type Page, test } from '@playwright/test';

const pairingId = process.env.E2E_PAIRING_ID || '';
// Relative to the directory the cwd picker opens in; the review host keeps its sample project here.
const cwd = (process.env.E2E_CWD || 'workspace/trip-planner').split('/');

test.skip(!pairingId, 'Set E2E_PAIRING_ID to run against a live host');

const sessionIdOf = (page: Page) =>
  page.locator('agentdeck-session-page').evaluate((element) => (element as unknown as { sessionId: string }).sessionId);

// Wait for the pop animation to finish; taps during it are lost.
const backToList = async (page: Page) => {
  await page.getByRole('button', { name: 'Back to session list' }).click();
  await expect(page.locator('agentdeck-session-page')).toHaveCount(0);
};

const expectConnected = (page: Page) => expect(page.getByText('Remote connected')).toBeVisible({ timeout: 60_000 });

test('pair, create a session, chat, reload and delete', async ({ page }) => {
  // The reply must be the token alone, so the prompt (which also contains it) never matches.
  const token = `ADK_E2E_${Date.now().toString(36).toUpperCase()}`;
  const reply = page.getByText(new RegExp(`^\\W*${token}\\W*$`));
  let sessionId = '';

  await page.goto('/');

  await test.step('pair with the host', async () => {
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.getByLabel('Connect to Remote').fill(pairingId);
    await page.getByRole('button', { name: 'Save & Connect' }).click();
    await expectConnected(page);
  });

  try {
    await test.step('create a pending session in the project', async () => {
      await page.getByRole('button', { name: 'New Session' }).click();
      for (const name of cwd) {
        await page.getByRole('button', { name, exact: true }).click();
      }
      await page.getByRole('button', { name: 'Create session here' }).click();
      expect(await sessionIdOf(page)).toMatch(/^pending-/);
    });

    await test.step('first prompt creates the remote session and streams a reply', async () => {
      await page.getByLabel('Send message').fill(`Reply with exactly ${token} and nothing else. Do not use any tools.`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => sessionIdOf(page), { timeout: 60_000 }).not.toMatch(/^pending-/);
      sessionId = await sessionIdOf(page);
      await expect(reply).toBeVisible({ timeout: 3 * 60_000 });
      await expect(page.getByRole('button', { name: 'Stop generation' })).toBeHidden({ timeout: 60_000 });
    });

    await test.step('reopen from the list replays history', async () => {
      await backToList(page);
      await page.getByText(sessionId).tap();
      await expect(reply).toBeVisible({ timeout: 60_000 });
      await backToList(page);
    });

    await test.step('reload keeps the pairing and reconnects', async () => {
      await page.reload();
      await expectConnected(page);
      await page.getByText(sessionId).tap();
      await expect(reply).toBeVisible({ timeout: 60_000 });
      await backToList(page);
    });
  } finally {
    // Leave the shared review host as it was.
    if (sessionId) {
      await test.step('delete the session', async () => {
        const row = page.locator('tap-swipeout').filter({ hasText: sessionId });
        // The action stays hidden until swiped; clicking it directly is enough here.
        await row.locator('[slot=danger]').dispatchEvent('click');
        await expect(row).toHaveCount(0);
      });
    }
  }
});
