/**
 * /ws 端点：把弹幕推给页面。协议见 docs/design.md §9。
 *
 * 连接时带 ?room=&since=；建立后先发 hello（最新状态 + 当天最近 N 条回显），
 * 之后推 status / danmaku / ping，客户端回 pong 保活。
 */
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, DanmakuItem, ServerMessage } from '$lib/shared/types';
import type { RoomHub, RoomSession } from './hub';
import { createLogger } from './logger';

const log = createLogger('ws');

/** 保活：服务端主动 ping 的间隔 */
const PING_INTERVAL_MS = 20_000;
/** 超过这么久没收到 pong 就断开 */
const PONG_TIMEOUT_MS = 30_000;

export interface WsServerOptions {
	hub: RoomHub;
	/** 默认房间号，连接未指定 ?room= 时使用 */
	defaultRoom: string;
	/** 是否 mock（连接未指定时用默认房间即可，mock 由 Hub 决定） */
}

interface ClientState {
	socket: WebSocket;
	room: string;
	/** 已发送的最大事件 id，用于客户端重连时补发 */
	sentTop: number;
	/** 订阅释放函数 */
	release: (() => void) | null;
	session: RoomSession | null;
	/** 取消事件订阅 */
	unsubBus: (() => void) | null;
	unsubStatus: (() => void) | null;
	alive: boolean;
	pingTimer: NodeJS.Timeout | null;
}

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState !== ws.OPEN) return;
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		/* 连接可能刚好断开 */
	}
}

/** 解析连接 URL 上的参数 */
function parseQuery(url: string | undefined): { room?: string; since: number } {
	if (!url) return { since: 0 };
	try {
		const q = new URL(url, 'http://localhost').searchParams;
		const room = q.get('room')?.trim() || undefined;
		const since = Number(q.get('since')) || 0;
		return { room, since };
	} catch {
		return { since: 0 };
	}
}

export class DanmakuWsServer {
	readonly #wss: WebSocketServer;
	readonly #opt: WsServerOptions;
	#clients = new Set<ClientState>();
	#closed = false;

