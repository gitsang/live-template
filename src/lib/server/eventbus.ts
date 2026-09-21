/**
 * 事件总线。
 *
 * 职责：
 * - 给每条事件分配全局自增 id（用于客户端断线补发）
 * - 环形历史（保留最近 N 条，供补发）
 * - 单独保存最新的 status，新连接立刻能拿到正确状态
 *
 * 每个房间一个实例，由 RoomHub 创建。
 */
import type { DanmakuInput, DanmakuItem, StatusEvent } from '$lib/shared/types';

export interface ReplayResult {
	/** 需要补发的事件（已按 id 升序） */
	events: DanmakuItem[];
	/** 当前最大 id */
	top: number;
}

export interface EventBusOptions {
	/** 环形历史保留条数 */
	historySize?: number;
	/** 单次补发上限，避免页面刷新时刷屏 */
	replayMax?: number;
	/** 只补发这么久以内的事件（毫秒） */
	replayWindowMs?: number;
}

type Listener = (event: DanmakuItem) => void;
type StatusListener = (status: StatusEvent) => void;

export class EventBus {
	#nextId = 1;
	#history: Array<{ id: number; event: DanmakuItem; at: number }> = [];
	#listeners = new Set<Listener>();
	#statusListeners = new Set<StatusListener>();
	#latestStatus: StatusEvent;

	readonly #historySize: number;
	readonly #replayMax: number;
	readonly #replayWindowMs: number;

	constructor(options: EventBusOptions = {}) {
		this.#historySize = options.historySize ?? 1000;
		this.#replayMax = options.replayMax ?? 40;
		this.#replayWindowMs = options.replayWindowMs ?? 600_000;
		this.#latestStatus = { t: 'status', s: 'idle' };
	}

	/** 最新状态，供新连接立即同步 */
	get latestStatus(): StatusEvent {
		return this.#latestStatus;
	}

	/** 当前最大事件 id */
	get topId(): number {
		return this.#nextId - 1;
	}

	/** 订阅弹幕事件流 */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 订阅状态变更 */
	onStatus(listener: StatusListener): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	/** 发布弹幕/礼物，返回带 id 的完整事件 */
	publish(event: DanmakuInput): DanmakuItem {
		const id = this.#nextId++;
		const full: DanmakuItem = { ...event, id } as DanmakuItem;

		this.#history.push({ id, event: full, at: Date.now() });
		if (this.#history.length > this.#historySize) this.#history.shift();

		for (const listener of this.#listeners) {
			try {
				listener(full);
			} catch {
				/* 单个订阅者出错不影响其他订阅者 */
			}
		}
		return full;
	}

	/** 发布状态 */
	publishStatus(status: StatusEvent): void {
		this.#latestStatus = status;
		for (const listener of this.#statusListeners) {
			try {
				listener(status);
			} catch {
				/* 忽略 */
			}
		}
	}

	/** 取 since 之后需要补发的事件（受时间窗与条数上限约束） */
	replay(since: number): ReplayResult {
		const now = Date.now();
		let events = this.#history
			.filter((h) => h.id > since && now - h.at < this.#replayWindowMs)
			.map((h) => h.event);

		/* 补发上限：只保留最近 replayMax 条，避免刷屏 */
		if (events.length > this.#replayMax) events = events.slice(-this.#replayMax);

		return { events, top: this.topId };
	}

	/** 清空（房间回收时调用） */
	dispose(): void {
		this.#listeners.clear();
		this.#statusListeners.clear();
		this.#history = [];
	}
}
