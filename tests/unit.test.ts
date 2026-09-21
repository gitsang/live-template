/**
 * 轻量断言式测试（无需测试框架）。
 *
 * 只覆盖不需要网络的纯逻辑：协议编解码、WBI 签名、JSONL 落盘与回显。
 * 真实链路的验证见 docs/design.md 的验收标准，靠实际跑服务完成。
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateSync } from 'node:zlib';

import { OP, VER, decode, encode, parseDanmakuInfo } from '../src/lib/server/bili/packet.ts';
import { wbiMixinKey, wbiSign } from '../src/lib/server/bili/api.ts';
import { DanmakuStore, localDateKey } from '../src/lib/server/store.ts';
import { EventBus } from '../src/lib/server/eventbus.ts';
import { randomQueueUuid } from '../src/lib/server/bili/client.ts';

let passed = 0;
const cases: Array<[string, () => void | Promise<void>]> = [];

function test(name: string, fn: () => void | Promise<void>): void {
	cases.push([name, fn]);
}

/* ============================ 协议 ============================ */

test('encode/decode 往返：认证包', () => {
	const buf = encode(OP.AUTH, '{"a":1}');
	const [pkt] = decode(buf);
	assert.equal(pkt.op, OP.AUTH);
	assert.equal(pkt.body.toString('utf8'), '{"a":1}');
});

test('encode 头部字段：长度 / header 长度 / operation / sequence', () => {
	const body = 'hello';
	const buf = encode(OP.HEARTBEAT, body);
	assert.equal(buf.readUInt32BE(0), 16 + body.length, '总长度');
	assert.equal(buf.readUInt16BE(4), 16, 'header 长度');
	assert.equal(buf.readUInt16BE(6), VER.HEARTBEAT, 'protocol version');
	assert.equal(buf.readUInt32BE(8), OP.HEARTBEAT, 'operation');
	assert.equal(buf.readUInt32BE(12), 1, 'sequence');
});

test('decode 能拆出同一帧里的多个包', () => {
	const a = encode(OP.MESSAGE, '{"n":1}');
	const b = encode(OP.MESSAGE, '{"n":2}');
	const pkts = decode(Buffer.concat([a, b]));
	assert.equal(pkts.length, 2);
	assert.equal(pkts[0].body.toString(), '{"n":1}');
	assert.equal(pkts[1].body.toString(), '{"n":2}');
});

test('decode 解 brotli（protover=3）并递归展开内层包', () => {
	const inner = Buffer.concat([
		encode(OP.MESSAGE, '{"cmd":"A"}'),
		encode(OP.MESSAGE, '{"cmd":"B"}')
	]);
	const compressed = brotliCompressSync(inner);
	/* 手工组装一个 ver=3 的外层包 */
	const header = Buffer.alloc(16);
	header.writeUInt32BE(16 + compressed.length, 0);
	header.writeUInt16BE(16, 4);
	header.writeUInt16BE(VER.BROTLI, 6);
	header.writeUInt32BE(OP.MESSAGE, 8);
	header.writeUInt32BE(1, 12);

	const pkts = decode(Buffer.concat([header, compressed]));
	assert.equal(pkts.length, 2, '内层两个包都要解出来');
	assert.equal(JSON.parse(pkts[0].body.toString()).cmd, 'A');
	assert.equal(JSON.parse(pkts[1].body.toString()).cmd, 'B');
});

test('decode 兼容 zlib（protover=2）', () => {
	const inner = encode(OP.MESSAGE, '{"cmd":"Z"}');
	const compressed = deflateSync(inner);
	const header = Buffer.alloc(16);
	header.writeUInt32BE(16 + compressed.length, 0);
	header.writeUInt16BE(16, 4);
	header.writeUInt16BE(VER.ZLIB, 6);
	header.writeUInt32BE(OP.MESSAGE, 8);
	header.writeUInt32BE(1, 12);

	const pkts = decode(Buffer.concat([header, compressed]));
	assert.equal(pkts.length, 1);
	assert.equal(JSON.parse(pkts[0].body.toString()).cmd, 'Z');
});

