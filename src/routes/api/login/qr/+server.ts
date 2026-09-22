/**
 * 扫码登录接口 —— 开起挑战。
 *
 * 返回渲染好的 SVG。注意这**不是**安全边界：SVG 就是 `qrcode_key` 的图形编码，
 * 把图解码回来即可还原出 key（已实测）。本接口的保护完全来自下面的访问口令，
 * 因为图 = 凭据等价物（持有 key 的人在扫码成功后能领走 Cookie，
 * 而 B 站轮询接口不校验任何身份）。
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
