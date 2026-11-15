import { type Page } from '@playwright/test';

export async function acceptAppConfirmations(page: Page) {
  await page.addLocatorHandler(page.getByRole('dialog'), async (dialog) => {
    await dialog.getByRole('button').last().click();
  });
}
