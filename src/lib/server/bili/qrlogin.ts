/**
 * B 站扫码登录。
 *
 * 流程（官方 H5 扫码登录）：
 *   1. GET  /x/passport-login/web/qrcode/generate  → { url, qrcode_key }
 *   2. 把 url 生成二维码，用 B 站 App 扫码
 *   3. 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *      86101 未扫码 → 86090 已扫码待确认 → 0 成功（HTTP Set-Cookie 里下发凭据）
 *
 * 为什么要有这条路：手抄 Cookie 既容易抄错，又容易把 `SESSDATA` 粘到
 * 不该粘的地方。扫码只需一次，且拿到的是完整凭据集合。
 *
 * 状态码与取 Cookie 的方式都经过实测（见 tests/unit.test.ts 的固定报文），
 * 「成功」分支无法在无人值守环境复现，因此本模块把所有解析都做成纯函数，
 * 只把网络调用留在薄薄的外层。
 */

const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const API = {
	generate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
	poll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
} as const;

/** 轮询返回的业务状态码 */
export const QR_CODE = {
	SUCCESS: 0,
	/** 二维码已过期，需要重新生成 */
	EXPIRED: 86038,
	/** 已扫码，等待用户在手机上确认 */
	SCANNED: 86090,
	/** 尚未扫码 */
	PENDING: 86101
} as const;

export type QrStatus = 'pending' | 'scanned' | 'success' | 'expired' | 'timeout' | 'unknown';

/** 业务状态码 → 语义 */
export function parseQrStatus(code: number | undefined): QrStatus {
	switch (code) {
		case QR_CODE.SUCCESS:
			return 'success';
		case QR_CODE.EXPIRED:
			return 'expired';
		case QR_CODE.SCANNED:
			return 'scanned';
		case QR_CODE.PENDING:
			return 'pending';
		default:
			return 'unknown';
	}
}

/** 状态 → 给人看的文案 */
export const QR_STATUS_TEXT: Record<QrStatus, string> = {
	pending: '等待扫码',
	scanned: '已扫码，请在手机上确认',
	success: '登录成功',
	expired: '二维码已过期',
	timeout: '等待超时（未完成扫码）',
	unknown: '未知状态'
};

export interface QrChallenge {
	/** 二维码里要编码的地址 */
	url: string;
	/** 轮询用的 key */
	key: string;
}

/** 生成二维码挑战 */
export async function generateQrChallenge(): Promise<QrChallenge> {
	const res = await fetch(API.generate, {
		headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
	});
	if (!res.ok) throw new Error(`生成二维码失败：HTTP ${res.status}`);

	const body = (await res.json()) as {
		code: number;
		message?: string;
		data?: { url?: string; qrcode_key?: string };
	};
	if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) {
		throw new Error(`生成二维码失败：${body.code} ${body.message ?? ''}`);
	}
	return { url: body.data.url, key: body.data.qrcode_key };
}

export interface QrPollResult {
	status: QrStatus;
	/** 成功时的 Cookie 串；其余状态为空 */
	cookie: string;
	/** 成功时 B 站返回的跳转地址（含参数），便于排查 */
	redirectUrl: string;
	/** 原始业务状态码 */
	rawCode: number | undefined;
}

/**
 * 从 `Set-Cookie` 头里挑出登录凭据。
 *
 * B 站在登录成功时下发一整套 Cookie，但 `set-cookie` 的解析在不同运行时
 * 略有差异（Node 的 `getSetCookie()` 返回数组），因此这里既接受数组也接受
 * 单串，并且**按值截断到第一个分号** —— `Set-Cookie` 会带
 * `Path=/`、`Expires=`、`HttpOnly` 等属性，直接拼进 Cookie 头会污染请求。
 *
 * 只保留凭据相关的字段：B 站还顺带下发 `LIVE_BUVID`、`buvid3` 等，
 * 但那些属于设备指纹，由本地 SPI 流程负责，没必要混进来。
 */
export function extractLoginCookie(setCookies: readonly string[]): string {
	/** 登录必需或显著有用的字段 */
	const WANTED = [
		'SESSDATA',
		'bili_jct',
		'DedeUserID',
		'DedeUserID__ckMd5',
		'sid',
		'buvid3',
		'buvid4'
	];

	const out: Record<string, string> = {};
	for (const raw of setCookies) {
		if (!raw) continue;
		const pair = raw.split(';', 1)[0]?.trim() ?? '';
		const eq = pair.indexOf('=');
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!WANTED.includes(name)) continue;
		/* 空值不要：B 站有时会下发 `SESSDATA=` 之类的清除指令 */
		if (value === '') continue;
		out[name] = value;
	}

	/* SESSDATA 是登录的核心凭据；没有它就等于没登录上 */
	if (!out.SESSDATA) return '';

	return Object.entries(out)
		.map(([k, v]) => `${k}=${v}`)
		.join('; ');
}

