/**
 * 手柄状态中枢：采集端上报 → 内存只保留每个 slot 的最新一帧 → 广播给订阅的页面。
 *
 * 与 RoomHub 的区别：手柄**不进历史、不做补发**。页面只关心「现在按着什么」，
 * 补发一串过期帧反而会让画面错乱；因此这里只有「最新一帧 + 看门狗」。
 *
 * 看门狗在服务端做，而不是交给页面：采集端崩溃/断网时 TCP 可能半开，
 * 不主动判死就会永远显示最后一帧的按键状态（画面卡在「A 键按住」）。
 */
import { EMPTY_PAD_STATE, PAD_STALE_MS, type PadState } from '$lib/shared/pad';
import type { PadMessage } from '$lib/shared/types';
import { createLogger } from './logger';

const log = createLogger('pad');

/** 看门狗扫描周期：比失效窗口小一个量级，保证判死延迟不超过 ~1s */
const WATCHDOG_MS = 500;

/** 同时存在的玩家位上限。仅是防呆，正常只会有 1–2 个。 */
const MAX_SLOTS = 8;

interface SlotEntry {
	state: PadState;
	/** 服务端最后一次收到该 slot 上报的时刻（不信任客户端时钟） */
	at: number;
	seq: number;
}

export type PadSlotListener = (msg: PadMessage) => void;

/** 对外快照（/api/health 与日志用），不含完整按键表 */
export interface PadSlotInfo {
	slot: string;
	connected: boolean;
	id: string;
	/** 最后一次收包的服务端时刻 */
	at: number;
	seq: number;
}

export class PadHub {
	readonly #slots = new Map<string, SlotEntry>();
	readonly #listeners = new Set<PadSlotListener>();
	#timer: NodeJS.Timeout | null = null;
	#closed = false;

	constructor(private readonly staleMs: number = PAD_STALE_MS) {}

	/** 写入一帧并广播；slot 超限时返回 null（调用方据此丢弃） */
	publish(slot: string, state: PadState, seq = 0): PadMessage | null {
		if (this.#closed) return null;
		if (!this.#slots.has(slot) && this.#slots.size >= MAX_SLOTS) {
			log.warn(`手柄 slot 已达上限 ${MAX_SLOTS}，丢弃 slot=${slot} 的上报`);
			return null;
		}

		const msg: PadMessage = { t: 'pad', slot, seq, ts: Date.now(), state };
		this.#slots.set(slot, { state, at: msg.ts, seq });
		this.#ensureWatchdog();
		this.#emit(msg);
		return msg;
	}

	/** 订阅广播；返回取消函数 */
	subscribe(fn: PadSlotListener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** 新订阅者接入时的当前值：每个 slot 一帧，让页面不必等下一帧 */
	latestAll(): PadMessage[] {
		return [...this.#slots].map(([slot, entry]) => ({
			t: 'pad' as const,
			slot,
			seq: entry.seq,
			ts: entry.at,
			state: entry.state
		}));
	}

	snapshot(): PadSlotInfo[] {
		return [...this.#slots].map(([slot, entry]) => ({
			slot,
			connected: entry.state.connected,
			id: entry.state.id,
			at: entry.at,
			seq: entry.seq
		}));
	}

	/** 是否有采集端在线（health 用） */
	get activeCount(): number {
		return this.snapshot().filter((s) => s.connected).length;
	}

	close(): void {
		this.#closed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		this.#listeners.clear();
		this.#slots.clear();
	}

	#emit(msg: PadMessage): void {
		for (const fn of this.#listeners) {
			try {
				fn(msg);
			} catch (err) {
				/* 单个订阅者出错不能拖垮其他人（例如某个页面连接刚好在关闭） */
				log.warn('手柄广播失败:', (err as Error).message);
			}
		}
	}

	/**
	 * 惰性启动看门狗：只有真的有人上报过才开定时器，且 unref 掉 ——
	 * 手柄通道不该成为阻止进程退出的理由。
	 */
	#ensureWatchdog(): void {
		if (this.#timer || this.#closed) return;
		this.#timer = setInterval(() => this.#sweep(), WATCHDOG_MS);
		this.#timer.unref?.();
	}

	#sweep(): void {
		const now = Date.now();
		for (const [slot, entry] of this.#slots) {
			if (!entry.state.connected) continue;
			if (now - entry.at <= this.staleMs) continue;

			/* 保留 id：判死时还能看出「是哪只手柄掉的」，方便排障 */
			const stale: PadState = {
				...EMPTY_PAD_STATE,
				id: entry.state.id,
				buttons: {}
			};
			const msg: PadMessage = { t: 'pad', slot, seq: entry.seq, ts: now, state: stale };
			this.#slots.set(slot, { state: stale, at: entry.at, seq: entry.seq });
			log.info(`手柄 slot=${slot} 超过 ${this.staleMs}ms 无上报，标记为断开`);
			this.#emit(msg);
		}
	}
}
