/**
 * B 站弹幕 WebSocket 客户端。
 *
 * 一次 run() = 一个会话（连接成功 → 断线结束），由 RoomHub 负责重连退避。
 *
 * 关键点（全部对齐 scripts/danmaku.py 的实测结论）：
 * - 认证包必须带 buvid / support_ack / queue_uuid / scene。
 *   不带 queue_uuid 时，同房间多条连接会被当成同一消费组轮询分流，
 *   每条连接只能拿到一部分弹幕（实测差约 8 倍）。
 * - 用 443 端口而不是 host_list 返回的 wss_port，绕开对 2245/2244 的封锁。
 * - 看门狗：静默超过 75s（含心跳回包）判定为死连接，强制重连。
 *   覆盖「TCP 还活着但服务端一条不给」的场景。
 */
import {
	getBuvid,
	getDanmuInfo,
	getRoomInit,
	type Buvid,
	type DanmuHost
} from './api';
import { OP, decode, encode, parseDanmakuInfo, type Packet } from './packet';
import type { DanmakuInput } from '$lib/shared/types';
import WebSocket from 'ws';
import type { RawData } from 'ws';

/** 未分配 id 的原始事件，id 由事件总线统一发放 */
export type RawEvent = DanmakuInput;

export interface DanmuClientEvents {
	/** 收到一条可落盘的事件 */
	onEvent(event: RawEvent): void;
	/** 状态变更 / 错误 */
	onStatus(status: {
		s: 'connecting' | 'connected' | 'reconnecting' | 'error';
		room?: number;
		live?: number;
		host?: string;
		msg?: string;
	}): void;
}

export interface DanmuClientOptions extends DanmuClientEvents {
	/** 房间号，支持短号 */
	room: string;
	/** 心跳间隔（B 站要求 30s 内至少一次） */
	heartbeatMs?: number;
	/** 静默多久判定死连接 */
	deadAfterMs?: number;
	/** 收包超时，保证循环能及时醒来发心跳 */
	recvTimeoutMs?: number;
	/** 日志 */
	log?: (msg: string, ...args: unknown[]) => void;
}

/** 连接已死（需要重连） */
class DeadConnectionError extends Error {}

/** 队列号：让本连接独占一条投递队列，避免同房间多连接被轮询分流 */
export function randomQueueUuid(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let s = '';
	for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
	return s;
}

export class DanmuClient {
	readonly #opt: Required<Omit<DanmuClientOptions, 'room' | 'log'>> & DanmuClientOptions;

	#ws: WebSocket | null = null;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#stopped = false;

	/** 最近一次收到任何数据的时刻，看门狗用 */
	#lastDataAt = 0;
	/** 认证是否通过 */
	#authed = false;
	/** 认证通过后是否已补发首次心跳 */
	#firstHeartbeatSent = false;