/**
 * 轮询一次。
 *
 * Cookie 可能出现在两个位置，实测两种都存在过：
 * 1. HTTP 响应的 `Set-Cookie`（主流）
 * 2. `data.url` 的查询参数里（旧版行为，`url` 会带上同样的凭据）
 * 因此优先用 Set-Cookie，取不到再从 `url` 兜底。
 */
export async function pollQrOnce(key: string): Promise<QrPollResult> {
	const res = await fetch(`${API.poll}?qrcode_key=${encodeURIComponent(key)}`, {
		headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
	});
	if (!res.ok) throw new Error(`轮询失败：HTTP ${res.status}`);

	const setCookies: string[] =
		typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

	const body = (await res.json()) as {
		code: number;
		data?: { code?: number; url?: string; refresh_token?: string };
	};

	const rawCode = body.data?.code;
	const status = parseQrStatus(rawCode);
	const redirectUrl = body.data?.url ?? '';

	if (status !== 'success') {
		return { status, cookie: '', redirectUrl, rawCode };
	}

	/* 成功：优先 Set-Cookie，其次从跳转地址里取 */
	let cookie = extractLoginCookie(setCookies);
	if (!cookie) cookie = extractLoginCookieFromUrl(redirectUrl);

	return { status, cookie, redirectUrl, rawCode };
}

/**
 * 从跳转地址的查询串里取凭据。
 *
 * 形如 `...?DedeUserID=123&Expires=...&SESSDATA=...&bili_jct=...`。
 *
 * ⚠️ 这里**不能**用 `URLSearchParams`：它会做百分号解码，而 B 站的 SESSDATA
 * 值本身就带 `%2C`（逗号分隔符）之类的转义，是**编码形态**。
 * 解码后再放进 Cookie 头就与服务端存储的形态不一致，凭据会失效。
 * 因此手工按 `&` / `=` 切分并原样保留值。
 */
export function extractLoginCookieFromUrl(url: string): string {
	const WANTED = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
	if (!url) return '';

	const qIndex = url.indexOf('?');
	if (qIndex < 0) return '';
	/* 去掉 #hash，它不属于查询串 */
	const query = url.slice(qIndex + 1).split('#', 1)[0] ?? '';

	const found: Record<string, string> = {};
	for (const seg of query.split('&')) {
		if (!seg) continue;
		const eq = seg.indexOf('=');
		if (eq <= 0) continue;
		const name = seg.slice(0, eq);
		const value = seg.slice(eq + 1);
		if (!WANTED.includes(name) || value === '') continue;
		/* 原样保留，不解码 */
		found[name] = value;
	}

	/* 同上：没有 SESSDATA 就等于没登录上 */
	if (!found.SESSDATA) return '';
	return Object.keys(found)
		.map((k) => `${k}=${found[k]}`)
		.join('; ');
}

/**
 * 轮询直到出现终态。
 *
 * - 每 `intervalMs` 一次，最多 `timeoutMs`
 * - `scanned` 会通过 `onStatus` 回调上报，便于界面更新
 *
 * 超时单独返回 `timeout`，**不能混同为 `expired`**：
 * 超时的原始状态码通常是 86101（未扫码），而 `expired` 对应 86038。
 * 把两者混在一起会打印出「二维码已过期（状态码 86101）」这种自相矛盾的信息，
 * 让人误以为二维码失效了其实是没人扫。
 */
export async function waitForQrLogin(
	key: string,
	options: {
		intervalMs?: number;
		timeoutMs?: number;
		onStatus?: (status: QrStatus) => void;
		/** 供测试注入的时钟 */
		sleep?: (ms: number) => Promise<void>;
	} = {}
): Promise<QrPollResult> {
	const intervalMs = options.intervalMs ?? 2000;
	const timeoutMs = options.timeoutMs ?? 180_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

	const started = Date.now();
	let last: QrStatus | null = null;

	for (;;) {
		const result = await pollQrOnce(key);
		if (result.status !== last) {
			last = result.status;
			options.onStatus?.(result.status);
		}

		if (result.status === 'success' || result.status === 'expired') return result;
		if (Date.now() - started >= timeoutMs) {
			return { ...result, status: 'timeout' };
		}
		await sleep(intervalMs);
	}
}
