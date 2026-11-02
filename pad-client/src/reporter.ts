/**
 * 上报通道：把 PadState 推到服务端 `/ws/pad`。
 *
 * 只负责「连上、断了重连、能发就发」三件事。丢帧策略很简单：连不上时静默丢弃 ——
 * 手柄状态是**可覆盖的实时量**，补发过期帧没有意义，重连后第一帧自然就是最新的。
 * （这一点与弹幕相反：弹幕是事件流，漏一条就真丢了，所以那边有水位线补发。）
 */
import { WebSocket } from 'ws';
import type { PadMessage } from '../../src/lib/shared/types.ts';

/** 重连退避：0.5s → 10s，带抖动，与页面侧 ws.ts 的节奏保持一致 */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export interface PadReporterOptions {
	/** 完整地址，含 query（role / slot / token） */
	url: string;
	log: (msg: string) => void;
}

export class PadReporter {
	readonly #url: string;
	readonly #log: (msg: string) => void;
	#ws: WebSocket | null = null;
	#retry = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#droppedWhileDown = 0;
	#everUp = false;

	constructor(options: PadReporterOptions) {
		this.#url = options.url;
		this.#log = options.log;
	}

	get connected(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	start(): void {
		this.#stopped = false;
		this.#connect();
	}

	/** 发送一帧；未连接时直接丢弃并计数（恢复时汇报丢了多久） */
	send(msg: PadMessage): void {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			this.#droppedWhileDown++;
			return;
		}
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			this.#droppedWhileDown++;
		}
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#ws?.close();
		this.#ws = null;
	}

	#connect(): void {
		if (this.#stopped) return;

		const ws = new WebSocket(this.#url, { handshakeTimeout: 5000 });
		this.#ws = ws;

		ws.on('open', () => {
			this.#retry = 0;
			this.#everUp = true;
			const dropped = this.#droppedWhileDown;
			this.#droppedWhileDown = 0;
			this.#log(dropped > 0 ? `已连上服务端（断线期间丢弃 ${dropped} 帧）` : '已连上服务端');
		});

		ws.on('close', (code) => {
			if (this.#ws === ws) this.#ws = null;
			if (this.#stopped) return;
			/* 1008 = 口令不对/上报未开启，重连也没用，但保留退避继续试，方便改完配置不用重启 */
			if (code === 1008 && this.#everUp) {
				this.#log('服务端拒绝连接（口令错误或未开启 PAD_TOKEN）');
			}
			this.#schedule();
		});

		ws.on('error', (err) => {
			/* close 一定会跟着触发，这里只记原因，避免重连逻辑写两遍 */
			if (!this.#everUp) this.#log(`连接失败：${err.message}`);
		});
	}

	#schedule(): void {
		const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.#retry, RECONNECT_MAX_MS);
		this.#retry++;
		const jitter = delay * 0.2 * Math.random();
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#connect();
		}, delay + jitter);
	}
}
