/**
 * 弹幕数据源（Svelte 5 runes）：feed.items（最多 MAX_ITEMS 条）、feed.status、
 * feed.realRoom。mock 模式下不连服务端，本地造弹幕以便离线开发。
 */
import { DanmakuClient } from './ws';
import { MockDanmakuSource } from './mock';
import { MAX_CHAT_ITEMS } from '$lib/shared/chat';
import type { DanmakuItem, RoomState, StatusEvent } from '$lib/shared/types';

export interface DanmakuFeedOptions {
	room: string;
	/** 本地 mock，不连服务端 */
	mock?: boolean;
	/** 渲染上限，默认 MAX_CHAT_ITEMS */
	max?: number;
}

export interface DanmakuFeed {
	readonly items: DanmakuItem[];
	readonly status: StatusEvent;
	readonly realRoom: string;
	stop(): void;
}

export function createDanmakuFeed(options: DanmakuFeedOptions): DanmakuFeed {
	const max = options.max ?? MAX_CHAT_ITEMS;

	let items = $state<DanmakuItem[]>([]);
	let status = $state<StatusEvent>({ t: 'status', s: 'idle' });
	/* 真实房间号，服务端解析短号后回填 */
	let realRoom = $state('');
	/* 本地 mock 的事件 id */
	let mockId = 0;

	const push = (event: DanmakuItem): void => {
		/* 整体替换数组：ChatBox 依赖引用变化触发 FLIP */
		items = items.length >= max ? [...items.slice(1 - max + 1), event] : [...items, event];
	};

	/* ---- mock 模式：不连服务端 ---- */
	if (options.mock) {
		const src = new MockDanmakuSource((event) => {
			/* 本地 mock 没有服务端 id，补一个自增 id 供 {#each} 做 key */
			push({ ...event, id: ++mockId });
		});
		src.start();
		status = { t: 'status', s: 'connected', room: 0, host: 'MOCK', live: 1 };
		realRoom = 'MOCK';
		return {
			get items() {
				return items;
			},
			get status() {
				return status;
			},
			get realRoom() {
				return realRoom;
			},
			stop: () => src.stop()
		};
	}

	/* ---- 真实模式 ---- */
	const client = new DanmakuClient({
		room: options.room,
		onHello: (room, latest, echo) => {
			realRoom = String(latest.room ?? room);
			status = latest;
			/* 回显先渲染，再让实时弹幕追加 */
			if (echo.length > 0) items = echo.slice(-max);
		},
		onStatus: (s) => {
			status = s;
			if (s.room) realRoom = String(s.room);
		},
		onItem: push
	});

	const stop = client.start();

	return {
		get items() {
			return items;
		},
		get status() {
			return status;
		},
		get realRoom() {
			return realRoom;
		},
		stop
	};
}

/** 状态 → 中文文案 */
export const STATE_TEXT: Record<RoomState, string> = {
	idle: '未连接',
	connecting: '连接中',
	connected: '已连接',
	reconnecting: '重连中',
	error: '异常'
};
