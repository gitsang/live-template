/**
 * 远程手柄读取器（docs/design.md §21）。
 *
 * 背景：Chromium 只对**聚焦的** frame 轮询 Gamepad API，OBS 的浏览器源是无焦点离屏窗口，
 * 于是「OBS 在前台才读得到手柄」。OBS ≥ 31.0.2 修掉了其中 Windows.Gaming.Input 那一层，
 * 但「源不可见时 rAF 被节流」仍在。因此把采集搬到进程外：Windows 上跑一个小客户端，
 * 它读手柄、只往 /ws/pad 推最新一帧，页面这边订阅即可 —— 与 OBS 是否在前台、是否渲染无关。
 *
 * 两条来源的优先级：**remote 在线就用 remote**，remote 静默超过 PAD_STALE_MS 回落到
 * 浏览器自己的 Gamepad API，再不行就是「无设备」。回落是必要的：没装客户端的人
 * 不该因为这个特性反而丢掉原本能用的本地读取。
 */
import { EMPTY_PAD_STATE, PAD_STALE_MS, sanitizePadState, type PadState } from '$lib/shared/pad';
import type { PadMessage } from '$lib/shared/types';
import {
	GamepadReader,
	sameState,
	type PadListener,
	type PadReader,
	type PadSource
} from './gamepad';
import { PadMockReader } from './pad-mock';

/** 重连退避：与 ws.ts 保持一致（0.5s → 10s，带抖动） */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** 失联检查周期。比 PAD_STALE_MS 小一个量级，保证回落不是「等很久才动」 */
const STALE_CHECK_MS = 400;

/** 默认玩家位 */
const DEFAULT_SLOT = 'p1';

export interface RemotePadOptions {
	/** 玩家位，需与采集端 `--slot` 一致 */
	slot?: string;
	/** 完整 ws 地址；缺省按当前页面推导（dev 与生产都适用） */
	url?: string;
}

