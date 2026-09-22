/**
 * 扫码登录接口 —— 轮询状态。**刻意不回传二维码图**：图是凭据等价物（可解码还原出 key，
 * 持有者能在扫码成功后领走凭据），状态变化时码本身也不变，没有理由让它被反复取回。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_COOKIE } from '$lib/server/admin-session';
import { checkAdminSession, getLoginSession } from '$lib/server/login-service';

export const GET: RequestHandler = async ({ cookies }) => {
	const error = checkAdminSession(cookies.get(ADMIN_COOKIE));
	if (error) return json({ ok: false, error }, { status: 401 });

	const session = getLoginSession();
	const status = await session.poll();

	return json({ ok: true, ...status });
};
