/**
 * B 站登录态（Cookie）处理。
 *
 * 目的：匿名连接时 B 站会返回 `uid = 0` 且把昵称打码（`赛***`）。
 * 带上登录态 Cookie 后，弹幕服务器会把 `uname` 还原成真实昵称。
 *
 * 机制说明（重要）：
 * 弹幕 WebSocket 的认证包只靠 `uid` 字段声称身份，**没有签名校验**，
 * 因此「已登录」这件事是通过在认证包里填真实 `uid` 表达的，
 * 而不是把 Cookie 发给弹幕服务器。Cookie 只用于 HTTP API（nav / getDanmuInfo）。
 * 这与 blivedm / bilibili-live-ws 等参考实现一致。
 *
 * 安全约定：本模块导出的 `redactCookie()` 是**唯一**允许把 Cookie 写进日志的
 * 通道；其他地方一律不得打印原始 Cookie。
 */

/** Cookie 名 → 值 */
export type CookieMap = Record<string, string>;

/** 名称命中即视为凭据，值一律脱敏 */
const CREDENTIAL_PATTERN = /sessdata|bili_jct|csrf|sfa|token|sid|ckmd5|buvid3__|buvid4__/i;

/** 登录态 uid 所在的 Cookie 名 */
const UID_KEYS = ['DedeUserID', 'DedeUserID__ckMd5'] as const;

/** 用到的设备指纹 Cookie 名 */
const BUVID_KEYS = ['buvid3', 'buvid4'] as const;

/**
 * 解析 Cookie 串。
 *
 * 容错优先：忽略空段、忽略没有 `=` 的段、同名后者覆盖前者。
 * 浏览器里复制出来的 Cookie 常带换行与多余空格，这里一并清掉。
 */
export function parseCookie(raw: string): CookieMap {
	const out: CookieMap = {};
	if (!raw) return out;

	for (const part of raw.split(';')) {
		const seg = part.trim();
		if (!seg) continue;
		const eq = seg.indexOf('=');
		if (eq <= 0) continue;
		const name = seg.slice(0, eq).trim();
		const value = seg.slice(eq + 1).trim();
		if (!name) continue;
		/* 去掉值两侧可能存在的引号 */
		out[name] = value.replace(/^"(.*)"$/, '$1');
	}
	return out;
}

/** Cookie 映射 → 请求头用的 Cookie 串 */
export function serializeCookie(map: CookieMap): string {
	return Object.entries(map)
		.filter(([, v]) => v !== '')
		.map(([k, v]) => `${k}=${v}`)
		.join('; ');
}

/**
 * 合并多个 Cookie 串，**后者覆盖前者**。
 *
 * 用途：把「配置里的登录态」叠加到「匿名 SPI 拿到的 buvid」之上。
 * 若用户自己在 Cookie 里带了 buvid3，应以用户的为准（他与该会话绑定），
 * 所以调用顺序是 `mergeCookies(anonymousBuvid, userCookie)`。
 */
export function mergeCookies(...raws: string[]): string {
	const merged: CookieMap = {};
	for (const raw of raws) Object.assign(merged, parseCookie(raw));
	return serializeCookie(merged);
}

/** 取单个 Cookie 值 */
export function cookieValue(raw: string, name: string): string {
	return parseCookie(raw)[name] ?? '';
}

/**
 * 从 Cookie 里取登录 uid。
 *
 * `DedeUserID` 就是 B 站的用户 uid，公开可见，用于认证包里的 `uid` 字段。
 * 取不到或不是正整数时返回 0（匿名）—— 不能返回 NaN，否则认证包会带上非法值。
 */
export function userIdFromCookie(raw: string): number {
	const map = parseCookie(raw);
	for (const key of UID_KEYS) {
		const v = map[key];
		if (!v) continue;
		const n = Number(v);
		if (Number.isSafeInteger(n) && n > 0) return n;
	}
	return 0;
}

/** 从 Cookie 里取设备指纹 buvid3 */
export function buvidFromCookie(raw: string): string {
	const map = parseCookie(raw);
	return map[BUVID_KEYS[0]] ?? '';
}

/**
 * 生成可安全写进日志的 Cookie 描述。
 *
 * 这是唯一允许输出 Cookie 相关信息的通道：
 * - 凭据类（SESSDATA / bili_jct / …）的值一律变成 `***`
 * - buvid 只留前 8 位（够用于核对设备，不足以复用）
 * - `DedeUserID` 原样显示：它是公开 uid，且是排查「登错号」的关键线索
 * - 其余字段只留前 6 位
 */
export function redactCookie(raw: string): string {
	const map = parseCookie(raw);
	/* 去掉控制字符：换行会把一行日志劈成两行，等于让凭据持有者伪造日志内容 */
	const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '·');
	const parts = Object.keys(map).map((name) => {
		const value = clean(map[name]);
		if (value === '') return `${name}=`;
		if (name === 'DedeUserID') return `${name}=${value}`;
		if (CREDENTIAL_PATTERN.test(name)) return `${name}=***`;
		if (BUVID_KEYS.includes(name as (typeof BUVID_KEYS)[number])) {
			return `${name}=${value.slice(0, 8)}…`;
		}
		return value.length > 10 ? `${name}=${value.slice(0, 6)}…` : `${name}=${value}`;
	});
	return parts.length > 0 ? parts.join('; ') : '(空)';
}

