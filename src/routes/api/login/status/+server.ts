/**
 * 扫码登录接口 —— 轮询状态。
 *
 * `?svg=1` 时才回传二维码图：轮询是高频调用，每次都塞一份几十 KB 的
 * SVG 纯属浪费（码本身不会变）。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkLoginToken, getLoginSession } from '$lib/server/login-service';

export const GET: RequestHandler = async ({ request, url }) => {
	const error = checkLoginToken(request.headers.get('x-login-token'));
	if (error) return json({ ok: false, error }, { status: 401 });

	const session = getLoginSession();
	const withSvg = url.searchParams.get('svg') === '1';
	const status = await session.poll(withSvg);

	/* 成功或失败都不再需要二维码图 */
	return json({ ok: true, ...status });
};
