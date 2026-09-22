/**
 * B 站消息 → 本项目事件的纯解析函数，抽出来是为了可单测：
 * SC 很稀有、礼物也要等，写在私有方法里就只能靠连真实直播间碰运气。
 * 集中一处也便于兼容字段差异（粉丝牌有数组/对象两种形态，等级在 gift 里叫
 * wealth_level、SC 里叫 user_level）。
 *
 * 取值策略是「多路径兜底」：任一字段缺失都不应让整条事件丢掉。
 */
import type { GiftEvent, SuperChatEvent } from '$lib/shared/types';

/** 宽松的原始报文对象 */
type Raw = Record<string, unknown>;

/** 依次取第一个是数字的候选值，全都不合法时用 fallback */
function firstNum(fallback: number, ...candidates: unknown[]): number {
	for (const c of candidates) {
		if (c === undefined || c === null || c === '') continue;
		const n = Number(c);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

/** 依次取第一个非空字符串 */
function firstStr(...candidates: unknown[]): string {
	for (const c of candidates) {
		if (c === undefined || c === null) continue;
		const s = String(c);
		if (s !== '') return s;
	}
	return '';
}

/** 安全地按 key 取值 */
function obj(v: unknown): Raw {
	return v && typeof v === 'object' ? (v as Raw) : {};
}

/**
 * 解析粉丝牌。
 *
 * 三种形态都要认：
 * - 弹幕 `info[3]`：数组 `[等级, 名称, ...]`
 * - 礼物 `data.medal_info`：对象 `{ medal_name, medal_level }`
 * - SC `data.uinfo.medal` / `data.user_info.medal_info`：对象（同上）
 *
 * 名称与等级都齐全才算有效（B 站会用 0/空串表示「无粉丝牌」）。
 */
export function parseMedal(raw: unknown): [string, number] | null {
	if (Array.isArray(raw)) {
		const name = raw[1];
		const level = raw[0];
		if (name) return [String(name), firstNum(0, level)];
		return null;
	}

	const o = obj(raw);
	const name = firstStr(o.medal_name, o.name, o.medalName);
	const level = firstNum(0, o.medal_level, o.level, o.medalLevel);
	if (!name) return null;
	return [name, level];
}

/** 归一化 `#RRGGBB`；非法输入返回 null，由调用方决定兜底值 */
export function parseColor(raw: unknown): string | null {
	const s = String(raw ?? '').trim();
	return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

/**
 * 解析 SEND_GIFT。
 *
 * 主要字段来自 `data`：`uname` / `uid` / `giftName` / `num` / `price` / `coin_type`。
 * `price` 是**单价**（金瓜子），这里乘上数量得到总价值。
 * 等级字段较弱：有的版本给 `wealth_level`，有的给 `user_level`，都试一下。
 */
export function parseGift(data: unknown, ts: number): Omit<GiftEvent, 'id'> | null {
	const d = obj(data);
	const n = Math.max(1, firstNum(1, d.num, d.gift_num));
	const unitPrice = firstNum(0, d.price, d.discount_price);

	return {
		t: 'gift',
		ts,
		uid: firstNum(0, d.uid),
		uh: firstStr(d.user_hash, d.uid_crc32),
		u: firstStr(d.uname, d.username),
		g: firstStr(d.giftName, d.gift_name, '礼物'),
		n,
		price: unitPrice * n,
		coin: firstStr(d.coin_type, 'gold'),
		lv: firstNum(0, d.wealth_level, d.user_level, d.level),
		guard: firstNum(0, d.guard_level),
		medal: parseMedal(d.medal_info ?? d.medal)
	};
}

/**
 * 解析 SUPER_CHAT_MESSAGE。
 *
 * 用户信息分散在两处，且都可能缺失：
 * - `data.user_info`：`uname`、`face`、`user_level`、`guard_level`、`medal_info`
 * - `data.uinfo`    ：`uname`、`user_level`、`guard_level`、`medal`
 * 因此每个字段都按「uinfo → user_info」的顺序兜底。
 *
 * 主题色也是两组命名，`background_color_start/end/bottom` 与
 * `gradient_start/end`，都试一遍。
 */
export function parseSuperChat(data: unknown, ts: number): Omit<SuperChatEvent, 'id'> | null {
	const d = obj(data);
	const ui = obj(d.user_info);
	const uinfo = obj(d.uinfo);

	const message = firstStr(d.message);
	/* 没有正文的 SC 没有渲染价值（B 站偶尔发空的封面上舰消息） */
	if (!message) return null;

	const start = parseColor(d.background_color_start ?? d.gradient_start ?? d.background_color);
	const end = parseColor(d.background_color_end ?? d.gradient_end ?? d.background_color);
	const bottom = parseColor(
		d.background_bottom_color ?? d.background_color_end ?? d.gradient_end ?? d.background_color
	);

	return {
		t: 'sc',
		ts,
		uid: firstNum(0, d.uid, uinfo.uid, ui.uid),
		uh: firstStr(uinfo.user_hash, d.user_hash, ui.user_hash),
		u: firstStr(uinfo.uname, ui.uname),
		m: message,
		price: firstNum(0, d.price),
		duration: firstNum(0, d.time, d.duration),
		lv: firstNum(0, uinfo.user_level, ui.user_level, ui.level),
		guard: firstNum(0, uinfo.guard_level, ui.guard_level),
		medal: parseMedal(uinfo.medal ?? ui.medal_info ?? d.medal_info),
		/* 主题色缺失时给中性兜底色，保证渲染不会出现 invalid 值 */
		colorStart: start ?? '#4de2ff',
		colorEnd: end ?? '#4de2ff',
		colorBottom: bottom ?? '#4de2ff',
		fontColor: parseColor(d.message_font_color ?? d.font_color) ?? '#ffffff'
	};
}
