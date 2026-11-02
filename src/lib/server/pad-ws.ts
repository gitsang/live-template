/**
 * `/ws/pad` 端点：采集端上报手柄状态，页面只读订阅。协议见 docs/design.md §21。
 *
 * 一条路径两种角色，由 `?role=` 区分：
 * - `role=pub&token=…&slot=p1` 采集端：只上行，需要 PAD_TOKEN；
 * - 缺省（只读）页面：接入时先收一遍各 slot 的最新帧，之后跟着广播走。
 *
 * 为什么不复用 `/ws`：`/ws` 按房间订阅并带断线补发水位线，而手柄与房间无关、
 * 也不需要补发（只关心最新一帧）。混进去会把两套生命周期搅在一起。
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	PAD_MAX_PAYLOAD,
	PAD_MAX_RATE,
	PAD_SLOT_PATTERN,
	sanitizePadState
} from '$lib/shared/pad';
import type { PadMessage } from '$lib/shared/types';
import { safeEqual } from './credential';
import type { PadHub } from './pad-hub';
import { createLogger } from './logger';

const log = createLogger('pad');

/** 保活：与 /ws 保持一致的节奏 */
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 30_000;

/** 未指定 slot 时的默认玩家位 */
const DEFAULT_SLOT = 'p1';

export interface PadWsOptions {
	padHub: PadHub;
	/** 采集端口令。留空 = 关闭上报（只读订阅仍可用），与 LOGIN_TOKEN 的取法一致 */
	token: string;
}

type Role = 'pub' | 'sub';

interface ClientState {
	socket: WebSocket;
	role: Role;
	slot: string;
	/** 上行令牌桶 */
	tokens: number;
	lastRefill: number;
	/** 被限流丢弃的包数（仅在恢复时打一次日志，避免刷屏） */
	dropped: number;
	alive: boolean;
	pingTimer: NodeJS.Timeout | null;
	unsub: (() => void) | null;
	/** 是否已经打过「首帧」日志 */
	greeted: boolean;
}

/** 令牌桶：每连接一份，按秒回填 */
function takeToken(client: ClientState): boolean {
	const now = Date.now();
	client.tokens = Math.min(
		PAD_MAX_RATE,
		client.tokens + ((now - client.lastRefill) / 1000) * PAD_MAX_RATE
	);
	client.lastRefill = now;
	if (client.tokens < 1) {
		client.dropped++;
		return false;
	}
	client.tokens -= 1;
	return true;
}

function send(ws: WebSocket, msg: PadMessage): void {
	if (ws.readyState !== ws.OPEN) return;
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		/* 连接可能刚好断开 */
	}
}

function parseQuery(url: string | undefined): { role: Role; slot: string; token: string } {
	let role: Role = 'sub';
	let slot = DEFAULT_SLOT;
	let token = '';
	if (!url) return { role, slot, token };
	try {
		const q = new URL(url, 'http://localhost').searchParams;
		if (q.get('role') === 'pub') role = 'pub';
		const raw = q.get('slot')?.trim();
		if (raw && PAD_SLOT_PATTERN.test(raw)) slot = raw;
		token = q.get('token')?.trim() ?? '';
	} catch {
		/* 非法 URL 按只读处理 */
	}
	return { role, slot, token };
}

export class PadWsServer {
	readonly #wss: WebSocketServer;
	readonly #opt: PadWsOptions;
	readonly #clients = new Set<ClientState>();

