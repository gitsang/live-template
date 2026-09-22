/**
 * 房间注册表（RoomHub）。
 *
 * 多房间懒加载 + 引用计数 + 空闲断开：
 * - acquire(room) 客户端订阅时调用，无会话则创建并连 B 站，计数 +1
 * - release(room) 客户端离开时调用，计数 -1
 * - 计数归零后等 idleMs（默认 60s）再断开，避免 OBS 切场景时频繁重连
 *
 * 每个房间持有：DanmuClient（采集）+ EventBus（广播/补发）+ DanmakuStore（落盘/回显）
 */
import { DanmuClient } from './bili/client';
import { EventBus } from './eventbus';
import { DanmakuStore } from './store';
import { createLogger } from './logger';
import type { DanmakuItem, StatusEvent } from '$lib/shared/types';

const log = createLogger('hub');

/** 重连退避：5s 起，逐步涨到 30s */
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 30_000;

export interface RoomHubOptions {
	/** JSONL 落盘目录 */
	dataDir: string;
	/** 引用计数归零后多久断开 */
	idleMs: number;
	/** 新客户端回显条数 */
	echoCount: number;
	/** 强制 mock（不连 B 站） */
	mock: boolean;
	/** B 站登录态 Cookie（可选，留空匿名） */
	loginCookie?: string;
}

export class RoomSession {
	readonly room: string;
	readonly bus = new EventBus();
	readonly store: DanmakuStore;

	#client: DanmuClient | null = null;
	#mockTimer: NodeJS.Timeout | null = null;
	#retry = 0;
	#refs = 0;
	#idleTimer: NodeJS.Timeout | null = null;
	#stopped = false;
	/**
	 * 会话代次。
	 *
	 * 用于作废旧连接的收尾逻辑：`run()` 的 `.finally()` 会在连接真正关闭后
	 * （异步）决定要不要重连。如果期间我们主动重连过一次，旧回调看到
	 * `#stopped` 已被重置为 `false`，就会再安排一次重连 —— 结果两条连接同时活着。
	 * 每次主动重连都给代次 +1，旧回调对不上号就直接放弃。
	 */
	#epoch = 0;
	/** 真实房间号（B 站解析后） */
	#realRoom: number | null = null;

	constructor(
		room: string,
		readonly opt: RoomHubOptions
	) {
		this.room = room;
		this.store = new DanmakuStore({ dataDir: opt.dataDir, room });
	}

	get refs(): number {
		return this.#refs;
	}

	get realRoom(): number | null {
		return this.#realRoom;
	}

	get state(): StatusEvent {
		return this.bus.latestStatus;
	}

	/** 被引用 +1，必要时启动采集（空闲断开后可再次启动） */
	acquire(): void {
		this.#refs++;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
			log.debug(`房间 ${this.room} 空闲断开已取消（有新客户端）`);
		}
		if (!this.#running) this.#start();
	}

