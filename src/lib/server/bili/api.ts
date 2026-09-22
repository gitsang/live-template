/**
 * B 站 API 访问层。
 *
 * 必须带 buvid 指纹 + WBI 签名（w_rid/wts）+ dm_img_* 风控参数，否则 getDanmuInfo 返回 -352。
 * 不需要登录账号，匿名即可。
 */

const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** WBI 签名的固定重排表 */
const MIXIN_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
	28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
	54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

const API = {
	roomInit: 'https://api.live.bilibili.com/room/v1/Room/room_init',
	spi: 'https://api.bilibili.com/x/frontend/finger/spi',
	nav: 'https://api.bilibili.com/x/web-interface/nav',
	danmuInfo: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'
} as const;

export interface RoomInit {
	/** 真实房间号（短号解析后） */
	roomId: number;
	/** 开播状态：0 未开播 / 1 直播中 / 2 轮播 */
	liveStatus: number;
}

export interface DanmuHost {
	host: string;
	/** API 建议的 wss 端口（默认不用，见 client.ts 为何固定走 443） */
	wssPort: number;
	wsPort: number;
}

/** API 原样返回的宿主结构（下划线命名） */
interface RawHost {
	host: string;
	wss_port?: number;
	ws_port?: number;
}

export interface DanmuInfo {
	token: string;
	hosts: DanmuHost[];
}

/** 匿名设备指纹 */
export interface Buvid {
	/** buvid3 */
	b_3: string;
	/** buvid4 */
	b_4: string;
	/** 组装好的 Cookie 头 */
	cookie: string;
}

export class BiliApiError extends Error {
	/** B 站返回的业务 code（HTTP 层错误时为空） */
	readonly code: number | undefined;

	constructor(message: string, code?: number) {
		super(message);
		this.name = 'BiliApiError';
		this.code = code;
	}
}

/** 统一的 GET + JSON 解析 */
async function apiGet<T>(url: string, cookie?: string, timeoutMs = 12_000): Promise<T> {
	const headers: Record<string, string> = {
		'User-Agent': UA,
		Accept: 'application/json, text/plain, */*',
		'Accept-Language': 'zh-CN,zh;q=0.9',
		Referer: 'https://live.bilibili.com/'
	};
	if (cookie) headers.Cookie = cookie;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { headers, signal: ctrl.signal });
		if (!res.ok) throw new BiliApiError(`HTTP ${res.status} ${url}`);
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/** 短号 → 真实房间号 */
export async function getRoomInit(input: string | number): Promise<RoomInit> {
	const res = await apiGet<{
		code: number;
		msg?: string;
		message?: string;
		data?: { room_id: number; live_status: number };
	}>(`${API.roomInit}?id=${encodeURIComponent(String(input))}`);

	if (res.code !== 0 || !res.data) {
		throw new BiliApiError(
			`room_init 失败: ${res.code} ${res.msg ?? res.message ?? ''}`,
			res.code
		);
	}
	return { roomId: res.data.room_id, liveStatus: res.data.live_status };
}

/** 取匿名设备指纹 buvid3 / buvid4 */
export async function getBuvid(): Promise<Buvid> {
	const res = await apiGet<{ code: number; data?: { b_3: string; b_4: string } }>(API.spi);
	if (res.code !== 0 || !res.data?.b_3) {
		throw new BiliApiError(`finger/spi 失败: ${res.code}`, res.code);
	}
	const { b_3, b_4 } = res.data;
	const cookie = `buvid3=${b_3}; buvid4=${b_4}; b_nut=${Math.floor(Date.now() / 1000)};`;
	return { b_3, b_4, cookie };
}

