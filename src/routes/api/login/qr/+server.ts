/**
 * 扫码登录接口 —— 开起挑战，返回渲染好的 SVG。
 *
 * SVG **不是**安全边界：它就是 qrcode_key 的图形编码（实测可解码还原），
 * 而持有 key 的人在扫码成功后就能领走 Cookie。保护完全来自管理会话 Cookie
 * （先访问 /admin 登入），理由见 login.ts 顶部注释。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_COOKIE } from '$lib/server/admin-session';
import { checkAdminSession, getLoginSession } from '$lib/server/login-service';
import { createLogger } from '$lib/server/logger';

const log = createLogger('login');

export const POST: RequestHandler = async ({ cookies }) => {
	const error = checkAdminSession(cookies.get(ADMIN_COOKIE));
	if (error) {
		/* 只记「被拒绝」，不记口令内容 —— 否则日志采集里就留下可用于爆破的样本 */
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