	/** 采集是否正在运行 */
	get #running(): boolean {
		return this.#client !== null || this.#mockTimer !== null || this.#mockStop !== null;
	}

	/** 被引用 -1，归零后安排空闲断开 */
	release(): void {
		this.#refs = Math.max(0, this.#refs - 1);
		if (this.#refs > 0 || this.#idleTimer || this.#stopped) return;

		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			if (this.#refs > 0) return;
			log.info(`房间 ${this.room} 空闲 ${this.opt.idleMs}ms，断开采集`);
			this.stop();
		}, this.opt.idleMs);
	}

	/** 回显：读当天 JSONL 的最近若干条弹幕 */
	async echo(): Promise<DanmakuItem[]> {
		return this.store.readEcho(this.opt.echoCount);
	}

	#start(): void {
		this.#stopped = false;
		this.#retry = 0;
		/*
		 * 每次启动都递增代次：这会作废所有更早连接的收尾逻辑。
		 * 除了「登录后重连」，它还修掉了一个早已存在的竞态：
		 * 空闲断开（stop）后若立刻 acquire()，旧连接的 `.finally()` 可能尚未执行，
		 * 此时 `#stopped` 已被重置为 false，旧回调就会再安排一次重连
		 * —— 于是两条连接同时活着，弹幕重复。
		 */
		this.#epoch++;
		/* 空闲断开后复用的 Store 需要重新打开 */
		this.store.reopen();
		this.bus.publishStatus({ t: 'status', s: 'connecting' });

		if (this.opt.mock) {
			this.#startMock();
			return;
		}
		this.#runClient();
	}

	/** 起一次会话；结束后按退避重连 */
	#runClient(): void {
		const epoch = this.#epoch;
		const client = new DanmuClient({
			room: this.room,
			loginCookie: this.opt.loginCookie,
			log: (msg, ...args) => log.debug(`[${this.room}] ${msg}`, ...args),
			onStatus: (s) => {
				/* 记录真实房间号，落盘目录与状态都改用它 */
				if (s.room && s.room !== this.#realRoom) {
					this.#realRoom = s.room;
					this.store.setRealRoom(s.room);
				}
				if (s.s === 'connected') this.#retry = 0;
				this.bus.publishStatus({
					t: 'status',
					s: s.s,
					room: s.room ?? this.#realRoom ?? undefined,
					live: s.live,
					host: s.host,
					msg: s.msg
				});
			},
			onEvent: (event) => {
				const full = this.bus.publish(event);
				this.store.append(full);
			}
		});

		this.#client = client;

		client
			.run()
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn(`房间 ${this.room} 会话结束: ${msg}`);
				this.bus.publishStatus({ t: 'status', s: 'error', room: this.#realRoom ?? undefined, msg });
			})
			.finally(() => {
				this.#client = null;
				/* 代次变了说明已经被主动重连/停止接管，旧回调不能再插手 */
				if (epoch !== this.#epoch) return;
				if (this.#stopped || this.#refs === 0) return;

				/* 指数退避重连；token 过期会由 run() 内部重新走全流程 */
				this.#retry++;
				const delay = Math.min(RECONNECT_MIN_MS * 2 ** (this.#retry - 1), RECONNECT_MAX_MS);
				this.bus.publishStatus({
					t: 'status',
					s: 'reconnecting',
					room: this.#realRoom ?? undefined
				});
				log.info(`房间 ${this.room} ${delay}ms 后重连（第 ${this.#retry} 次）`);
				this.#mockTimer = setTimeout(() => {
					this.#mockTimer = null;
					if (epoch !== this.#epoch) return;
					if (this.#stopped || this.#refs === 0) return;
					this.#runClient();
				}, delay);
			});
	}

	/** mock：不连 B 站，本地造弹幕，走与真实采集完全相同的通道 */
	#startMock(): void {
		/* 落盘目录仍用请求的房间号，只是状态里标注 room:0 / host:MOCK */
		this.bus.publishStatus({ t: 'status', s: 'connected', room: 0, host: 'MOCK', live: 1 });
		log.info(`房间 ${this.room} 使用 mock 弹幕源`);

		const epoch = this.#epoch;
		void import('./mock-source').then(({ MockSource }) => {
			/* 动态 import 是异步的：期间可能已经 stop() 或重连，此时不能再启动 */
			if (epoch !== this.#epoch) return;
			const src = new MockSource((event) => {
				const full = this.bus.publish(event);
				this.store.append(full);
			});
			src.start();
			this.#mockStop = () => src.stop();
		});
	}

	#mockStop: (() => void) | null = null;

	/**
	 * 登录态变化后重连，使新身份生效。
	 *
	 * 必须断开重连而不能「就地换 Cookie」：登录态是在认证包（op=7）里
	 * 一次性发出的，已经建立的连接无法中途改变身份。
	 *
	 * 未在运行（refs 为 0 或已停止）时只需等下次 acquire() 自然使用新值，
	 * 不必主动连一次——那会在没人看直播时凭空产生一次 B 站连接。
	 */
	reloadAuth(): void {
		if (!this.#running) return;
		log.info(`房间 ${this.room} 登录态更新，重连以生效`);
		this.stop();
		/* stop() 会置 #stopped，这里重新起一次；refs 保持不变。
		 * #start() 内部会递增代次，旧连接的收尾逻辑因此失效。 */
		this.#start();
	}

	/** 停止采集并落盘。之后再次 acquire() 可以重新启动。 */
	stop(): void {
		this.#stopped = true;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
		if (this.#mockTimer) {
			clearTimeout(this.#mockTimer);
			this.#mockTimer = null;
		}
		this.#mockStop?.();
		this.#mockStop = null;
		this.#client?.stop();
		this.#client = null;
		this.bus.publishStatus({ t: 'status', s: 'idle', room: this.#realRoom ?? undefined });
		void this.store.close();
	}
}

export class RoomHub {
	#rooms = new Map<string, RoomSession>();
	readonly #opt: RoomHubOptions;

	constructor(options: RoomHubOptions) {
		this.#opt = options;
	}

	/**
	 * 更新登录态并让正在运行的会话重连，使扫码结果**无需重启服务**即生效。
	 *
	 * 注意 `#opt` 是**按引用**传给每个 RoomSession 的（见构造函数），
	 * 所以改这里的字段，所有会话（含之后新建的）都会看到新值。
	 * 这不是巧合而是选择：登录态属于整个进程，不是某个房间的私有配置。
	 * 换来的一点代价是——就地修改共享对象不够显式，故在此写明。
	 */
	reloadAuth(loginCookie: string): void {
		this.#opt.loginCookie = loginCookie;
		for (const session of this.#rooms.values()) session.reloadAuth();
	}

	/** 当前是否已配置登录态（不校验有效性，仅表示「有没有传进来」） */
	get hasAuth(): boolean {
		return Boolean(this.#opt.loginCookie?.trim());
	}

	/** 订阅一个房间，返回释放函数 */
	acquire(room: string): { session: RoomSession; release: () => void } {
		let session = this.#rooms.get(room);
		if (!session) {
			session = new RoomSession(room, this.#opt);
			this.#rooms.set(room, session);
			log.info(`创建房间会话 ${room}`);
		}
		session.acquire();

		let released = false;
		return {
			session,
			release: () => {
				if (released) return;
				released = true;
				session!.release();
			}
		};
	}

	/** 当前活跃房间数 */
	get size(): number {
		return this.#rooms.size;
	}

	/**
	 * 取已存在的会话，不存在则返回 undefined（不创建）。
	 * 自检接口用它注入测试弹幕，避免为了自检意外连上 B 站。
	 */
	peek(room: string): RoomSession | undefined {
		return this.#rooms.get(room);
	}

	/** 健康检查快照 */
	snapshot(): Array<{ room: string; refs: number; state: StatusEvent }> {
		return [...this.#rooms.values()].map((s) => ({
			room: s.room,
			refs: s.refs,
			state: s.state
		}));
	}

	/** 进程退出时清理 */
	async closeAll(): Promise<void> {
		for (const session of this.#rooms.values()) session.stop();
		this.#rooms.clear();
	}
}
