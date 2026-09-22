/**
 * 扫码登录接口 —— 开起挑战。
 *
 * 返回**画好的 SVG**，而不是二维码里的 URL：
 * URL 里含 `qrcode_key`，而持有它的人就能领走凭据（已实测：轮询接口
 * 不校验任何身份）。key 绝不离开服务端。
 *
 * 必须带 `x-login-token`，理由见 login.ts 顶部注释。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkLoginToken, getLoginSession } from '$lib/server/login-service';
import { createLogger } from '$lib/server/logger';

const log = createLogger('login');

export const POST: RequestHandler = async ({ request }) => {
	const error = checkLoginToken(request.headers.get('x-login-token'));
	if (error) {
		/*
		 * 只记「被拒绝」这一事实，不记口令内容 ——
		 * 否则日志采集系统里就会留下可用于爆破的样本。
		 */
		log.warn('登录接口拒绝了一次未授权的开起请求');
		return json({ ok: false, error }, { status: 401 });
	}

	try {
		const session = getLoginSession();
		const status = await session.start();
		return json({ ok: true, ...status });
	} catch (err) {
		const msg = (err as Error).message;
		log.error(`生成二维码失败: ${msg}`);
		return json({ ok: false, error: `生成二维码失败：${msg}` }, { status: 502 });
	}
};
