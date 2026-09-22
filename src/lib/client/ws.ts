/**
 * 弹幕 WebSocket 客户端：指数退避重连（0.5s → 10s，带抖动），
 * 重连时带上最后收到的事件 id 让服务端补发遗漏弹幕。
 */
import type { DanmakuItem, ServerMessage, StatusEvent } from '$lib/shared/types';

export interface DanmakuClientHandlers {
	/** 连接建立，拿到回显与最新状态 */
	onHello?(room: string, latest: StatusEvent, echo: DanmakuItem[]): void;
	/** 状态变更 */
	onStatus?(status: StatusEvent): void;
	/** 新条目（弹幕 / 礼物 / SC） */
	onItem?(event: DanmakuItem): void;
}

export interface DanmakuClientOptions extends DanmakuClientHandlers {
	/** 房间号 */
	room: string;
	/** 自定义 WebSocket 地址；默认按当前页面推导 /ws */
	url?: string;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** 按当前页面推导 /ws 地址（dev 与生产都适用） */
function defaultUrl(): string {
	if (typeof location === 'undefined') return 'ws://localhost/ws';
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${location.host}/ws`;
}

export class DanmakuClient {
	#ws: WebSocket | null = null;
	#retry = 0;
	#stopped = false;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** 最后收到的事件 id，重连时用于补发 */
	#lastId = 0;
	/** 是否已经收到过一次 hello（用于区分首次连接与重连） */
	#greeted = false;

	constructor(private readonly opt: DanmakuClientOptions) {}

	/** 最后收到的事件 id */
	get lastId(): number {
		return this.#lastId;
	}

	start(): () => void {
		this.#stopped = false;
		this.#connect();
		return () => this.stop();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		this.#ws?.close();
		this.#ws = null;
	}

	#connect(): void {
		if (this.#stopped) return;

		const base = this.opt.url ?? defaultUrl();
		const params = new URLSearchParams({ room: this.opt.room });
		/* 重连带上水位线让服务端补发；首次连接不带，改用磁盘回显 */
		if (this.#greeted && this.#lastId > 0) params.set('since', String(this.#lastId));

		const ws = new WebSocket(`${base}?${params.toString()}`);
		this.#ws = ws;

		ws.onopen = () => {
			this.#retry = 0;
		};

		ws.onmessage = (e) => {
			let msg: ServerMessage;
			try {
				msg = JSON.parse(String(e.data)) as ServerMessage;
			} catch {
				return;
			}
			this.#dispatch(msg);
		};

		ws.onclose = () => {
			this.#ws = null;
			if (this.#stopped) return;
			this.#scheduleReconnect();
		};

		ws.onerror = () => {
			/* onclose 一定会跟着触发，重连逻辑放在那里 */
		};
	}

	#dispatch(msg: ServerMessage): void {
		switch (msg.t) {
			case 'hello':
				this.#greeted = true;
				/* 回显最后一条的 id 作为水位线，避免与后续实时重复 */
				if (msg.echo.length > 0) {
					this.#lastId = Math.max(this.#lastId, msg.echo[msg.echo.length - 1].id);
				}
				this.opt.onHello?.(msg.room, msg.latest, msg.echo);
				break;
			case 'status':
				this.opt.onStatus?.(msg);
				break;
			case 'danmaku':
			case 'gift':
			case 'sc':
				if (msg.id > this.#lastId) this.#lastId = msg.id;
				this.opt.onItem?.(msg);
				break;
			case 'ping':
				this.#ws?.send(JSON.stringify({ t: 'pong' }));
				break;
		}
	}

	#scheduleReconnect(): void {
		const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.#retry, RECONNECT_MAX_MS);
		this.#retry++;
		/* 抖动，避免多个页面同时重连 */
		const jitter = delay * 0.2 * Math.random();
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#connect();
		}, delay + jitter);
	}
}
