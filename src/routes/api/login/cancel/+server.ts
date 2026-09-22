/**
 * 扫码登录接口 —— 取消当前流程。取消**不会**删除已写入的凭据文件：
 * 那是「退出登录」，与「放弃这次扫码」是两件事，真要退出删掉凭据文件并重启即可
 * （刻意不提供网页端退出：那等于给了一个「让直播间掉线」的远程开关）。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_COOKIE } from '$lib/server/admin-session';
import { checkAdminSession, getLoginSession } from '$lib/server/login-service';

export const POST: RequestHandler = ({ cookies }) => {
	const error = checkAdminSession(cookies.get(ADMIN_COOKIE));
	if (error) return json({ ok: false, error }, { status: 401 });

	const session = getLoginSession();
	return json({ ok: true, ...session.cancel() });
};
