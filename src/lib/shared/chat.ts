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
 * 由 uid 稳定散列出一个用户名颜色。
 *
 * 同一个 uid 永远得到同一个颜色（观众能形成「这个颜色是谁」的记忆），
 * 且相邻 uid 会落到不同颜色上（乘 2654435761 是一个常见的散列乘子）。
 * uid 缺失/为 0 时退回昵称散列，保证异常数据也稳定。
 */
export function nameColor(uid: number, name = ''): string {
	let h: number;
	if (uid && Number.isFinite(uid)) {
		/* Knuth 乘法散列，避免连续 uid 得到相邻颜色 */
		h = Math.imul(uid, 2654435761) >>> 0;
	} else {
		h = 2166136261;
		for (let i = 0; i < name.length; i++) {
			h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
		}
	}
	return NAME_COLORS[h % NAME_COLORS.length];
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

/**
 * 金额展示：整数不带小数，非整数保留两位。
 * SC 价格都是整数元，但保留这条以防后续接 B 站以外的数据源。
 */
export function formatPrice(price: number): string {
	if (!Number.isFinite(price) || price <= 0) return '0';
	return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

/**
 * 从 SC / 礼物主题色里挑一个适合做强调色的。
 *
 * B 站下发的 SC 渐变色往往很浅（为了配它自己的浅色卡片），
 * 直接拿来当深色主题的边框/色条会刺眼，因此取亮度最低的一端。
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
 * 一行聊天记录的左侧强调色。
 *
 * 必须由外层 `.chat-row` 使用：CSS 自定义属性只向下继承，
 * 若把 --row-accent 设在子元素上，父级的 ::before 色条拿不到它。
 */
export function itemAccent(item: DanmakuItem): string {
	if (item.t === 'sc') return pickAccent(item.colorBottom, item.colorEnd, item.colorStart);
	return nameColor(item.uid, item.u);
}
