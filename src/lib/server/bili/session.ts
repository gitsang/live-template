/**
 * B 站登录态（Cookie）处理。
 *
 * 匿名连接时服务端返回 uid=0 并把昵称打码（`赛***`），带 Cookie 才会还原。
 * Cookie 只用于 HTTP API（nav / getDanmuInfo）：弹幕认证包仅靠 uid 字段声称身份，
 * 没有签名校验，所以 Cookie 不发给弹幕服务器。
 *
 * 只有 redactCookie() 可以把 Cookie 写进日志。
 */

/** Cookie 名 → 值 */
export type CookieMap = Record<string, string>;

/** 名称命中即脱敏 */
const CREDENTIAL_PATTERN = /sessdata|bili_jct|csrf|sfa|token|sid|ckmd5|buvid3__|buvid4__/i;

/** 登录态 uid */
const UID_KEYS = ['DedeUserID', 'DedeUserID__ckMd5'] as const;

/** 设备指纹 */
const BUVID_KEYS = ['buvid3', 'buvid4'] as const;

/** 容错解析：忽略空段与没有 `=` 的段，同名后者覆盖前者，并去掉值两侧引号。 */
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
		/* 浏览器复制出来的值常带引号 */
		out[name] = value.replace(/^"(.*)"$/, '$1');
	}
	return out;
}

/** Cookie 映射 → 请求头用的 Cookie 串（跳过空值） */
export function serializeCookie(map: CookieMap): string {
	return Object.entries(map)
		.filter(([, v]) => v !== '')
		.map(([k, v]) => `${k}=${v}`)
		.join('; ');
}

/**
 * 合并多个 Cookie 串，后者覆盖前者。
 *
 * 调用顺序为 `mergeCookies(匿名, 用户)`：用户自带的 buvid 与他的 SESSDATA 属于
 * 同一次会话，必须以他的为准，混用容易被风控。
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

/** 取登录 uid；取不到或非正整数时返回 0（匿名），不能返回 NaN。 */
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

/** 取设备指纹 buvid3 */
export function buvidFromCookie(raw: string): string {
	const map = parseCookie(raw);
	return map[BUVID_KEYS[0]] ?? '';
}

/**
 * 生成可写进日志的 Cookie 描述，是本模块唯一允许输出 Cookie 的通道。
 * 凭据类值变 `***`；buvid 只留前 8 位（够核对设备，不足以复用）；
 * DedeUserID 原样显示（公开 uid，且是排查登错号的关键线索）。
 */
export function redactCookie(raw: string): string {
	const map = parseCookie(raw);
	/* 换行会把一行日志劈成两行，等于让凭据持有者伪造日志内容 */
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

/** 昵称是否被打码（B 站给未登录观众返回 `赛***` 这类串） */
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
	 * 必须校验：认证包只靠 uid 声称身份，实测在**不带 Cookie** 时填真实 uid
	 * （如官方账号 2）会被服务端以 1006 直接断开且不回认证回应，比匿名还糟。
	 * 所以「解析出 DedeUserID」不等于「服务端认可」。默认不校验，仅测试用。
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
 * 在 buildAuth 基础上校验登录态有效性。
 * 校验失败降级为匿名而非硬失败 —— 一个可选凭据不该让直播间完全连不上。
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
 * 组装最终身份。用户的 Cookie 覆盖匿名 buvid：
 * 若用户自带 buvid3 就以其为准，因为它和 SESSDATA 属于同一次会话。
 */
export function buildAuth({ anonymousCookie, loginCookie = '' }: AuthInput): BiliAuth {
	const userCookie = loginCookie.trim();
	/* 有登录态时以它为主体，再用匿名指纹补齐缺失的 buvid */
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
 * `queue_uuid` 必须带：不带时同房间的多条连接会被当成同一消费组轮询分流，
 * 每条连接只能拿到一部分弹幕（实测差约 8 倍）。
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
