import { promises as fs } from 'fs'
import path from 'path'

type VerifyResp = {
	success?: boolean
	token?: string
	message?: string
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: JSON.stringify(body),
	})
	const data = (await res.json().catch(() => ({}))) as any
	return { res, data }
}

export default async function globalSetup() {
	const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3001'
	const phone = process.env.E2E_PHONE
	const e2eSecret = process.env.E2E_DEV_CODE_SECRET
	const outFile = process.env.PW_STORAGE_STATE_PATH ?? path.join(__dirname, 'storageState.json')

	// Если переменные не заданы — просто создаём пустой storageState.
	// Тест в таком случае сам пропустится (см. e2e/timing-hub.spec.ts).
	if (!phone || !e2eSecret) {
		await fs.writeFile(outFile, JSON.stringify({ cookies: [], origins: [] }, null, 2), 'utf8')
		return
	}

	const u = new URL(baseURL)
	// 1) генерим OTP
	{
		const { res, data } = await postJson(`${baseURL}/api/auth/send-code`, { phone })
		if (!res.ok || !data?.success) {
			throw new Error(`send-code failed: status=${res.status}, message=${String(data?.message ?? '')}`)
		}
	}

	// 2) забираем OTP-код через dev-эндпоинт
	const { res: codeRes, data: codeData } = await postJson(`${baseURL}/api/auth/dev-get-otp-code`, { phone }, { 'x-e2e-secret': e2eSecret })
	if (!codeRes.ok || !codeData?.success || !codeData?.code) {
		throw new Error(`dev-get-otp-code failed: status=${codeRes.status}, message=${String(codeData?.message ?? '')}`)
	}
	const code = String(codeData.code)

	// 3) verify-code -> токен
	const { res: verifyRes, data: verifyData } = await postJson(`${baseURL}/api/auth/verify-code`, {
		phone,
		code,
		// если пользователя нет — verifyCode создаст его, если профиль содержит хотя бы одно из полей:
		// full_name / gender / telegram / birthday
		full_name: 'E2E Test User',
		telegram: '@e2e-test',
	})
	const verifyResp = verifyData as VerifyResp
	if (!verifyRes.ok || !verifyResp?.success || !verifyResp?.token) {
		throw new Error(`verify-code failed: status=${verifyRes.status}, message=${String(verifyResp?.message ?? '')}`)
	}
	const token = String(verifyResp.token)

	const state = {
		cookies: [
			{
				name: 'token',
				value: token,
				domain: u.hostname,
				path: '/',
				httpOnly: false,
				secure: u.protocol === 'https:',
				sameSite: 'lax',
			},
		],
		origins: [],
	}

	await fs.writeFile(outFile, JSON.stringify(state, null, 2), 'utf8')
}