/** 从 wbi img/sub key 计算 mixin key */
export function wbiMixinKey(imgKey: string, subKey: string): string {
	const raw = imgKey + subKey;
	return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

import { createHash } from 'node:crypto';

/** WBI 签名：返回带 w_rid / wts 的完整查询串。必须先把 wts 并进参数集再排序拼串 */
export function wbiSign(
	params: Record<string, string | number>,
	mixinKey: string,
	wts: number = Math.floor(Date.now() / 1000)
): string {
	const all: Record<string, string | number> = { ...params, wts };
	const query = Object.keys(all)
		.sort()
		.map(
			(k) =>
				`${encodeURIComponent(k)}=${encodeURIComponent(
					String(all[k]).replace(/[!'()*]/g, '')
				)}`
		)
		.join('&');

	const w_rid = createHash('md5').update(query + mixinKey).digest('hex');
	return `${query}&w_rid=${w_rid}`;
}

/** 登录态校验结果 */
export interface NavInfo {
	/** 是否已登录。匿名请求返回 code=-101 / isLogin=false */
	isLogin: boolean;
	/** 登录用户 uid */
	uid: number;
	/** 登录用户昵称 */
	uname: string;
}

/**
 * 用 nav 接口校验 Cookie 是否为**有效登录态**。
 *
 * 必须先校验：认证包只靠 uid 声称身份，实测**不带 Cookie** 却填真实 uid（如账号 2）
 * 会被服务端以 1006 直接断开且不回认证回应 —— 声称登录必须有凭据支撑，
 * 否则连匿名都不如。匿名请求返回 code=-101、isLogin=false，不抛错。
 */
export async function getNavInfo(cookie: string): Promise<NavInfo> {
	const res = await apiGet<{
		code: number;
		data?: { isLogin?: boolean; mid?: number; uname?: string };
	}>(API.nav, cookie);

	const data = res.data;
	return {
		isLogin: Boolean(data?.isLogin) && Number(data?.mid) > 0,
		uid: Number(data?.mid) || 0,
		uname: String(data?.uname ?? '')
	};
}

/** 取 nav 里的 wbi 密钥 */
async function getWbiKeys(cookie: string): Promise<{ imgKey: string; subKey: string }> {
	const res = await apiGet<{
		code: number;
		data?: { wbi_img?: { img_url: string; sub_url: string } };
	}>(API.nav, cookie);

	const wbi = res.data?.wbi_img;
	if (!wbi?.img_url || !wbi?.sub_url) {
		throw new BiliApiError('拿不到 WBI 密钥（nav 接口异常）', res.code);
	}
	const pick = (url: string): string => url.split('/').pop()?.split('.')[0] ?? '';
	return { imgKey: pick(wbi.img_url), subKey: pick(wbi.sub_url) };
}

/**
 * 取弹幕服务器 token 与地址列表。
 * cookie 可以是匿名指纹，也可以是带登录态的完整 Cookie（后者更容易通过风控）。
 */
export async function getDanmuInfo(roomId: number, cookie: string): Promise<DanmuInfo> {
	const { imgKey, subKey } = await getWbiKeys(cookie);
	const mixinKey = wbiMixinKey(imgKey, subKey);

	/* dm_img_* 是风控参数，照抄网页端的固定值即可 */
	const query = wbiSign(
		{
			id: roomId,
			type: 0,
			web_location: '444.8',
			dm_img_list: '[]',
			dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
			dm_cover_img_str:
				'QU5HTEUgKE5WSURJQSxOVklESUEgR2VGb3JjZSBHVFggMTA1MCBXaXRoIGRpcmVjdCAzZCAoMHgwMDAwMjY2MSkgRGlyZWN0M0QxMSB2c181XzAp',
			dm_img_inter: '{"ds":[],"wh":[],"of":[]}'
		},
		mixinKey
	);

	const res = await apiGet<{
		code: number;
		message?: string;
		msg?: string;
		data?: { token: string; host_list: RawHost[] };
	}>(`${API.danmuInfo}?${query}`, cookie);

	if (res.code !== 0 || !res.data) {
		throw new BiliApiError(
			`getDanmuInfo 失败: ${res.code} ${res.message ?? res.msg ?? ''}`,
			res.code
		);
	}

	const hosts: DanmuHost[] = (res.data.host_list ?? []).map((h) => ({
		host: h.host,
		wssPort: Number(h.wss_port) || 443,
		wsPort: Number(h.ws_port) || 0
	}));
	if (hosts.length === 0) throw new BiliApiError('getDanmuInfo 未返回可用服务器');

	return { token: res.data.token, hosts };
}