	constructor(options: DanmuClientOptions) {
		this.#opt = {
			heartbeatMs: 25_000,
			deadAfterMs: 75_000,
			recvTimeoutMs: 15_000,
			...options
		};
	}

	/** 请求停止（会关闭当前连接，使 run() 尽快返回） */
	stop(): void {
		this.#stopped = true;
		this.#clearTimers();
		this.#ws?.close();
	}

	#log(msg: string, ...args: unknown[]): void {
		this.#opt.log?.(msg, ...args);
	}

	#clearTimers(): void {
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
	}

	/**
	 * 执行一个完整会话，直到连接断开或 stop()。
	 * 抛出的错误表示需要重连（正常 stop 时直接返回）。
	 */
	async run(): Promise<void> {
		this.#opt.onStatus({ s: 'connecting' });

		/* 1) 解析房间号 */
		const { roomId, liveStatus } = await getRoomInit(this.#opt.room);
		this.#opt.onStatus({ s: 'connecting', room: roomId, live: liveStatus });

		/* 2) 设备指纹 + token/宿主 */
		const buvid = await getBuvid();
		const { token, hosts } = await getDanmuInfo(roomId, buvid);

		/* 3) 依次尝试宿主，全部失败才抛出 */
		let lastError: unknown = null;
		for (const host of hosts.slice(0, 5)) {
			if (this.#stopped) return;
			try {
				await this.#session(host, roomId, token, buvid);
				return; // 正常结束（被 stop 或服务端关闭）
			} catch (err) {
				lastError = err;
				this.#log(`宿主 ${host.host} 连接失败:`, (err as Error).message);
			}
		}
		if (lastError) throw lastError;
	}

	/** 连接单个宿主并跑消息循环 */
	async #session(
		host: DanmuHost,
		roomId: number,
		token: string,
		buvid: Buvid
	): Promise<void> {
		/* 用 443 而不是 host_list 给的 wss_port：某些网络对 2244/2245 不友好 */
		const url = `wss://${host.host}:443/sub`;
		this.#log(`连接 ${url} 房间=${roomId}`);

		const ws = new WebSocket(url, {
			headers: {
				Origin: 'https://live.bilibili.com',
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
					'(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
			}
		});
		this.#ws = ws;

		await new Promise<void>((resolve, reject) => {
			const onOpen = (): void => {
				ws.off('error', onError);
				resolve();
			};
			const onError = (err: Error): void => {
				ws.off('open', onOpen);
				reject(new Error(`WebSocket 打开失败: ${err.message}`));
			};
			ws.once('open', onOpen);
			ws.once('error', onError);
		});

		this.#lastDataAt = Date.now();
		this.#authed = false;
		this.#firstHeartbeatSent = false;

		/* 认证 */
		ws.send(
			encode(
				OP.AUTH,
				JSON.stringify({
					uid: 0,
					roomid: roomId,
					protover: 3,
					platform: 'web',
					type: 2,
					key: token,
					buvid: buvid.b_3,
					support_ack: true,
					queue_uuid: randomQueueUuid(),
					scene: 'room'
				})
			)
		);

		/* 心跳循环 */
		this.#heartbeatTimer = setInterval(() => {
			this.#sendHeartbeatIfPossible();
		}, this.#opt.heartbeatMs);

		try {
			await this.#messageLoop(ws, roomId);
		} finally {
			this.#clearTimers();
			this.#ws = null;
			try {
				ws.close();
			} catch {
				/* 已关闭 */
			}
		}
	}

	/** 消息循环 + 看门狗 */
	async #messageLoop(ws: WebSocket, roomId: number): Promise<void> {
		const queue: Buffer[] = [];
		let wake: (() => void) | null = null;
		let closed = false;
		let failure: Error | null = null;

		const onMessage = (data: RawData): void => {
			this.#lastDataAt = Date.now();
			queue.push(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
			wake?.();
		};
		const onClose = (): void => {
			closed = true;
			wake?.();
		};
		const onError = (): void => {
			failure = new DeadConnectionError('WebSocket 连接错误');
			wake?.();
		};

		ws.on('message', onMessage);
		ws.on('close', onClose);
		ws.on('error', onError);

		try {
			while (!this.#stopped) {
				if (queue.length === 0) {
					/* 等新消息、连接结束，或收包超时（醒来检查看门狗） */
					await new Promise<void>((resolve) => {
						const t = setTimeout(() => {
							wake = null;
							resolve();
						}, this.#opt.recvTimeoutMs);
						wake = () => {
							clearTimeout(t);
							wake = null;
							resolve();
						};
					});
				}

				if (failure) throw failure;
				if (closed) throw new DeadConnectionError('连接已被服务端关闭');

				/* 看门狗：静默太久视为死连接 */
				if (Date.now() - this.#lastDataAt > this.#opt.deadAfterMs) {
					throw new DeadConnectionError(
						`已静默 ${Math.round((Date.now() - this.#lastDataAt) / 1000)} 秒（含心跳回包），判定为死连接`
					);
				}

				const batch = queue.splice(0, queue.length);
				for (const buf of batch) this.#handlePayload(buf, roomId);
			}
		} finally {
			ws.off('message', onMessage);
			ws.off('close', onClose);
			ws.off('error', onError);
		}
	}

	/** 解包并分发 */
	#handlePayload(data: Buffer, roomId: number): void {
		let packets: Packet[];
		try {
			packets = decode(data);
		} catch (err) {
			this.#log('解包失败:', (err as Error).message);
			return;
		}

		for (const pkt of packets) {
			if (pkt.op === OP.AUTH_REPLY) {
				this.#handleAuthReply(pkt);
			} else if (pkt.op === OP.MESSAGE) {
				this.#handleMessage(pkt, roomId);
			}
			/* 心跳回应(op=3) 不需要额外处理，收到即可重置看门狗 */
		}
	}

	/** 认证通过后立即补发一次心跳（与网页端行为一致） */
	#sendHeartbeatIfPossible(): void {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(encode(OP.HEARTBEAT));
	}

	#handleAuthReply(pkt: Packet): void {
		try {
			const reply = JSON.parse(pkt.body.toString('utf8')) as { code?: number };
			if (reply.code === 0) {
				this.#authed = true;
				if (!this.#firstHeartbeatSent) {
					this.#firstHeartbeatSent = true;
					this.#sendHeartbeatIfPossible();
				}
				this.#opt.onStatus({ s: 'connected' });
			} else {
				this.#log('认证失败:', JSON.stringify(reply).slice(0, 200));
			}
		} catch {
			/* 忽略无法解析的回应 */
		}
	}

	#handleMessage(pkt: Packet, roomId: number): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(pkt.body.toString('utf8')) as Record<string, unknown>;
		} catch {
			return;
		}

		const cmd = String(msg.cmd ?? '');
		const ts = Date.now();

		if (cmd.startsWith('DANMU_MSG')) {
			const info = parseDanmakuInfo(msg.info);
			if (!info || !info.text) return;
			this.#opt.onEvent({
				t: 'danmaku',
				ts,
				uid: info.uid,
				u: info.uname,
				m: info.text,
				color: info.color,
				lv: info.level,
				guard: info.guard,
				medal: info.medal,
				vip: info.vip,
				admin: info.admin
			});
			return;
		}

		if (cmd === 'SEND_GIFT') {
			const d = (msg.data ?? {}) as Record<string, unknown>;
			const num = Number(d.num) || 1;
			this.#opt.onEvent({
				t: 'gift',
				ts,
				uid: Number(d.uid) || 0,
				u: String(d.uname ?? ''),
				g: String(d.giftName ?? '礼物'),
				n: num,
				price: (Number(d.price) || 0) * num,
				coin: String(d.coin_type ?? 'gold'),
				lv: Number((d.wealth_level as unknown) ?? 0) || 0,
				guard: Number(d.guard_level) || 0,
				medal: parseMedalInfo(d.medal_info)
			});
			return;
		}

		if (cmd === 'SUPER_CHAT_MESSAGE') {
			const d = (msg.data ?? {}) as Record<string, unknown>;
			const ui = (d.user_info ?? {}) as Record<string, unknown>;
			const uinfo = (d.uinfo ?? {}) as Record<string, unknown>;
			const medalRaw = uinfo.medal ?? ui.medal;

			this.#opt.onEvent({
				t: 'sc',
				ts,
				uid: Number(d.uid) || 0,
				u: String(ui.uname ?? ''),
				m: String(d.message ?? ''),
				price: Number(d.price) || 0,
				duration: Number(d.time) || 0,
				lv: Number(uinfo.user_level ?? 0) || 0,
				guard: Number(uinfo.guard_level ?? 0) || 0,
				medal: parseMedalInfo(medalRaw),
				colorStart: normalizeColor(d.background_color),
				colorEnd: normalizeColor(d.background_color_end),
				colorBottom: normalizeColor(d.background_bottom_color),
				fontColor: normalizeColor(d.background_price_color)
			});
			return;
		}

		/* 其余指令（上舰 / 进房 / 点赞 / 看过）本期忽略 */
		void roomId;
	}
}

/**
 * 解析粉丝牌信息。
 *
 * 弹幕走 info[3]（数组），礼物/SC 走 medal_info / medal（对象），
 * 两种形态都归一成 [名称, 等级]。
 */
function parseMedalInfo(raw: unknown): [string, number] | null {
	if (Array.isArray(raw)) {
		/* 数组形态：info[3] = [等级, 名称, ...] */
		if (raw.length > 1 && raw[1]) return [String(raw[1]), Number(raw[0]) || 0];
		return null;
	}
	if (raw && typeof raw === 'object') {
		const o = raw as Record<string, unknown>;
		const name = o.medal_name ?? o.name;
		const level = o.medal_level ?? o.level;
		if (name) return [String(name), Number(level) || 0];
	}
	return null;
}

/** B 站下发 `#RRGGBB`；异常时回落到中性色，避免渲染出 invalid 值 */
function normalizeColor(raw: unknown): string {
	const s = String(raw ?? '').trim();
	return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#4de2ff';
}