/** 按当前页面推导 /ws/pad 地址 */
function defaultUrl(slot: string): string {
	if (typeof location === 'undefined') return '';
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${location.host}/ws/pad?slot=${encodeURIComponent(slot)}`;
}

/** 订阅采集端上报的读取器 */
export class RemotePadReader implements PadReader {
	readonly kind = 'remote' as const;

	readonly #slot: string;
	readonly #url: string | undefined;

	constructor(options: RemotePadOptions = {}) {
		this.#slot = options.slot ?? DEFAULT_SLOT;
		this.#url = options.url;
	}

	start(onChange: PadListener): () => void {
		let stopped = false;
		let socket: WebSocket | null = null;
		let retry = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		/** 最后一次收到帧的时刻（本地时钟） */
		let lastAt = 0;
		let last: PadState = EMPTY_PAD_STATE;
		let greeted = false;

		const emit = (state: PadState): void => {
			if (sameState(last, state)) return;
			last = state;
			onChange(state, 'remote');
		};

		const scheduleReconnect = (): void => {
			const delay = Math.min(RECONNECT_MIN_MS * 2 ** retry, RECONNECT_MAX_MS);
			retry++;
			/* 抖动：多开几个 OBS 源时不要同一刻一起重连 */
			const jitter = delay * 0.2 * Math.random();
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				connect();
			}, delay + jitter);
		};

		const connect = (): void => {
			if (stopped) return;
			const url = this.#url ?? defaultUrl(this.#slot);
			/* SSR 里没有 location：直接不连，客户端挂载后才有意义 */
			if (!url) return;

			const ws = new WebSocket(url);
			socket = ws;

			ws.onopen = () => {
				retry = 0;
			};

			ws.onmessage = (e) => {
				let msg: PadMessage;
				try {
					msg = JSON.parse(String(e.data)) as PadMessage;
				} catch {
					return;
				}
				if (!msg || msg.t !== 'pad' || msg.slot !== this.#slot) return;

				/* 服务端已经洗过一次；这里再洗一次是为了防手改服务端/中间有代理 */
				const state = sanitizePadState(msg.state);
				if (!state) return;

				lastAt = Date.now();
				greeted = true;
				emit(state);
			};

			ws.onclose = () => {
				if (socket === ws) socket = null;
				if (stopped) return;
				scheduleReconnect();
			};

			ws.onerror = () => {
				/* onclose 一定会跟着触发，重连逻辑放在那里 */
			};
		};

		connect();

		/*
		 * 服务端有看门狗，正常情况下「失联」会由它推一帧 connected:false 过来。
		 * 这里再兜一层：服务端整个没了 / 网络断了时，连这一帧都收不到。
		 */
		const staleTimer = setInterval(() => {
			if (!greeted) return;
			if (Date.now() - lastAt <= PAD_STALE_MS) return;
			emit(EMPTY_PAD_STATE);
		}, STALE_CHECK_MS);

		return () => {
			stopped = true;
			clearInterval(staleTimer);
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			socket?.close();
			socket = null;
		};
	}
}

/**
 * 双源复合读取器：remote 优先，remote 静默则回落本地 Gamepad API。
 *
 * 两个读取器都常驻：本地那个本来就一直在跑（改造前就是），多开一份 remote 只是多一条 WS。
 * 用「都跑 + 按新鲜度择优」而不是「动态启停」，是为了避免 start/stop 抖动导致
 * 状态在两条来源之间来回跳。
 */
export class PreferredPadReader implements PadReader {
	#current: PadSource = 'local';

	readonly #remote: PadReader;
	readonly #local: PadReader;

	constructor(remote: PadReader, local: PadReader) {
		this.#remote = remote;
		this.#local = local;
	}

	/** 当前实际在用的来源 */
	get kind(): PadSource {
		return this.#current;
	}

	start(onChange: PadListener): () => void {
		let remoteLive = false;
		let remoteAt = 0;
		let localState: PadState = EMPTY_PAD_STATE;
		let lastState: PadState | null = null;
		let lastSource: PadSource | null = null;

		const emit = (state: PadState, source: PadSource): void => {
			/* 来源变了也要推一次：即使状态相同，UI 的提示文案要跟着换 */
			if (lastSource === source && lastState && sameState(lastState, state)) return;
			lastState = state;
			lastSource = source;
			this.#current = source;
			onChange(state, source);
		};

		const stopRemote = this.#remote.start((state) => {
			remoteAt = Date.now();
			if (state.connected) {
				remoteLive = true;
				emit(state, 'remote');
			} else {
				/* 采集端在线但手柄掉了（或服务端判死）：交回本地，本地也没有就是无设备 */
				remoteLive = false;
				emit(localState, 'local');
			}
		});

		const stopLocal = this.#local.start((state) => {
			localState = state;
			if (!remoteLive) emit(state, 'local');
		});

		const timer = setInterval(() => {
			if (!remoteLive) return;
			if (Date.now() - remoteAt <= PAD_STALE_MS) return;
			remoteLive = false;
			emit(localState, 'local');
		}, STALE_CHECK_MS);

		return () => {
			clearInterval(timer);
			stopRemote();
			stopLocal();
		};
	}
}

export interface PadReaderOptions {
	/** 用脚本化假输入替代真实设备 */
	mock?: boolean;
	/** 远程玩家位 */
	slot?: string;
	/** 远程地址覆盖（调试用） */
	url?: string;
	/** 强制只用本地读取，便于确认「是采集端的问题还是浏览器的问题」 */
	localOnly?: boolean;
}

/**
 * 手柄读取器工厂：mock → 本地 → 远程优先。
 *
 * 调用方（PadBox / 调试页）只依赖 PadReader 接口，三种实现完全可互换，
 * 渲染代码不需要知道数据是从哪来的 —— 只在提示文案上区分。
 */
export function createPadReader(options: PadReaderOptions = {}): PadReader {
	if (options.mock) return new PadMockReader();

	const local = new GamepadReader();
	if (options.localOnly) return local;

	return new PreferredPadReader(new RemotePadReader({ slot: options.slot, url: options.url }), local);
}
