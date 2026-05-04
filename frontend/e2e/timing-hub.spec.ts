import { expect, test } from '@playwright/test'

const hasAuthEnv = Boolean(process.env.E2E_PHONE && process.env.E2E_DEV_CODE_SECRET)

test.skip(!hasAuthEnv, 'Нужны env E2E_PHONE и E2E_DEV_CODE_SECRET для автологина в E2E')

test('Timing Hub: drawer opens and period mode toggles', async ({ page }) => {
	await page.goto('/dashboard/campaigns')

	// Открываем панель планирования из шапки.
	await page.getByRole('button', { name: /Планирование/i }).click()
	await expect(page.getByTestId('timing-hub-drawer')).toBeVisible()

	// По умолчанию "По дням (1–30)".
	const periodLabel = page.getByTestId('timing-hub-period-days-label')
	await expect(periodLabel).toBeVisible()
	await expect(periodLabel).toContainText('Выбрано:')

	// Переключаемся на "Свой диапазон дат" и проверяем, что появился DatePicker.RangePicker.
	const byText = page.getByText('Свой диапазон дат')
	await byText.click()

	await expect(page.locator('.ant-picker-range')).toBeVisible()

	// Возвращаемся обратно на "По дням (1–30)" и проверяем, что Slider снова виден.
	await page.getByText('По дням (1–30)').click()
	await expect(page.getByTestId('timing-hub-period-days-slider')).toBeVisible()
})
