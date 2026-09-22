/**
 * 前端 mock 弹幕源（完全离线）。与服务端 mock 共用 $lib/shared/demo-events 的生成逻辑，
 * 避免两边发散（曾因前端只造弹幕，导致 MOCK 模式下礼物/SC 永不出现）：
 * 服务端 mock 验证「WS → 渲染」整条链路，这里用于没有服务端时看样式。
 */
import { createDemoEvent } from '$lib/shared/demo-events';
import type { DanmakuInput } from '$lib/shared/types';

export type MockDanmakuEvent = DanmakuInput;

function randInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
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
