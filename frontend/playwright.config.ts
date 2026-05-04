import { defineConfig, devices } from '@playwright/test'

/**
 * E2E: `npm run test:e2e` (нужен dev-сервер на 3001 или PLAYWRIGHT_BASE_URL).
 * Первый раз: `npx playwright install chromium`
 */
export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: [['list']],
	globalSetup: './e2e/global-setup.ts',
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3001',
		storageState: process.env.PW_STORAGE_STATE_PATH ?? './e2e/storageState.json',
		trace: 'on-first-retry',
		...devices['Desktop Chrome'],
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
		? undefined
		: {
				command: 'npm run dev',
				url: 'http://127.0.0.1:3001',
				reuseExistingServer: true,
				timeout: 120_000,
			},
})
