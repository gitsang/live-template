/**
 * B 站弹幕 WebSocket 二进制协议。
 *
 * 包结构（大端）：
 *   4B total_length | 2B header_length(=16) | 2B protocol_version
 *   4B operation     | 4B sequence(=1)      | body...
 *
 * operation: 2=心跳 3=心跳回应 5=通知 7=认证 8=认证回应
 * protocol_version: 0=JSON 1=心跳计数 2=zlib 3=brotli
 */

import { brotliDecompressSync, inflateSync } from 'node:zlib';

export const OP = {
	HEARTBEAT: 2,
	HEARTBEAT_REPLY: 3,
	MESSAGE: 5,
	AUTH: 7,
	AUTH_REPLY: 8
} as const;

export const VER = {
	JSON: 0,
	HEARTBEAT: 1,
	ZLIB: 2,
	BROTLI: 3
} as const;

const HEADER_LEN = 16;

/** 组包 */
export function encode(op: number, body: string | Buffer = Buffer.alloc(0)): Buffer {
	const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
	const buf = Buffer.alloc(HEADER_LEN + payload.length);
	buf.writeUInt32BE(HEADER_LEN + payload.length, 0);
	buf.writeUInt16BE(HEADER_LEN, 4);
	buf.writeUInt16BE(VER.HEARTBEAT, 6);
	buf.writeUInt32BE(op, 8);
	buf.writeUInt32BE(1, 12);
	payload.copy(buf, HEADER_LEN);
	return buf;
}

export interface Packet {
	op: number;
	ver: number;
	body: Buffer;
}

/**
 * 拆包并解压。
 *
 * protover=3 的包体内可能是被 brotli 压缩的「一批包」，需要递归拆解；
 * 同时兼容 ver=2（zlib）以应对服务端降级。
 */
export function decode(data: Buffer): Packet[] {
	const out: Packet[] = [];
	let off = 0;

	while (off + HEADER_LEN <= data.length) {
		const total = data.readUInt32BE(off);
		const headerLen = data.readUInt16BE(off + 4);
		const ver = data.readUInt16BE(off + 6);
		const op = data.readUInt32BE(off + 8);

		/* 长度非法时停止解析，避免死循环 */
		if (total < headerLen || total <= 0 || off + total > data.length) break;

		const body = data.subarray(off + headerLen, off + total);
		off += total;

		if ((ver === VER.BROTLI || ver === VER.ZLIB) && body.length > 0) {
			try {
				const raw = ver === VER.BROTLI ? brotliDecompressSync(body) : inflateSync(body);
				/* 解压出来的是若干完整包，递归展开 */
				out.push(...decode(raw));
				continue;
			} catch {
				/* 解压失败就当普通包返回，交给上层忽略 */
			}
		}

		out.push({ op, ver, body });
	}

	return out;
}

/* ---------------- 消息体解析 ---------------- */

/** 认证回应 */
export interface AuthReply {
	code: number;
	message?: string;
}

/** 弹幕消息（DANMU_MSG）的 info 数组，索引含义由 B 站定义 */
export interface RawDanmakuInfo {
	/** info[1] 正文 */
	text: string;
	/** info[2][0] uid，info[2][1] 昵称 */
	uid: number;
	uname: string;
	/** info[0][3] 正文颜色（十进制 RGB） */
	color: number;
	/** info[4][0] 用户等级 */
	level: number;
	/** info[7] 舰长等级 */
	guard: number;
	/** info[3] 粉丝牌 [等级, 名称, ...] */
	medal: [string, number] | null;
	/** info[2][2] 房管 */
	admin: boolean;
	/** info[2][3] 大会员 */
	vip: boolean;
}

/** 解析 DANMU_MSG 的 info 数组；结构异常时返回 null 而非抛错 */
export function parseDanmakuInfo(info: unknown): RawDanmakuInfo | null {
	if (!Array.isArray(info)) return null;
	try {
		const meta = info[0] as unknown[];
		const body = String(info[1] ?? '');
		const user = info[2] as unknown[];

		const medalRaw = info[3] as unknown[] | undefined;
		let medal: [string, number] | null = null;
		if (Array.isArray(medalRaw) && medalRaw.length > 1 && medalRaw[1]) {
			medal = [String(medalRaw[1]), Number(medalRaw[0]) || 0];
		}

		const lvRaw = info[4] as unknown[] | undefined;

		return {
			text: body,
			uid: Number(user?.[0]) || 0,
			uname: String(user?.[1] ?? ''),
			admin: Boolean(user?.[2]),
			vip: Boolean(user?.[3]),
			color: Number(meta?.[3]) || 0xffffff,
			level: Number(lvRaw?.[0]) || 0,
			guard: Number(info[7]) || 0,
			medal
		};
	} catch {
		return null;
	}
}
