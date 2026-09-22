/**
 * 聊天框的共享常量、配色与格式化。
 *
 * 放在 shared 而不是组件里，是为了能单测：
 * 颜色散列、舰长映射这类逻辑一旦写错，在深色底上会直接表现为「看不见」。
 */
import type { DanmakuItem, RoomState } from './types';

/** 状态 → 中文文案 */
export const STATE_TEXT: Record<RoomState, string> = {
	idle: '未连接',
	connecting: '连接中',
	connected: '已连接',
	reconnecting: '重连中',
	error: '异常'
};

/**
 * 聊天框「纯弹幕行」的可见行数。
 *
 * 内容区 630px，去掉上下 padding 12px 得可视高 618px；单行实测 33px
 * （16px × 行高 1.6 = 25.6 + 上下 padding 6 + 分隔线 1）→ 618/33 ≈ 18 行。
 * 礼物/SC 行更高（SC 约 61px），混合时更少。
 *
 * 仅作数值留档，渲染不依赖它（靠容器高度自然裁剪）。见 docs/design.md §6.3。
 */
export const VISIBLE_ROWS = 18;

/**
 * DOM 中最多保留的条目数。
 *
 * 取「可见行数的若干倍」而不是固定大数：既要能回溯一点历史，
 * 又要避免 OBS 长时间运行导致 DOM 无限增长。
 */
export const MAX_CHAT_ITEMS = 300;

/**
 * 用户名配色板。
 *
 * 全部是亮色，保证在 #0d1120 这类深底上可读 —— 这也是不用 B 站下发色的原因：
 * 那套颜色面向浅色主题，深底上常看不清。
 */
export const NAME_COLORS = [
	'#4de2ff', // 青
	'#5ef08a', // 绿
	'#ffd93d', // 黄
	'#ff4d9d', // 品红
	'#a78bfa', // 紫
	'#67e8f9', // 浅青
	'#fca5a5', // 浅红
	'#86efac' // 浅绿
] as const;

/**
 * 由用户标识稳定散列出用户名颜色，种子优先级：**user_hash > uid > 昵称**。
 *
 * hash 优先是因为实测未登录观众的 uid 恒为 0 且昵称被打码，只有 user_hash 能区分
 * 不同观众；以 uid 为先会让全场塌成同一个颜色，昵称打码后则大量撞名。
 */
export function nameColor(seed: number | string, name = ''): string {
	const key = typeof seed === 'string' ? seed.trim() : '';

	let h: number;
	if (key) {
		/* user_hash 是数字串（可能超出安全整数），逐字符散列更稳 */
		h = fnv1a(key);
	} else if (seed && Number.isFinite(Number(seed)) && Number(seed) !== 0) {
		/* 乘法散列，避免连续 uid 得到相邻颜色 */
		h = Math.imul(Number(seed), 2654435761) >>> 0;
	} else {
		h = fnv1a(name);
	}
	return NAME_COLORS[h % NAME_COLORS.length];
}

/** FNV-1a 32 位散列 */
function fnv1a(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
	return h;
}

/** 舰长等级 → 名称与配色 */
export const GUARD_META: Record<number, { name: string; color: string }> = {
	1: { name: '总督', color: '#ff5c72' },
	2: { name: '提督', color: '#ff9f43' },
	3: { name: '舰长', color: '#4de2ff' }
};

/** 舰长等级 → 名称，非舰长返回空串 */
export function guardName(guard: number): string {
	return GUARD_META[guard]?.name ?? '';
}

/** 舰长等级 → 颜色，非舰长返回空串 */
export function guardColor(guard: number): string {
	return GUARD_META[guard]?.color ?? '';
}

/** 整数不带小数，非整数保留两位（SC 都是整数元，保留这条以防接入别的数据源） */
export function formatPrice(price: number): string {
	if (!Number.isFinite(price) || price <= 0) return '0';
	return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

/**
 * 从 SC / 礼物主题色里挑一个适合做强调色的。
 * B 站下发的渐变色往往很浅（配它自己的浅色卡片），直接当深色主题的边框会刺眼，
 * 因此取亮度最低的一端。
 */
export function pickAccent(...candidates: string[]): string {
	const valid = candidates.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
	if (valid.length === 0) return '#4de2ff';
	let best = valid[0];
	let bestLum = Number.POSITIVE_INFINITY;
	for (const c of valid) {
		const lum = luminance(c);
		if (lum < bestLum) {
			bestLum = lum;
			best = c;
		}
	}
	return best;
}

/** 相对亮度（sRGB 加权，够用于「谁更暗」的比较） */
export function luminance(hex: string): number {
	const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
	if (!m) return 0;
	const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 一行聊天记录的左侧强调色。必须设在外层 .chat-row 上：CSS 自定义属性只向下继承，
 * 设在子元素上父级的 ::before 色条就拿不到它。
 */
export function itemAccent(item: DanmakuItem): string {
	if (item.t === 'sc') return pickAccent(item.colorBottom, item.colorEnd, item.colorStart);
	return nameColor(item.uh || item.uid, item.u);
}
