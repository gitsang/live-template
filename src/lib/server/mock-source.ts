/**
 * Mock 弹幕源：不连 B 站，本地造弹幕/礼物/SC。
 *
 * 走与真实采集完全相同的 EventBus/Store 通道，因此整条链路
 * （Hub → 总线 → 落盘 → WS → 渲染）都能在离线环境验证。
 * 事件生成复用 $lib/shared/demo-events，与前端 mock 是同一份逻辑。
 */
import { createDemoEvent } from '$lib/shared/demo-events';
import type { DanmakuInput } from '$lib/shared/types';

export type MockEvent = DanmakuInput;

/** 随机整数 [min, max] */
function randInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
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
			this.emit(createDemoEvent({ index: this.#index }));
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
