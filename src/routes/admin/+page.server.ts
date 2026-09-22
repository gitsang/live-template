/**
 * 管理页服务端数据。
 *
 * 关键点：**未授权时不返回任何数据**（连「有没有登录 B 站」都不告诉）。
 * 只在会话有效时下发状态，页面本身再根据 `authorized` 决定渲染登录表单还是面板。
 */
import { ADMIN_COOKIE } from '$lib/server/admin-session';
import { checkAdminSession, loginEnabled } from '$lib/server/login-service';
import { getHub } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

interface HubLike {
	hasAuth: boolean;
	snapshot(): Array<{ room: string; refs: number; state: unknown }>;
}

export const load: PageServerLoad = ({ cookies }) => {
	const enabled = loginEnabled();
	const error = checkAdminSession(cookies.get(ADMIN_COOKIE));
	const authorized = error === null;

	return {
		/** 网页登录是否开启（关闭时页面要给出提示，而不是显示一个永远失败的表单） */
		enabled,
		/** 会话是否有效 */
		authorized,
		/** 未授权时的原因，供页面展示 */
		reason: error ?? '',
		/*
		 * B 站登录态只在已授权时下发。
		 * 未授权时不下发任何运行状态 —— 那属于「不需要登录就能读到的信息」，
		 * 而管理页的整个意义就是把这类信息收进来。
		 */
		bili: authorized ? readBili() : null
	};
};

function readBili(): { loggedIn: boolean; cookiePath: string; rooms: number } {
	const hub = getHub<HubLike>();
	return {
		loggedIn: hub ? hub.hasAuth : false,
		/* 只给路径，不给内容；路径对排查「为什么还是匿名」有用 */
		cookiePath: process.env.BILI_COOKIE_FILE?.trim() || '(未设置 BILI_COOKIE_FILE)',
		rooms: hub ? hub.snapshot().length : 0
	};
}
