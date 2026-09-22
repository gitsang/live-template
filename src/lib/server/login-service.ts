/**
 * 网页登录的单例装配。
 *
 * 走 globalThis 而不是模块级变量：生产环境下 build/handler.js（SvelteKit 产物）
 * 与 build/danmaku/entry.js（服务端产物）是两次独立打包，各有自己的模块实例，
 * 模块级单例互不可见。但两者在同一进程内，因此沿用 registry.ts 的 Symbol.for 桥接方式。
 */
import { getNavInfo } from './bili/api';
import { verifySession } from './admin-session';
import { loadConfig } from './config';
import { DEFAULT_COOKIE_FILE, safeEqual, writeCookieFile } from './credential';
import { LoginSession } from './login';
import { getHub } from './registry';
import { qrSvg } from '$lib/shared/qr';
import { createLogger } from './logger';

const log = createLogger('login');

const LOGIN_KEY = Symbol.for('live-template.login');

type GlobalWithLogin = typeof globalThis & {
	[LOGIN_KEY]?: LoginSession;
};

/**
 * 凭据写入路径：用配置里正在读的那个文件（BILI_COOKIE_FILE），
 * 这样扫码结果与读取路径天然一致。否则会出现「扫码成功但仍匿名」这种极难排查的状态
 * （真发生过：compose 找 /run/secrets/bili-cookie，CLI 却写 bili-cookie.txt）。
 */
function resolveCookiePath(): string {
	const fromEnv = (process.env.BILI_COOKIE_FILE ?? '').trim();
	return fromEnv || DEFAULT_COOKIE_FILE;
}

interface HubLike {
	reloadAuth(cookie: string): void;
}

/**
 * 取（或创建）登录会话单例。每次都重新读配置：LOGIN_TOKEN 可能通过环境变量注入，
 * 而配置本身是进程级缓存的，这里不做额外缓存以免与缓存策略打架。
 */
export function getLoginSession(): LoginSession {
	const g = globalThis as GlobalWithLogin;
	if (g[LOGIN_KEY]) return g[LOGIN_KEY];

	const session = new LoginSession({
		renderSvg: (url) => qrSvg(url, { cell: 8, margin: 4, dark: '#0e111d', light: '#e8ecff' }),
		onSuccess: async (cookie) => {
			/* 先写文件：写入失败应当让调用方看到错误，而不是先热重载再报错 */
			const path = resolveCookiePath();
			writeCookieFile(path, cookie);
			log.info(`凭据已写入 ${path}（权限 600）`);

			/*
			 * 立刻用 nav 校验并拿到昵称。不只为了显示：它同时证明「这份凭据真的能用」，
			 * 否则界面只能显示「登录成功」，而使用者真正关心的是「昵称还会不会被打码」。
			 */
			const nav = await getNavInfo(cookie);
			if (!nav.isLogin || nav.uid <= 0) {
				throw new Error('凭据已保存，但 B 站未认可该登录态（可能已失效）');
			}

			/* 热重载：让正在运行的采集会话改用新身份，无需重启服务 */
			const hub = getHub<HubLike>();
			if (hub) {
				hub.reloadAuth(cookie);
			} else {
				log.warn('未找到 hub，登录态已写入文件但需重启服务才能生效');
			}

			return { uid: nav.uid, uname: nav.uname };
		}
	});

	g[LOGIN_KEY] = session;
	return session;
}

/**
 * 校验访问口令，返回 null 表示通过。抽成函数是为了让开起/轮询/取消/管理页
 * 用同一份判断，避免某个路由漏检 —— 漏一个就等于全没防。
 */
export function checkLoginToken(provided: string | null): string | null {
	const expected = (process.env.LOGIN_TOKEN ?? loadConfig().loginToken ?? '').trim();

	if (!expected) {
		return '网页登录未开启（未配置 LOGIN_TOKEN）。可在终端执行 npm run login 扫码登录。';
	}
	if (!provided) return '缺少访问口令';

	/* 恒定时间比较，避免通过响应耗时逐字节猜口令 */
	if (!safeEqual(provided.trim(), expected)) return '访问口令不正确';

	return null;
}

/** 当前生效的访问口令（空串 = 网页登录未开启） */
export function currentToken(): string {
	return (process.env.LOGIN_TOKEN ?? loadConfig().loginToken ?? '').trim();
}

/** 网页登录是否已开启 */
export function loginEnabled(): boolean {
	return currentToken() !== '';
}

/**
 * 校验管理会话，返回 null 表示已授权。所有管理接口与 /admin 页面的**唯一**入口判断。
 * 与 checkLoginToken 的区别：那个验口令本身（登入时用一次），这个验口令派生出的
 * 签名会话 Cookie —— 口令不进浏览器 JS 存储。
 */
export function checkAdminSession(sessionValue: string | undefined | null): string | null {
	const token = currentToken();
	if (!token) return '网页登录未开启（未配置 LOGIN_TOKEN）';

	if (!verifySession(sessionValue, token)) return '未登录或会话已过期，请重新进入管理页';

	return null;
}
