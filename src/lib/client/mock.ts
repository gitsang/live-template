/**
 * 前端 mock 弹幕源（离线开发用）。
 *
 * 与服务端的 mock-source 分开：服务端 mock 用于验证「WS → 渲染」整条链路，
 * 这里用于完全没有服务端时也能看样式。
 */
import { DEMO_LONG_TEXT, DEMO_TEXT, DEMO_USERS } from '$lib/shared/demo';
import type { DanmakuInput } from '$lib/shared/types';

export type MockDanmakuEvent = DanmakuInput;

function randInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export class MockDanmakuSource {
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#index = 0;

	constructor(private readonly emit: (event: DanmakuInput) => void) {}

	start(): void {
		const tick = (): void => {
			if (this.#stopped) return;
			this.#index++;
			this.emit({
				t: 'danmaku',
				ts: Date.now(),
				uid: randInt(1000, 99999),
				u: pick(DEMO_USERS),
				m: this.#index % 12 === 0 ? DEMO_LONG_TEXT : pick(DEMO_TEXT),
				color: 0xffffff,
				lv: randInt(1, 60),
				guard: pick([0, 0, 0, 0, 3, 3, 2, 1]),
				medal: pick([null, null, ['七海', 12] as [string, number]]),
				vip: Math.random() < 0.2,
				admin: Math.random() < 0.05
			});
			this.#timer = setTimeout(tick, randInt(400, 1600));
		};
		this.#timer = setTimeout(tick, 500);
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}
}
