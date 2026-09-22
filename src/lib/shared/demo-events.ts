/**
 * 演示事件生成器 —— 服务端 mock 与前端 mock 共用。
 *
 * 曾经两边各写一份，结果前端那份只造弹幕，MOCK=1 时礼物与 SC 永远不出现
 * （页面走前端 mock，根本不连 WS）。不依赖任何 Node/浏览器 API。
 */
import { DEMO_GIFTS, DEMO_LONG_TEXT, DEMO_TEXT, DEMO_USERS } from './demo';
import type { DanmakuInput } from './types';

/** SC 主题色（取自 B 站真实下发的一组配色，用于验证渲染） */
const SC_THEMES = [
	{ start: '#B39DDB', end: '#7E57C2', bottom: '#5E35B1', font: '#FFFFFF' },
	{ start: '#F48FB1', end: '#EC407A', bottom: '#AD1457', font: '#FFFFFF' },
	{ start: '#81D4FA', end: '#29B6F6', bottom: '#0277BD', font: '#FFFFFF' },
	{ start: '#FFCC80', end: '#FFA726', bottom: '#EF6C00', font: '#FFFFFF' }
] as const;

const SC_MESSAGES = [
	'主播加油！这把我压你赢',
	'这个操作太秀了，多来点',
	'第一次上舰，希望越来越好',
	'帮忙看看这个方案可行吗，感谢',
	'蹲一个连麦，等很久了'
] as const;

const MEDALS: Array<[string, number] | null> = [
	null,
	null,
	['七海', 12],
	['航海', 21],
	/* 超长名称：验证粉丝牌会被 Ellipsis 而不是撑破行 */
	['这是一个特别长的粉丝牌名称', 30]
];

function randInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export interface DemoEventOptions {
	/**
	 * 事件序号（从 1 开始）。
	 * 用于让超长弹幕、礼物、SC 按固定节奏出现，而不是纯随机 —— 纯随机
	 * 会让「验证某种渲染」变成碰运气。
	 */
	index: number;
	/** 时间戳，默认取当前时间 */
	ts?: number;
}

/**
 * 生成一条演示事件。
 *
 * 节奏（按 index 取模）：
 * - 每 12 条：一条超长弹幕，用于验证换行
 * - 每 7 条：一条礼物
 * - 每 11 条：一条 SC
 * - 其余：普通弹幕
 * 这样三类内容都会稳定出现，且不会在同一帧挤在一起。
 */
export function createDemoEvent({ index, ts = Date.now() }: DemoEventOptions): DanmakuInput {
	const u = pick(DEMO_USERS);
	const uid = randInt(1000, 99999);
	/*
	 * mock 也带上 user_hash：真实环境里 uid 恒为 0、昵称被打码，
	 * 着色实际靠 hash。若 mock 只给 uid，就测不到「同一个人颜色稳定」这条。
	 */
	const uh = hashOf(u);
	const lv = randInt(1, 60);
	const guard = pick([0, 0, 0, 0, 3, 3, 2, 1]);
	const medal = pick(MEDALS);

	/* 优先保证三类都能出现：礼物与 SC 用取模而不是随机阈值 */
	if (index % 11 === 0) {
		const theme = pick(SC_THEMES);
		return {
			t: 'sc',
			ts,
			uid,
			uh,
			u,
			m: pick(SC_MESSAGES),
			price: pick([30, 50, 100, 500, 1000]),
			duration: pick([60, 120, 300, 600]),
			lv,
			guard,
			medal,
			colorStart: theme.start,
			colorEnd: theme.end,
			colorBottom: theme.bottom,
			fontColor: theme.font
		};
	}

	if (index % 7 === 0) {
		return {
			t: 'gift',
			ts,
			uid,
			uh,
			u,
			g: pick(DEMO_GIFTS),
			n: pick([1, 1, 5, 10, 30, 100]),
			/* price 为 0 表示瓜子礼物（与 B 站免费礼物一致） */
			price: 0,
			coin: pick(['gold', 'silver']),
			lv,
			guard,
			medal
		};
	}

	return {
		t: 'danmaku',
		ts,
		uid,
		uh,
		u,
		m: index % 12 === 0 ? DEMO_LONG_TEXT : pick(DEMO_TEXT),
		color: 0xffffff,
		lv,
		guard,
		medal,
		vip: Math.random() < 0.2,
		admin: Math.random() < 0.05
	};
}

/**
 * 由昵称生成一个稳定的 hash 串，模拟 B 站的 user_hash。
 *
 * 用 FNV-1a：同一个昵称永远得到同一个值，于是 mock 里「同一个人的用户名颜色
 * 始终一致」这条能被验证（这正是真实环境里 user_hash 的作用）。
 */
function hashOf(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
	return String(h);
}
