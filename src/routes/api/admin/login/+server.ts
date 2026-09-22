/**
 * 管理页登入：用访问口令换一个会话 Cookie。
 *
 * 流程：POST { token } → 校验口令 → 下发 HttpOnly 签名 Cookie。
 * 口令只在这里出现一次，之后浏览器只带 Cookie，
 * 前端 JS 拿不到也不需要拿口令（见 admin-session.ts 顶部注释）。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	ADMIN_COOKIE,
	isSecureRequest,
	issueSession,
	sessionCookieOptions
} from '$lib/server/admin-session';
import { checkLoginToken, currentToken, loginEnabled } from '$lib/server/login-service';
import { createLogger } from '$lib/server/logger';

const log = createLogger('admin');

export const POST: RequestHandler = async ({ request, url, cookies }) => {
	if (!loginEnabled()) {
		return json(
			{ ok: false, error: '网页登录未开启（未配置 LOGIN_TOKEN）。可在终端执行 npm run login 扫码。' },
			{ status: 503 }
		);
	}

	let provided = '';
	try {
		const body = (await request.json()) as { token?: unknown };
		provided = typeof body.token === 'string' ? body.token : '';
	} catch {
		return json({ ok: false, error: '请求格式错误' }, { status: 400 });
	}

	const error = checkLoginToken(provided);
	if (error) {
		/*
		 * 只记「被拒绝」这一事实，不记口令内容 ——
		 * 否则日志采集系统里就留下了可用于爆破的样本。
		 */
		log.warn('管理页登入被拒绝（口令缺失或错误）');
		return json({ ok: false, error }, { status: 401 });
	}

	/*
	 * 用 SvelteKit 的 cookies API 而不是手拼 Set-Cookie 头：
	 * 它同时把值写入本次请求上下文，后续同请求内的 cookies.get 立即可见。
	 * secure 必须显式传入 —— 默认值在局域网 http 下会丢弃 Cookie，
	 * 造成「登入成功但依旧未授权」（详见 admin-session.ts）。
	 */
	cookies.set(
		ADMIN_COOKIE,
		issueSession(currentToken()),
		sessionCookieOptions(isSecureRequest(request, url))
	);

	log.info('管理页登入成功，已下发会话 Cookie');
	return json({ ok: true });
};
