import { expect, test } from '@playwright/test'

test.describe('smoke', () => {
	test('главная страница загружается', async ({ page }) => {
		const res = await page.goto('/')
		expect(res?.ok()).toBeTruthy()
		await expect(page.locator('body')).toBeVisible()
	})
})