test('decode 遇到损坏的压缩体不抛错', () => {
	const header = Buffer.alloc(16);
	header.writeUInt32BE(16 + 8, 0);
	header.writeUInt16BE(16, 4);
	header.writeUInt16BE(VER.BROTLI, 6);
	header.writeUInt32BE(OP.MESSAGE, 8);
	header.writeUInt32BE(1, 12);
	const pkts = decode(Buffer.concat([header, Buffer.from('notbrotli')]));
	assert.equal(pkts.length, 1, '退化为未压缩包返回');
});

test('decode 遇到非法长度不死循环', () => {
	const bad = Buffer.alloc(20);
	bad.writeUInt32BE(0, 0); // total = 0
	assert.doesNotThrow(() => decode(bad));
});

/* ==================== 弹幕 info 解析 ==================== */

test('parseDanmakuInfo 正常解析', () => {
	const info = [
		[0, 1, 25, 16777215],
		'正文',
		[12345, '昵称', 0, 1],
		[12, '粉丝牌', 1],
		[42, 0, 0],
		[0, 0],
		'',
		3
	];
	const got = parseDanmakuInfo(info);
	assert.ok(got);
	assert.equal(got.text, '正文');
	assert.equal(got.uid, 12345);
	assert.equal(got.uname, '昵称');
	assert.equal(got.color, 16777215);
	assert.equal(got.level, 42);
	assert.equal(got.guard, 3);
	assert.deepEqual(got.medal, ['粉丝牌', 12]);
	assert.equal(got.vip, true);
	assert.equal(got.admin, false);
});

test('parseDanmakuInfo 对畸形输入返回 null 而不是抛错', () => {
	assert.equal(parseDanmakuInfo(null), null);
	assert.equal(parseDanmakuInfo('nope'), null);
	assert.doesNotThrow(() => parseDanmakuInfo([]));
	assert.doesNotThrow(() => parseDanmakuInfo([[], '', [], null, null]));
});

test('parseDanmakuInfo 无粉丝牌时为 null', () => {
	const got = parseDanmakuInfo([[], 'x', [1, 'u'], [], [], [], '', 0]);
	assert.ok(got);
	assert.equal(got.medal, null);
});

/* ========================= WBI 签名 ========================= */

