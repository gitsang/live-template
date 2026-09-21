/**
 * JSONL 落盘与回显。
 *
 * - 按天分文件：`<dataDir>/room-<id>/<YYYY-MM-DD>.jsonl`，逐行 append，崩溃安全
 * - 「当天」按**本地时区**判定，容器内必须设 TZ=Asia/Shanghai，否则跨零点会错位
 * - 回显：新客户端连接时读当天文件末尾若干条，因此**重启服务后依然能回显**
 *
 * 写入采用「排队 + 批量 flush」，避免每条弹幕都触发一次 fs 调用。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { DanmakuEvent, DanmakuItem } from '$lib/shared/types';
import { createLogger } from './logger';

const log = createLogger('store');

/** 本地时区的 YYYY-MM-DD */
export function localDateKey(ts: number = Date.now()): string {
	const d = new Date(ts);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 房间目录名 */
function roomDir(dataDir: string, room: string): string {
	/* 房间号做一次白名单清洗，避免任何路径穿越 */
	const safe = room.replace(/[^0-9a-zA-Z_-]/g, '');
	return join(dataDir, `room-${safe}`);
}

export interface StoreOptions {
	dataDir: string;
	/** 房间号（原始输入，可能是短号） */
	room: string;
	/** 写入批量 flush 间隔 */
	flushMs?: number;
	/** 单批最大条数 */
	batchSize?: number;
}

export class DanmakuStore {
	readonly #opt: Required<StoreOptions>;
	#buffer: DanmakuItem[] = [];
	#timer: NodeJS.Timeout | null = null;
	#dirReady = false;
	#closed = false;

	/** 解析出的真实房间号，落盘目录用它 */
	#realRoom: string;

	constructor(options: StoreOptions) {
		this.#opt = { flushMs: 500, batchSize: 200, ...options };
		this.#realRoom = options.room;
	}

	/** 房间号解析出真实 id 后调用，切换落盘目录 */
	setRealRoom(roomId: number | string): void {
		const next = String(roomId);
		if (next === this.#realRoom) return;
		/* 目录变了，先把旧缓冲落盘，避免写错文件 */
		void this.flush();
		this.#realRoom = next;
		this.#dirReady = false;
	}

	/** 当前落盘文件路径（调试/健康检查用） */
	filePath(at: number = Date.now()): string {
		return join(roomDir(this.#opt.dataDir, this.#realRoom), `${localDateKey(at)}.jsonl`);
	}

	/** 追加一条事件（内存排队，异步落盘） */
	append(item: DanmakuItem): void {
		if (this.#closed) return;
		/* 空闲断开后可能重新启用，这里也顺手复位 */
		this.#buffer.push(item);

		if (this.#buffer.length >= this.#opt.batchSize) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = null;
				void this.flush();
			}, this.#opt.flushMs);
		}
	}

	/** 立即把缓冲写入磁盘 */
	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		if (this.#buffer.length === 0) return;

		const batch = this.#buffer;
		this.#buffer = [];

		try {
			await this.#ensureDir();
			/* 按天分组，跨零点的批次会正确分到两个文件 */
			const byDate = new Map<string, string[]>();
			for (const item of batch) {
				const key = localDateKey(item.ts);
				const lines = byDate.get(key) ?? [];
				lines.push(JSON.stringify(item));
				byDate.set(key, lines);
			}
			for (const [date, lines] of byDate) {
				const file = join(roomDir(this.#opt.dataDir, this.#realRoom), `${date}.jsonl`);
				await appendFile(file, lines.join('\n') + '\n', 'utf8');
			}
		} catch (err) {
			log.warn('落盘失败，丢弃本批', batch.length, '条:', (err as Error).message);
		}
	}

	async #ensureDir(): Promise<void> {
		if (this.#dirReady) return;
		await mkdir(roomDir(this.#opt.dataDir, this.#realRoom), { recursive: true });
		this.#dirReady = true;
	}

	/**
	 * 读取最近 N 条弹幕用于回显。
	 *
	 * 从文件尾部往前读，避免把当天所有弹幕都载入内存。
	 * 只回显弹幕（不含礼物），且只回显当天。
	 */
	async readEcho(count: number): Promise<DanmakuEvent[]> {
		const file = this.filePath();
		let lines: string[];
		try {
			lines = await tailLines(file, count * 3 + 50);
		} catch {
			/* 当天还没有文件，或回显关闭 */
			return [];
		}

		const out: DanmakuEvent[] = [];
		for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const item = JSON.parse(line) as DanmakuItem;
				if (item.t === 'danmaku') out.push(item);
			} catch {
				/* 跳过损坏行（例如进程被强杀时写了一半） */
			}
		}
		return out.reverse();
	}

	/** 停止接受写入并落盘 */
	async close(): Promise<void> {
		this.#closed = true;
		await this.flush();
	}

	/**
	 * 重新启用。
	 *
	 * 房间在空闲空闲断开后会被 RoomHub 保留在注册表里，
	 * 下次有客户端订阅时同一个 Store 实例会被复用，
	 * 因此 close() 之后必须能重新打开。
	 */
	reopen(): void {
		this.#closed = false;
		this.#dirReady = false;
	}
}

/**
 * 读取文件末尾若干行。
 *
 * 实现策略：先用 createReadStream 全量流式读取并只保留尾部 N 行。
 * 单日文件通常只有几 MB，流式读取的峰值内存取决于单行长度而非文件大小，
 * 比 readFile 全量载入安全得多。
 */
async function tailLines(file: string, n: number): Promise<string[]> {
	const stream = createReadStream(file, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	const ring: string[] = [];
	try {
		for await (const line of rl) {
			ring.push(line);
			if (ring.length > n) ring.shift();
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	return ring;
}

/** 健康检查用：当天文件是否可读 */
export async function statToday(dataDir: string, room: string): Promise<string | null> {
	const file = join(roomDir(dataDir, room), `${localDateKey()}.jsonl`);
	try {
		const content = await readFile(file, 'utf8');
		return `${file} (${content.length} bytes)`;
	} catch {
		return null;
	}
}
