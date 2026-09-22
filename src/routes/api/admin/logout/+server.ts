/**
 * 管理页登出：清掉会话 Cookie。
 *
 * 只是让浏览器丢弃 Cookie，**不影响已写入的 B 站凭据** ——
 * 「退出管理页」与「退出 B 站登录」是两件事（后者删掉凭据文件即可）。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_COOKIE, isSecureRequest } from '$lib/server/admin-session';

export const POST: RequestHandler = ({ cookies, request, url }) => {
	/*
	 * 删除时必须带上与设置时**一致的属性**，否则浏览器不会认这个删除指令：
	 * Cookie 是按 `name + path + domain` 匹配的，而 `Secure`/`SameSite`
	 * 也必须与既有 Cookie 对得上，否则某些浏览器会直接丢弃这条 Set-Cookie。
	 *
	 * 实测踩到的坑：不传 `secure` 时 SvelteKit 用默认值 `true`，
	 * 于是 http 下浏览器忽略删除指令，**登出后会话依旧有效**。
	 * （表现：`set-cookie: lt_admin=; Max-Age=0; ...; Secure; SameSite=Lax`）
	 */
	cookies.delete(ADMIN_COOKIE, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: isSecureRequest(request, url)
	});
	return json({ ok: true });
};