/**
 * 昵称是否被打码。
 *
 * B 站对未登录观众返回 `赛***`、`x***` 这类串。
 * 用于自检输出「登录态是否真的生效」，而不是让使用者靠肉眼猜。
 */
export function isMaskedName(name: string): boolean {
	return /\*{2,}/.test(name);
}

/** 连接所用的身份 */
export interface BiliAuth {
	/** HTTP 请求用的 Cookie 头 */
	cookie: string;
	/** 设备指纹（认证包里的 buvid） */
	buvid: string;
	/** 登录 uid；0 表示匿名 */
	uid: number;
	/** 是否带上了登录态 */
	authenticated: boolean;
}

export interface AuthInput {
	/** 匿名 SPI 拿到的 Cookie（含 buvid3/buvid4/b_nut） */
	anonymousCookie: string;
	/** 配置里的登录态 Cookie；留空即匿名 */
	loginCookie?: string;
	/**
	 * 校验登录态是否真的有效。
	 *
	 * 为什么必须校验：弹幕服务器的认证包只靠 uid 声称身份。实测在**不带
	 * Cookie** 的情况下填一个真实 uid（如官方账号 2），服务端会以 1006
	 * 直接关闭连接且不回认证回应 —— 比匿名连接还糟。所以「Cookie 里解析出
	 * DedeUserID」不等于「服务端认可这个身份」，必须让 nav 接口确认。
	 *
	 * 默认不校验（只用于单测）；生产由 client.ts 注入真实的 nav 校验。
	 */
	verify?: (cookie: string, claimedUid: number) => Promise<boolean>;
}

/** 组装结果：最终身份 + 需要提示给使用者的告警 */
export interface AuthResult {
	auth: BiliAuth;
	/** 非空时应显示给使用者（登录态配了但不可用等） */
	warning: string | null;
}

/**
 * 异步版本：在 buildAuth 的基础上**校验登录态有效性**。
 *
 * 校验失败时降级为匿名（uid=0）而不是硬失败 —— 一个可选凭据不该让直播间
 * 完全连不上；同时给出明确告警，避免「以为登录了其实没有」。
 */
export async function resolveAuth({
	anonymousCookie,
	loginCookie = '',
	verify
}: AuthInput): Promise<AuthResult> {
	const auth = buildAuth({ anonymousCookie, loginCookie });
	if (!auth.authenticated) return { auth, warning: null };

	if (verify) {
		let ok = false;
		try {
			ok = await verify(auth.cookie, auth.uid);
		} catch {
			ok = false;
		}
		if (!ok) {
			return {
				auth: { ...auth, uid: 0, authenticated: false },
				warning:
					'配置了 BILI_COOKIE，但 B 站未认可该登录态（可能已过期或已失效），' +
					'已降级为匿名连接：昵称会被打码，且部分弹幕可能被服务端隐藏。'
			};
		}
	}

	return { auth, warning: null };
}

/**
 * 组装最终身份。
 *
 * 用户的 Cookie 覆盖匿名的 buvid —— 若他自带 buvid3 就以其为准，
 * 因为那个设备指纹和 SESSDATA 属于同一次会话，混用容易被风控。
 */
export function buildAuth({ anonymousCookie, loginCookie = '' }: AuthInput): BiliAuth {
	const userCookie = loginCookie.trim();
	/* 有登录态时用它为主体，再用匿名指纹补齐缺失的 buvid */
	const cookie = userCookie
		? mergeCookies(anonymousCookie, userCookie)
		: mergeCookies(anonymousCookie);

	const uid = userIdFromCookie(cookie);
	const buvid = buvidFromCookie(cookie) || buvidFromCookie(anonymousCookie);

	return { cookie, buvid, uid, authenticated: uid > 0 };
}

/** 认证包字段（弹幕服务器 op=7 的 JSON body） */
export interface AuthPacketInput {
	/** 登录 uid；0 表示匿名 */
	uid: number;
	roomId: number;
	/** getDanmuInfo 下发的 token */
	token: string;
	/** 设备指纹 */
	buvid: string;
	/** 队列号，让本连接独占一条投递队列 */
	queueUuid: string;
}

/**
 * 构建认证包。
 *
 * 抽成纯函数是为了能**断言「登录态确实进了认证包」**：
 * 这是匿名与登录唯一的差别，如果这里漏传 uid，表现只是「昵称仍被打码」，
 * 不会报任何错，靠肉眼很难发现。
 *
 * `queue_uuid` 必须带上：不带时同房间的多条连接会被当成同一消费组
 * 轮询分流，每条连接只能拿到一部分弹幕（实测差约 8 倍）。
 */
export function buildAuthPacket(input: AuthPacketInput): string {
	return JSON.stringify({
		uid: input.uid,
		roomid: input.roomId,
		protover: 3,
		platform: 'web',
		type: 2,
		key: input.token,
		buvid: input.buvid,
		support_ack: true,
		queue_uuid: input.queueUuid,
		scene: 'room'
	});
}
