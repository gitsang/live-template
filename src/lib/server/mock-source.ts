/**
 * Mock 弹幕源：不连 B 站，本地造弹幕。
 *
 * 走与真实采集完全相同的 EventBus/Store 通道，因此整条链路
 * （Hub → 总线 → 落盘 → WS → 渲染）都能在离线环境验证。
 * 词表与 scripts/danmaku.py 的 demo 保持一致。
 */
import { DEMO_LONG_TEXT, DEMO_TEXT, DEMO_USERS } from '$lib/shared/demo';
import type { DanmakuEvent, GiftEvent } from '$lib/shared/types';

export type MockEvent = Omit<DanmakuEvent, 'id'> | Omit<GiftEvent, 'id'>;

/** 随机整数 [min, max] */
function randInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export class MockSource {
	#timer: NodeJS.Timeout | null = null;
	#stopped = false;
	#index = 0;

	constructor(private readonly emit: (event: MockEvent) => void) {}

	start(): void {
		const tick = (): void => {
			if (this.#stopped) return;
			this.#index++;

			/* 每 12 条插一条超长弹幕，用于验证换行 */
			const isLong = this.#index % 12 === 0;
			this.emit({
				t: 'danmaku',
				ts: Date.now(),
				uid: randInt(1000, 99999),
				u: pick(DEMO_USERS),
				m: isLong ? DEMO_LONG_TEXT : pick(DEMO_TEXT),
				color: 0xffffff,
				lv: randInt(1, 60),
				guard: pick([0, 0, 0, 0, 3, 3, 2, 1]),
				medal: pick([null, null, ['七海', 12] as [string, number], ['航海', 21] as [string, number]]),
				vip: Math.random() < 0.2,
				admin: Math.random() < 0.05
			});

			this.#timer = setTimeout(tick, randInt(400, 1600));
		};
		this.#timer = setTimeout(tick, 600);
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}
}