test('wbiMixinKey 按固定重排表取 32 位', () => {
	/* 用可预测的序列验证重排确实生效 */
	const raw = Array.from({ length: 64 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
	const key = wbiMixinKey(raw, '');
	assert.equal(key.length, 32);
	/* 第 0 位来自重排表下标 46 */
	assert.equal(key[0], raw[46]);
	assert.equal(key[1], raw[47]);
});

test('wbiSign 产出的查询串含 wts 与 w_rid，且参数按 key 排序', () => {
	const q = wbiSign({ id: 90932, type: 0 }, 'MIXINKEY', 1700000000);
	assert.match(q, /wts=1700000000/);
	assert.match(q, /w_rid=[0-9a-f]{32}$/);
	const keys = q
		.replace(/&w_rid=.*/, '')
		.split('&')
		.map((kv) => kv.split('=')[0]);
	assert.deepEqual(keys, [...keys].sort(), '参数必须按 key 升序拼接');
});

test('wbiSign 过滤 !\'()* 字符', () => {
	const q = wbiSign({ a: "he!llo'()*" }, 'K', 1);
	assert.ok(!/wts=[^&]*[!'()*]/.test(q));
	assert.match(q, /a=hello/);
});

test('wbiSign 对相同输入稳定', () => {
	assert.equal(wbiSign({ x: 1 }, 'K', 5), wbiSign({ x: 1 }, 'K', 5));
});

/* ==================== queue_uuid ==================== */

test('randomQueueUuid 是 8 位小写字母数字', () => {
	for (let i = 0; i < 50; i++) {
		const u = randomQueueUuid();
		assert.match(u, /^[a-z0-9]{8}$/);
	}
});

test('randomQueueUuid 有足够随机性（连续两次不同）', () => {
	const set = new Set(Array.from({ length: 100 }, () => randomQueueUuid()));
	assert.ok(set.size > 90, `期望基本不重复，实际 ${set.size}/100`);
});

/* ==================== 事件总线 ==================== */

test('EventBus 分配自增 id 并广播', () => {
	const bus = new EventBus();
	const got: number[] = [];
	bus.subscribe((e) => got.push(e.id));
	const a = bus.publish({ t: 'danmaku', ts: 1, uid: 1, u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	const b = bus.publish({ t: 'danmaku', ts: 2, uid: 1, u: 'u', m: 'm2', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	assert.equal(a.id, 1);
	assert.equal(b.id, 2);
	assert.deepEqual(got, [1, 2]);
});

test('EventBus 补发只返回 since 之后的事件', () => {
	const bus = new EventBus();
	for (let i = 0; i < 5; i++) {
		bus.publish({ t: 'danmaku', ts: i, uid: 1, u: 'u', m: 'm' + i, color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	}
	const { events, top } = bus.replay(2);
	assert.deepEqual(events.map((e) => e.id), [3, 4, 5]);
	assert.equal(top, 5);
});

test('EventBus 补发受条数上限约束', () => {
	const bus = new EventBus({ replayMax: 3 });
	for (let i = 0; i < 10; i++) {
		bus.publish({ t: 'danmaku', ts: i, uid: 1, u: 'u', m: 'm' + i, color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	}
	const { events } = bus.replay(0);
	assert.equal(events.length, 3);
	assert.deepEqual(events.map((e) => e.id), [8, 9, 10], '保留最近 3 条');
});

test('EventBus 环形历史上限生效', () => {
	const bus = new EventBus({ historySize: 5 });
	for (let i = 0; i < 20; i++) {
		bus.publish({ t: 'danmaku', ts: i, uid: 1, u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	}
	assert.equal(bus.replay(0).events.length, 5);
});

test('EventBus 保留最新状态供新连接同步', () => {
	const bus = new EventBus();
	bus.publishStatus({ t: 'status', s: 'connecting' });
	bus.publishStatus({ t: 'status', s: 'connected', room: 90932 });
	assert.equal(bus.latestStatus.s, 'connected');
	assert.equal(bus.latestStatus.room, 90932);
});

test('EventBus 单个订阅者抛错不影响其他订阅者', () => {
	const bus = new EventBus();
	let called = false;
	bus.subscribe(() => {
		throw new Error('boom');
	});
	bus.subscribe(() => {
		called = true;
	});
	assert.doesNotThrow(() =>
		bus.publish({ t: 'danmaku', ts: 1, uid: 1, u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false })
	);
	assert.equal(called, true);
});

test('EventBus 取消订阅后不再收到事件', () => {
	const bus = new EventBus();
	let n = 0;
	const off = bus.subscribe(() => n++);
	bus.publish({ t: 'danmaku', ts: 1, uid: 1, u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	off();
	bus.publish({ t: 'danmaku', ts: 2, uid: 1, u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	assert.equal(n, 1);
});

/* ================== 落盘与回显 ================== */

function danmaku(id: number, ts: number, text: string) {
	return {
		t: 'danmaku' as const,
		id,
		ts,
		uid: id,
		u: 'user' + id,
		m: text,
		color: 0xffffff,
		lv: 1,
		guard: 0,
		medal: null,
		vip: false,
		admin: false
	};
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'live-template-test-'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('Store 落盘为逐行合法 JSONL', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '90932', flushMs: 5 });
		for (let i = 1; i <= 5; i++) store.append(danmaku(i, Date.now(), 'msg' + i));
		await store.flush();

		const files = await readdir(join(dir, 'room-90932'));
		assert.deepEqual(files, [localDateKey() + '.jsonl']);

		const raw = await readFile(join(dir, 'room-90932', files[0]), 'utf8');
		const lines = raw.trim().split('\n');
		assert.equal(lines.length, 5);
		for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
		assert.equal(JSON.parse(lines[0]).m, 'msg1');
	});
});

test('Store 回显取最近 N 条且旧→新排序', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 5 });
		for (let i = 1; i <= 30; i++) store.append(danmaku(i, Date.now(), 'msg' + i));
		await store.flush();

		const echo = await store.readEcho(10);
		assert.equal(echo.length, 10);
		assert.equal(echo[0].m, 'msg21');
		assert.equal(echo[9].m, 'msg30');
		for (let i = 1; i < echo.length; i++) assert.ok(echo[i].ts >= echo[i - 1].ts);
	});
});

test('Store 回显只含弹幕，礼物不入回显', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 5 });
		store.append(danmaku(1, Date.now(), 'hello'));
		store.append({
			t: 'gift',
			id: 2,
			ts: Date.now(),
			uid: 1,
			u: 'g',
			g: '小心心',
			n: 1,
			price: 0,
			coin: 'gold'
		});
		await store.flush();

		const echo = await store.readEcho(10);
		assert.equal(echo.length, 1);
		assert.equal(echo[0].t, 'danmaku');
	});
});

test('Store 跨零点按本地时区分成两个文件', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 5 });
		const now = Date.now();
		const yesterday = now - 86_400_000;
		store.append(danmaku(1, yesterday, 'yesterday'));
		store.append(danmaku(2, now, 'today'));
		await store.flush();

		const files = (await readdir(join(dir, 'room-1'))).sort();
		assert.deepEqual(
			files,
			[localDateKey(yesterday) + '.jsonl', localDateKey(now) + '.jsonl'].sort()
		);
	});
});