	constructor(server: HttpServer, options: PadWsOptions) {
		this.#opt = options;
		this.#wss = new WebSocketServer({ noServer: true, maxPayload: PAD_MAX_PAYLOAD });

		server.on('upgrade', (req, socket, head) => {
			let pathname = '/';
			try {
				pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
			} catch {
				/* 忽略 */
			}
			if (pathname !== '/ws/pad') return; // 不是我们的路径，交给其他 upgrade 监听器

			this.#wss.handleUpgrade(req, socket, head, (ws) => {
				this.#wss.emit('connection', ws, req);
			});
		});

		this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
	}

	get publisherCount(): number {
		let n = 0;
		for (const c of this.#clients) if (c.role === 'pub') n++;
		return n;
	}

	async close(): Promise<void> {
		for (const client of [...this.#clients]) {
			this.#cleanup(client);
			try {
				client.socket.close(1001, 'server shutting down');
			} catch {
				/* 忽略 */
			}
		}
		this.#clients.clear();
		await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
	}

	#cleanup(client: ClientState): void {
		client.unsub?.();
		client.unsub = null;
		if (client.pingTimer) {
			clearInterval(client.pingTimer);
			client.pingTimer = null;
		}
		this.#clients.delete(client);
	}

	#onConnection(ws: WebSocket, req: IncomingMessage): void {
		const { role, slot, token } = parseQuery(req.url);

		if (role === 'pub') {
			if (!this.#opt.token) {
				/* 不隐式放行：没配口令就是没开这个功能，而不是「默认谁都能推」 */
				log.warn('拒绝手柄上报：未配置 PAD_TOKEN（环境变量或 config.json）');
				ws.close(1008, 'pad publishing disabled: PAD_TOKEN not configured');
				return;
			}
			if (!safeEqual(token, this.#opt.token)) {
				log.warn(
					`拒绝手柄上报：口令不匹配（来自 ${req.socket.remoteAddress ?? '未知地址'}）`
				);
				ws.close(1008, 'invalid pad token');
				return;
			}
		}

		const client: ClientState = {
			socket: ws,
			role,
			slot,
			tokens: PAD_MAX_RATE,
			lastRefill: Date.now(),
			dropped: 0,
			alive: true,
			pingTimer: null,
			unsub: null,
			greeted: false
		};
		this.#clients.add(client);

		if (role === 'pub') {
			log.info(`采集端接入 slot=${slot}（来自 ${req.socket.remoteAddress ?? '未知地址'}）`);
		} else {
			/* 先把各 slot 的当前帧发一遍，页面不必空等到下一次按键 */
			for (const msg of this.#opt.padHub.latestAll()) send(ws, msg);
			client.unsub = this.#opt.padHub.subscribe((msg) => send(ws, msg));
			log.debug(`手柄订阅者接入（当前 ${this.#clients.size} 个连接）`);
		}

		ws.on('message', (data) => this.#onMessage(client, data));
		ws.on('close', () => {
			if (role === 'pub') log.info(`采集端断开 slot=${slot}`);
			this.#cleanup(client);
		});
		ws.on('error', () => this.#cleanup(client));

		let lastPong = Date.now();
		ws.on('pong', () => {
			client.alive = true;
			lastPong = Date.now();
		});
		client.pingTimer = setInterval(() => {
			if (ws.readyState !== ws.OPEN) return;
			if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
				log.debug('手柄连接心跳超时，断开');
				this.#cleanup(client);
				ws.terminate();
				return;
			}
			ws.ping();
		}, PING_INTERVAL_MS);
		client.pingTimer.unref?.();
	}

	#onMessage(client: ClientState, data: unknown): void {
		/* 只读连接不该上行；发什么都不理，也不回应，省得被当探针 */
		if (client.role !== 'pub') return;

		if (!takeToken(client)) {
			/* 限流只在「首次丢弃」和「恢复」时各打一次，避免被刷日志 */
			if (client.dropped === 1) {
				log.warn(`slot=${client.slot} 上报速率超过 ${PAD_MAX_RATE}/s，开始丢弃`);
			}
			return;
		}
		if (client.dropped > 1) {
			log.debug(`slot=${client.slot} 上报速率恢复（累计丢弃 ${client.dropped} 包）`);
			client.dropped = 0;
		}

		let raw: unknown;
		try {
			raw = JSON.parse(String(data));
		} catch {
			return;
		}
		if (raw == null || typeof raw !== 'object') return;
		const msg = raw as Record<string, unknown>;
		if (msg.t !== 'pad') return;

		/* 洗数据：外部进程喂进来的东西不能直接进渲染 */
		const state = sanitizePadState(msg.state);
		if (!state) return;

		const slot =
			typeof msg.slot === 'string' && PAD_SLOT_PATTERN.test(msg.slot)
				? msg.slot
				: client.slot;
		const seq = typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : 0;

		this.#opt.padHub.publish(slot, state, seq);

		if (!client.greeted) {
			client.greeted = true;
			log.info(
				`slot=${slot} 开始上报：${state.connected ? state.id || '未知设备' : '未检测到手柄'}`
			);
		}
	}
}

/** 在已监听的 http server 上挂载 /ws/pad */
export function attachPadWs(server: HttpServer, options: PadWsOptions): PadWsServer {
	if (options == null) throw new Error('attachPadWs 需要 options');
	if (!options.padHub) throw new Error('attachPadWs 需要 options.padHub');

	const wsServer = new PadWsServer(server, options);
	if (process.env.NODE_ENV === 'test') return wsServer;

	if (options.token) {
		log.info('手柄上报已挂载于 /ws/pad（采集端需带 PAD_TOKEN）');
	} else {
		log.info('手柄上报未开启（未设置 PAD_TOKEN）；/ws/pad 只接受只读订阅');
	}
	return wsServer;
}
