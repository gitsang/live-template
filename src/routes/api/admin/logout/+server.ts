/**
 * 管理页登出：清掉会话 Cookie，**不影响已写入的 B 站凭据** ——
 * 「退出管理页」与「退出 B 站登录」是两件事。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_COOKIE, isSecureRequest } from '$lib/server/admin-session';

export const POST: RequestHandler = ({ cookies, request, url }) => {
	/*
	 * 删除必须带上与设置时**一致的属性**：Cookie 按 name+path+domain 匹配，
	 * Secure/SameSite 对不上时某些浏览器会直接丢弃这条 Set-Cookie。
	 * 实测：不传 secure 时 SvelteKit 默认 true，于是 http 下浏览器忽略删除指令，
	 * **登出后会话依旧有效**（表现：set-cookie 带 Max-Age=0 但仍含 Secure）。
	 */
	cookies.delete(ADMIN_COOKIE, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: isSecureRequest(request, url)
	});
	return json({ ok: true });
};
