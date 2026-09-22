/**
 * 管理页的访问会话。
 *
 * 口令为什么不直接存在浏览器里：早期实现让前端把 LOGIN_TOKEN 存进 sessionStorage
 * 并逐请求带上。问题在于口令是长期凭据，被读到一次（XSS、截图、扩展）即永久泄漏，
 * 而会话是可以过期的。现在口令只在进入管理页时提交一次，服务端校验后下发
 * HttpOnly + 签名的会话 Cookie，浏览器自动携带、JS 读不到。口令不进任何前端存储。
 *
 * 为什么签名而不是服务端 session 表：HMAC 无状态，重启后仍有效、无需清理过期项。
 * 密钥由 LOGIN_TOKEN 派生，因此轮换口令即吊销所有会话 —— 这正是需要的语义；
 * 代价是无法单独吊销某一个会话，本场景（单运营者）不需要。
 *
 * 这些函数都是纯函数，便于直接断言签名/篡改/过期行为。
 */
import { createHmac } from 'node:crypto';
import { safeEqual } from './credential';

/** 管理会话 Cookie 名 */
export const ADMIN_COOKIE = 'lt_admin';

/** 会话有效期：7 天。够长以免长期开着 OBS 的人天天重登，又不至于永久有效 */
export const ADMIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 从口令派生签名密钥。
 *
 * 加上固定的前缀做域分隔：避免同一个口令被复用到别处时，
 * 在本项目里产生的签名也能在别处被验证。
 */
function keyFor(token: string): Buffer {
	return Buffer.from(`live-template.admin.v1:${token}`, 'utf8');
}

/** 计算过期时刻对应的签名（base64url，去掉 = 以免在 Cookie 里需转义） */
function sign(exp: number, token: string): string {
	return createHmac('sha256', keyFor(token)).update(String(exp)).digest('base64url');
}

/** 签发会话 Cookie 值 */
export function issueSession(token: string, now: number = Date.now()): string {
	const exp = now + ADMIN_TTL_MS;
	return `${exp}.${sign(exp, token)}`;
}

/**
 * 校验会话 Cookie 值：格式 → 签名（恒定时间）→ 过期。
 * 任一步不符即视为未授权，且不区分失败原因，避免给攻击者反馈。
 */
export function verifySession(
	value: string | undefined | null,
	token: string,
	now: number = Date.now()
): boolean {
	if (!value || !token) return false;

	const dot = value.indexOf('.');
	if (dot <= 0) return false;

	const expPart = value.slice(0, dot);
	const sigPart = value.slice(dot + 1);
	if (!/^\d+$/.test(expPart)) return false;

	const exp = Number(expPart);
	if (!Number.isFinite(exp) || exp <= now) return false;

	/* 两边都是 base64url 的定长输出，长度一致，正好适用恒定时间比较 */
	return safeEqual(sigPart, sign(exp, token));
}

/**
 * 管理会话 Cookie 的写选项。
 *
 * secure 必须显式指定，不能依赖框架默认值：SvelteKit 只在
 * `hostname === 'localhost' && http` 时为 false，其余一律 true。
 * 于是从局域网 http://192.168.x.x:8080 访问时浏览器会因 Secure **直接丢弃** Cookie，
 * 表现为「登入提示成功但页面依旧未授权」，极难排查 —— 而 compose 默认发布到 0.0.0.0。
 * 所以按实际协议决定：https 才加 Secure。
 */
export function sessionCookieOptions(secure: boolean): {
	path: string;
	httpOnly: boolean;
	sameSite: 'strict';
	secure: boolean;
	maxAge: number;
} {
	return {
		path: '/',
		/* JS 读不到，XSS 也偷不走 */
		httpOnly: true,
		/* 挡掉 CSRF：管理操作会写凭据文件，属于有副作用的请求 */
		sameSite: 'strict',
		secure,
		maxAge: Math.floor(ADMIN_TTL_MS / 1000)
	};
}

/**
 * 判断当前请求是否走 HTTPS。
 *
 * 直接信任 X-Forwarded-Proto 有被伪造的风险，但影响仅限于「把 cookie 标成 Secure」：
 * 伪造它最多让攻击者自己的请求失败，不构成越权，故接受这个取舍（反向代理下它是必需的）。
 */
export function isSecureRequest(request: Request, url: URL): boolean {
	const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
	return proto.split(',')[0]!.trim() === 'https';
}