	constructor(server: HttpServer, options: WsServerOptions) {
		this.#opt = options;
		this.#wss = new WebSocketServer({ noServer: true });

		/* 只接管 /ws 路径的 upgrade，其余交回 SvelteKit */
		server.on('upgrade', (req, socket, head) => {
			let pathname = '/';
			try {
				pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
			} catch {
				/* 忽略 */
			}
			if (pathname !== '/ws') return; // 不处理 → 交给其他 upgrade 监听器

			this.#wss.handleUpgrade(req, socket, head, (ws) => {
				this.#wss.emit('connection', ws, req);
			});
		});

		this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req.url));
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	/** 优雅关闭：通知所有客户端并清理订阅 */
	async close(): Promise<void> {
		this.#closed = true;
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
		client.unsubBus?.();
		client.unsubStatus?.();
		client.release?.();
		if (client.pingTimer) {
			clearInterval(client.pingTimer);
			client.pingTimer = null;
		}
		client.unsubBus = null;
		client.unsubStatus = null;
		client.release = null;
		this.#clients.delete(client);
	}

	#onConnection(ws: WebSocket, url: string | undefined): void {
		const { room: queryRoom, since } = parseQuery(url);
		const room = queryRoom ?? this.#opt.defaultRoom;

		const client: ClientState = {
			socket: ws,
			room,
			sentTop: since,
			release: null,
			session: null,
			unsubBus: null,
			unsubStatus: null,
			alive: true,
			pingTimer: null
		};
		this.#clients.add(client);

		log.debug(`客户端接入 room=${room} since=${since}（当前 ${this.#clients.size} 个）`);

		void this.#attach(client, room, since);

		ws.on('message', (data) => this.#onMessage(client, data));
		ws.on('pong', () => {
			client.alive = true;
		});
		ws.on('close', () => {
			log.debug(`客户端断开 room=${client.room}`);
			this.#cleanup(client);
		});
		ws.on('error', () => this.#cleanup(client));

		/* ping 后等不到 pong 就断开，防止半开连接泄漏 */
		let lastPong = Date.now();
		ws.on('pong', () => {
			lastPong = Date.now();
		});
		client.pingTimer = setInterval(() => {
			if (ws.readyState !== ws.OPEN) return;
			if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
				log.debug(`客户端 room=${client.room} 心跳超时，断开`);
				this.#cleanup(client);
				ws.terminate();
				return;
			}
			ws.ping();
		}, PING_INTERVAL_MS);
	}

	/** 订阅房间并发送 hello */
	async #attach(client: ClientState, room: string, since: number): Promise<void> {
		const { session, release } = this.#opt.hub.acquire(room);
		client.session = session;
		client.release = release;

		/*
		 * 回显与补发互斥：
		 * - since == 0：全新页面没有本地状态 → 给磁盘回显
		 * - since > 0：重连只要错过的 → 绝不能同时回显，否则区间重叠、同一条渲染两次
		 */
		const freshPage = since <= 0;

		/*
		 * 先订阅再读回显，否则「读磁盘」与「开始接收」之间到达的弹幕会丢。
		 * 窗口内到达的事件先缓冲，回显/补发完成后按 id 水位线放行。
		 */
		const pending: DanmakuItem[] = [];
		let ready = false;

		let echo: DanmakuItem[] = [];
		if (freshPage) {
			try {
				echo = await session.echo();
			} catch (err) {
				log.warn(`房间 ${room} 回显读取失败:`, (err as Error).message);
			}
		}

		/* 若会话已经被清理（客户端已离开），不要再订阅 */
		if (!this.#clients.has(client)) {
			release();
			return;
		}

		/* 回显与补发的高水位线：低于等于它的都不再重复发送 */
		let sentTop = echo.at(-1)?.id ?? 0;

		if (!freshPage) {
			const { events } = session.bus.replay(since);
			for (const event of events) send(client.socket, event);
			if (events.length > 0) {
				sentTop = Math.max(sentTop, events[events.length - 1].id);
				log.debug(`房间 ${room} 补发 ${events.length} 条给客户端`);
			}
		}

		send(client.socket, {
			t: 'hello',
			room,
			latest: session.bus.latestStatus,
			echo
		});

		/*
		 * 排空缓冲并在同一个同步块里转为直推。JS 单线程，循环期间不会有新事件插入。
		 */
		client.unsubBus = session.bus.subscribe((event) => {
			if (!ready) {
				pending.push(event);
				return;
			}
			if (event.id <= sentTop) return;
			sentTop = event.id;
			send(client.socket, event);
		});

		for (const event of pending) {
			if (event.id > sentTop) {
				sentTop = event.id;
				send(client.socket, event);
			}
		}
		pending.length = 0;
		client.sentTop = sentTop;
		ready = true;

		/* 状态变更 */
		client.unsubStatus = session.bus.onStatus((status) => {
			send(client.socket, status);
		});
	}

	#onMessage(client: ClientState, data: unknown): void {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(String(data)) as ClientMessage;
		} catch {
			return;
		}

		if (msg.t === 'pong') {
			client.alive = true;
			return;
		}

		if (msg.t === 'subscribe') {
			const nextRoom = msg.room?.trim() || client.room;
			const since = Number(msg.since) || 0;
			if (nextRoom === client.room) {
				/* 同房间只做补发 */
				if (client.session && since < client.session.bus.topId) {
					const { events } = client.session.bus.replay(since);
					for (const event of events) send(client.socket, event);
					client.sentTop = client.session.bus.topId;
				}
				return;
			}
			/* 换房间：先释放旧订阅，再挂到新房间 */
			client.unsubBus?.();
			client.unsubStatus?.();
			client.release?.();
			client.unsubBus = null;
			client.unsubStatus = null;
			client.release = null;
			client.room = nextRoom;
			client.sentTop = since;
			log.debug(`客户端切换房间 → ${nextRoom}`);
			void this.#attach(client, nextRoom, since);
		}
	}
}

/** 在已监听的 http server 上挂载 /ws */
export function attachDanmakuWs(
	server: HttpServer,
	options: WsServerOptions
): DanmakuWsServer {
	if (options == null) throw new Error('attachDanmakuWs 需要 options');
	if (!options.hub) throw new Error('attachDanmakuWs 需要 options.hub');
	const wsServer = new DanmakuWsServer(server, options);
	if (process.env.NODE_ENV !== 'test') {
		log.info('WebSocket 已挂载于 /ws');
	}
	return wsServer;
}