test('Store 跳过损坏行而不是抛错', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 5 });
		for (let i = 1; i <= 5; i++) store.append(danmaku(i, Date.now(), 'msg' + i));
		await store.flush();

		/* 模拟进程被强杀时留下的半行 */
		await appendFile(store.filePath(), '{"t":"danmaku",BROKEN\n', 'utf8');
		const echo = await store.readEcho(5);
		assert.equal(echo.length, 5, '仍能取满 5 条');
		assert.ok(echo.every((e) => e.t === 'danmaku'));
	});
});

test('Store 清洗房间号防止路径穿越', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '../../etc', flushMs: 5 });
		store.append(danmaku(1, Date.now(), 'x'));
		await store.flush();

		const entries = await readdir(dir);
		assert.deepEqual(entries, ['room-etc'], '只应创建一个无路径分隔符的目录');
	});
});

test('Store 当天无文件时回显为空数组', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '404', flushMs: 5 });
		assert.deepEqual(await store.readEcho(10), []);
	});
});

test('Store close 后再 reopen 可以继续写入', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 5 });
		store.append(danmaku(1, Date.now(), 'before'));
		await store.close();

		/* close 之后 append 应被忽略 */
		store.append(danmaku(2, Date.now(), 'ignored'));
		await store.flush();

		store.reopen();
		store.append(danmaku(3, Date.now(), 'after'));
		await store.flush();

		const raw = await readFile(store.filePath(), 'utf8');
		const lines = raw
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l).m);
		assert.deepEqual(lines, ['before', 'after']);
	});
});

test('Store 超过 batchSize 时自动 flush', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 10_000, batchSize: 3 });
		for (let i = 1; i <= 3; i++) store.append(danmaku(i, Date.now(), 'm' + i));
		/* 不显式调用 flush，靠 batchSize 触发 */
		await new Promise((r) => setTimeout(r, 150));
		const raw = await readFile(store.filePath(), 'utf8');
		assert.equal(raw.trim().split('\n').length, 3);
	});
});

test('localDateKey 使用本地时区补零', () => {
	assert.match(localDateKey(), /^\d{4}-\d{2}-\d{2}$/);
	/* 用一个已知时刻对照本地时间 */
	const d = new Date(2026, 0, 5, 12, 0, 0);
	assert.equal(localDateKey(d.getTime()), '2026-01-05');
});

/* ============================ 运行 ============================ */

async function run(): Promise<void> {
	for (const [name, fn] of cases) {
		try {
			await fn();
			passed++;
			console.log(`  ✓ ${name}`);
		} catch (err) {
			console.error(`  ✗ ${name}`);
			console.error(`    ${(err as Error).message}`);
			process.exitCode = 1;
		}
	}
	console.log(`\n${passed}/${cases.length} passed`);
}

void run();
