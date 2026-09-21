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
import {
	parseColor,
	parseGift,
	parseMedal,
	parseSuperChat
} from '../src/lib/server/bili/parse.ts';
import {
	GUARD_META,
	MAX_CHAT_ITEMS,
	NAME_COLORS,
	VISIBLE_ROWS,
	formatPrice,
	guardColor,
	guardName,
	itemAccent,
	nameColor,
	pickAccent
} from '../src/lib/shared/chat.ts';
import { createDemoEvent } from '../src/lib/shared/demo-events.ts';
import {
	BASE,
	BOXES,
	PANELS,
	CANVAS,
	panelSpec
} from '../src/lib/shared/geometry.ts';
import {
	STICK_BORDER,
	STICK_DOT_SIZE,
	STICK_MAX_TRAVEL,
	STICK_SIZE,
	applyDeadzone,
	stickTransform
} from '../src/lib/shared/pad.ts';

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

/* ==================== 版面几何 ==================== */

test('内容区与外框尺寸关系自洽（外框 = 内容区 + 边框 + 标题栏）', () => {
	for (const name of ['video', 'notice', 'chat', 'pad'] as const) {
		const box = BOXES[name];
		const panel = PANELS[name];
		assert.equal(panel.w, box.w + BASE.bw * 2, `${name} 宽度关系`);
		assert.equal(panel.h, box.h + BASE.hd + BASE.bw * 2, `${name} 高度关系`);
	}
});

test('外框矩形与内容区矩形同心（只差边框与标题栏的偏移）', () => {
	for (const name of ['video', 'notice', 'chat', 'pad'] as const) {
		assert.equal(PANELS[name].x, BOXES[name].x - BASE.bw, `${name} x 偏移`);
		assert.equal(PANELS[name].y, BOXES[name].y - BASE.bw - BASE.hd, `${name} y 偏移`);
	}
});

test('关键尺寸与设计文档一致（OBS 里填的就是这些数）', () => {
	/* 视频框严格 16:9 */
	assert.equal(Math.round(BOXES.video.w), 1360);
	assert.equal(Math.round(BOXES.video.h), 765);
	assert.ok(Math.abs(BOXES.video.w / BOXES.video.h - 16 / 9) < 1e-9, '视频框必须是 16:9');

	/* 聊天框 / 手柄框 */
	assert.equal(Math.round(BOXES.chat.w), 474);
	assert.equal(Math.round(BOXES.chat.h), 630);
	assert.equal(Math.round(BOXES.pad.w), 474);
	assert.equal(Math.round(BOXES.pad.h), 304);

	/* 外框：OBS 浏览器源要填的宽高 */
	assert.deepEqual(
		['video', 'notice', 'chat', 'pad'].map((n) => `${PANELS[n as 'video'].w}×${PANELS[n as 'video'].h}`),
		['1366×801', '1366×205', '480×666', '480×340']
	);
});

test('左右两栏与画布高度完全吻合（布局不留缝隙）', () => {
	const sceneH = CANVAS.h - BASE.pad * 2;
	const leftH = PANELS.video.h + BASE.gap + PANELS.notice.h;
	const rightH = PANELS.chat.h + BASE.gap + PANELS.pad.h;
	assert.equal(leftH, sceneH, '左栏总高应等于场景高');
	assert.equal(rightH, sceneH, '右栏总高应等于场景高');

	const sceneW = CANVAS.w - BASE.pad * 2;
	const leftW = PANELS.video.w;
	const rightW = PANELS.chat.w;
	assert.equal(leftW + BASE.gap + rightW, sceneW, '两栏加间距应等于场景宽');
});

test('panelSpec 生成可直接抄进 OBS 的描述', () => {
	assert.equal(panelSpec('chat'), '480×666 @ 1412,28');
	/* pad 在右栏聊天框之下：y = pad(28) + 聊天外框(666) + gap(18) = 712 */
	assert.equal(panelSpec('pad'), '480×340 @ 1412,712');
});

test('聊天框可见行数约 18 行（实测单行 33px）', () => {
	/*
	 * 实测：单行 33px = 16px × 行高 1.6（25.6）+ 上下 padding 3px×2 + 1px 分隔线。
	 * 内容可视高 = 630 − 上下 padding 12 = 618 → 618 / 33 = 18.7 → 完整 18 行。
	 *
	 * 两个曾经的错误数字，一并记在这里防止回退：
	 * - 23 行 —— 只按 25.6px 算，漏了行内 padding 与分隔线
	 * - 19 行 —— 用 clientHeight(630，含 padding) 去除，没扣掉 padding
	 * 而且礼物/SC 行更高（SC 约 61px），混合时的可见条数会更少。
	 */
	const measuredRowHeight = 33;
	const listPadding = 12; // 上下各 6px
	const rows = Math.floor((BOXES.chat.h - listPadding) / measuredRowHeight);
	assert.equal(rows, 18);
});

/* ==================== B 站报文解析（礼物 / SC） ==================== */

/*
 * SC 与礼物在真实直播间里很稀有（SC 尤其），
 * 靠连线上碰运气验证不现实，因此这里用**与 B 站实际下发结构一致**的报文做固定夹具。
 * 下面 DANMU_MSG 的 info 数组是从真实直播间抓下来的原样数据。
 */

test('真实 DANMU_MSG 的 info 索引与本项目映射一致', () => {
	/* 抓自真实直播间：info[3] 是 [等级, 名称, 主播名, ...] 形式 */
	const info = [
		[0, 1, 25, 16777215, 1789975608830],
		'不用自己做饭挺舒服的',
		[626170076, '赛小泯321', 0, 0, 0, 10000, 1, ''],
		[25, '莉娅娅', '奈奈莉娅Channel', 22301377],
		[13, 0, 6406234, '>50000', 0],
		['', ''],
		'',
		0
	];
	const got = parseDanmakuInfo(info);
	assert.ok(got);
	assert.equal(got.text, '不用自己做饭挺舒服的');
	assert.equal(got.uid, 626170076);
	assert.equal(got.uname, '赛小泯321');
	assert.equal(got.color, 16777215);
	assert.equal(got.level, 13, '等级取 info[4][0]');
	assert.equal(got.guard, 0, '舰长取 info[7]');
	assert.deepEqual(got.medal, ['莉娅娅', 25], '粉丝牌 = [info[3][1], info[3][0]]');
});

test('parseMedal 同时认数组形态与对象形态', () => {
	/* 弹幕：数组 [等级, 名称] */
	assert.deepEqual(parseMedal([25, '莉娅娅', '主播', 1]), ['莉娅娅', 25]);
	/* 礼物 / SC：对象 medal_info */
	assert.deepEqual(parseMedal({ medal_name: '航海', medal_level: 21 }), ['航海', 21]);
	/* SC：对象且字段名不带 medal_ 前缀 */
	assert.deepEqual(parseMedal({ name: '七海', level: 12 }), ['七海', 12]);
});

test('parseMedal 对无粉丝牌/畸形输入返回 null', () => {
	assert.equal(parseMedal(null), null);
	assert.equal(parseMedal([]), null);
	assert.equal(parseMedal([0, '', '']), null, '空名称视为无粉丝牌');
	assert.equal(parseMedal({}), null);
	assert.equal(parseMedal('nope'), null);
	assert.doesNotThrow(() => parseMedal(undefined));
});

test('parseColor 只接受 #RRGGBB 并统一小写', () => {
	assert.equal(parseColor('#B39DDB'), '#b39ddb');
	assert.equal(parseColor('  #FFFFFF '), '#ffffff');
	assert.equal(parseColor('#abc'), null, '三位缩写不接受');
	assert.equal(parseColor('red'), null);
	assert.equal(parseColor(''), null);
	assert.equal(parseColor(undefined), null);
	assert.equal(parseColor(123), null);
});

test('parseGift 解析完整礼物报文', () => {
	const got = parseGift(
		{
			uid: 3063712,
			uname: '钢铁侠',
			giftName: '小心心',
			num: 10,
			price: 100,
			coin_type: 'gold',
			guard_level: 3,
			wealth_level: 42,
			medal_info: { medal_name: '航海', medal_level: 21 }
		},
		1700000000000
	);
	assert.ok(got);
	assert.equal(got.t, 'gift');
	assert.equal(got.u, '钢铁侠');
	assert.equal(got.g, '小心心');
	assert.equal(got.n, 10);
	assert.equal(got.price, 1000, 'price 是单价，需乘数量得到总价值');
	assert.equal(got.coin, 'gold');
	assert.equal(got.lv, 42);
	assert.equal(got.guard, 3);
	assert.deepEqual(got.medal, ['航海', 21]);
	assert.equal(got.ts, 1700000000000);
});

test('parseGift 对缺字段做兜底而不是丢掉整条', () => {
	/* 银瓜子免费礼物：没有 price、没有粉丝牌 */
	const got = parseGift({ uname: '甲', giftName: '辣条', num: 1, coin_type: 'silver' }, 1);
	assert.ok(got);
	assert.equal(got.price, 0);
	assert.equal(got.n, 1);
	assert.equal(got.medal, null);
	assert.equal(got.uid, 0);
	assert.equal(got.coin, 'silver');
});

test('parseGift 归一化异常的数量与单价', () => {
	/* num 缺失或为 0 时至少记 1 个（否则「赠送 ×0」很怪） */
	assert.equal(parseGift({ num: 0 }, 1)?.n, 1);
	assert.equal(parseGift({ num: '3' }, 1)?.n, 3, '字符串数字也能解析');
	assert.equal(parseGift({ price: 'abc', num: 2 }, 1)?.price, 0, '非法单价按 0');
	assert.equal(parseGift({}, 1)?.g, '礼物', '礼物名缺失时用占位名');
});

test('parseSuperChat 解析完整 SC 报文', () => {
	const got = parseSuperChat(
		{
			uid: 12345,
			price: 100,
			time: 120,
			message: '主播加油！这把我压你赢',
			background_color_start: '#B39DDB',
			background_color_end: '#7E57C2',
			background_bottom_color: '#5E35B1',
			message_font_color: '#FFFFFF',
			uinfo: {
				uname: '林深见鹿',
				user_level: 45,
				guard_level: 2,
				medal: { name: '七海', level: 12 }
			},
			user_info: { uname: '林深见鹿', user_level: 45, guard_level: 2 }
		},
		1700000000000
	);
	assert.ok(got);
	assert.equal(got.t, 'sc');
	assert.equal(got.u, '林深见鹿');
	assert.equal(got.m, '主播加油！这把我压你赢');
	assert.equal(got.price, 100);
	assert.equal(got.duration, 120);
	assert.equal(got.lv, 45);
	assert.equal(got.guard, 2);
	assert.deepEqual(got.medal, ['七海', 12]);
	assert.equal(got.colorBottom, '#5e35b1');
	assert.equal(got.fontColor, '#ffffff');
});

test('parseSuperChat 在 uinfo 缺失时退回 user_info', () => {
	/* B 站两处都放用户信息，且不同版本缺的不一样 */
	const got = parseSuperChat(
		{ price: 30, message: 'hi', user_info: { uname: '乙', user_level: 7, guard_level: 3 } },
		1
	);
	assert.ok(got);
	assert.equal(got.u, '乙');
	assert.equal(got.lv, 7);
	assert.equal(got.guard, 3);
});

test('parseSuperChat 对缺失主题色给中性兜底，不产生非法值', () => {
	const got = parseSuperChat({ message: 'hi', price: 30 }, 1);
	assert.ok(got);
	for (const key of ['colorStart', 'colorEnd', 'colorBottom', 'fontColor'] as const) {
		assert.match(got[key], /^#[0-9a-f]{6}$/, `${key} 必须是合法颜色`);
	}
});

test('parseSuperChat 接受 gradient_* 别名', () => {
	const got = parseSuperChat(
		{ message: 'x', price: 1, gradient_start: '#EDF5FF', gradient_end: '#7E57C2' },
		1
	);
	assert.ok(got);
	assert.equal(got.colorStart, '#edf5ff');
	assert.equal(got.colorEnd, '#7e57c2');
	/* bottom 缺失时回落到较深的 end，而不是浅色的 start */
	assert.equal(got.colorBottom, '#7e57c2');
});

test('parseSuperChat 丢弃无正文的消息', () => {
	assert.equal(parseSuperChat({ price: 100, message: '' }, 1), null);
	assert.equal(parseSuperChat({ price: 100 }, 1), null);
	assert.equal(parseSuperChat(null, 1), null);
});

/* ==================== 聊天框配色与格式化 ==================== */

test('nameColor 优先用 user_hash 作为种子', () => {
	/*
	 * 回归测试：实测真实直播间 uid 恒为 0、昵称被打码（赛***），
	 * 只有 user_hash 能区分观众。若以实现顺序（uid 优先）着色，全场会塌成同色。
	 */
	const a = nameColor('969626962', 'x***');
	const b = nameColor('3768840604', '赛***');
	const c = nameColor('3605286734', '楓***');
	assert.equal(new Set([a, b, c]).size, 3, '三个不同 hash 应得到三种颜色');

	/* 同一个 hash 即使昵称被打码成不同串也必须同色 */
	assert.equal(nameColor('969626962', 'x***'), nameColor('969626962', '**不同**'));

	/* 一批真实量级的 hash 要有足够区分度 */
	const seen = new Set<string>();
	for (let i = 0; i < 100; i++) seen.add(nameColor(String(3768840604 + i * 7919)));
	assert.ok(seen.size >= 6, `hash 颜色分布过窄: ${seen.size}/8`);
});

test('nameColor 在 hash 缺失时才退回 uid / 昵称', () => {
	/* 空 hash + 非零 uid → 用 uid */
	assert.equal(nameColor(0, 'x'), nameColor('', 'x'));
	assert.notEqual(nameColor(12345, 'x'), nameColor(67890, 'x'));
	/* uid 也是 0（真实环境的常态）→ 退回昵称 */
	assert.equal(nameColor(0, '夜航船'), nameColor(0, '夜航船'));
	assert.notEqual(nameColor(0, '夜航船'), nameColor(0, '一勺糖'));
	/* 全空也要给一个合法颜色，不能抛错 */
	assert.ok((NAME_COLORS as readonly string[]).includes(nameColor('', '')));
});

test('真实 user_hash 是超出安全整数的数字串也能稳定散列', () => {
	/* 长度上限 10 位的数字串：用逐字符 FNV 而不是 Number()，避免精度丢失 */
	const big = '9999999999';
	assert.equal(nameColor(big, 'a'), nameColor(big, 'b'));
	assert.ok((NAME_COLORS as readonly string[]).includes(nameColor(big)));
});

test('nameColor 对同一 uid 稳定、对不同 uid 有区分度', () => {
	/* 稳定性：观众能形成「这个颜色是谁」的记忆 */
	for (const uid of [1, 42, 1557129, 99999999]) {
		assert.equal(nameColor(uid), nameColor(uid));
	}
	/* 区分度：一批真实量级的 uid 不应挤在少数几种颜色里 */
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) seen.add(nameColor(100000 + i * 7919));
	assert.ok(seen.size >= 6, `颜色分布过窄，只用到 ${seen.size}/${NAME_COLORS.length}`);
});

test('nameColor 只返回配色板里的颜色', () => {
	for (let i = 0; i < 300; i++) {
		assert.ok((NAME_COLORS as readonly string[]).includes(nameColor(i * 31337)));
	}
});

test('nameColor 在 uid 缺失时退回昵称散列且仍然稳定', () => {
	assert.equal(nameColor(0, '夜航船'), nameColor(0, '夜航船'));
	assert.notEqual(nameColor(0, '夜航船'), nameColor(0, '一勺糖'));
	assert.ok((NAME_COLORS as readonly string[]).includes(nameColor(0, '')));
});

test('uid 连续时也能散开，不落在相邻颜色上', () => {
	/* 乘散列的意义：简单取模会让 1,2,3… 落到相邻色，看起来像同一批人 */
	const picked = [1, 2, 3, 4, 5].map((uid) => nameColor(uid));
	assert.ok(new Set(picked).size >= 4, `相邻 uid 颜色过于接近: ${picked.join(',')}`);
});

test('guardName / guardColor 只认 1/2/3', () => {
	assert.equal(guardName(1), '总督');
	assert.equal(guardName(2), '提督');
	assert.equal(guardName(3), '舰长');
	assert.equal(guardName(0), '');
	assert.equal(guardName(99), '');
	assert.match(guardColor(1), /^#[0-9a-f]{6}$/i);
	assert.equal(guardColor(0), '');
	assert.equal(Object.keys(GUARD_META).length, 3);
});

test('formatPrice 整数不带小数、非法值归零', () => {
	assert.equal(formatPrice(30), '30');
	assert.equal(formatPrice(1000), '1000');
	assert.equal(formatPrice(9.5), '9.50');
	assert.equal(formatPrice(0), '0');
	assert.equal(formatPrice(-5), '0');
	assert.equal(formatPrice(Number.NaN), '0');
});

test('pickAccent 取最深的一端（浅色在深底上会刺眼）', () => {
	/* 模拟 B 站 SC 的浅色渐变：底栏色最深，应被选中 */
	assert.equal(pickAccent('#EDF5FF', '#7E57C2', '#B39DDB'), '#7E57C2');
	/* 顺序无关 */
	assert.equal(pickAccent('#7E57C2', '#EDF5FF', '#B39DDB'), '#7E57C2');
});

test('pickAccent 忽略非法颜色并在全非法时回落', () => {
	assert.equal(pickAccent('not-a-color', '#123456'), '#123456');
	assert.equal(pickAccent('', 'nope', undefined as unknown as string), '#4de2ff');
});

test('itemAccent：弹幕/礼物用用户名色，SC 用主题最深色', () => {
	const danmaku = {
		t: 'danmaku' as const,
		id: 1,
		ts: 1,
		uid: 42,
		uh: 'hash-42',
		u: '甲',
		m: 'x',
		color: 0xffffff,
		lv: 1,
		guard: 0,
		medal: null,
		vip: false,
		admin: false
	};
	/* uh 存在时以 hash 为种子（真实环境 uid 恒为 0） */
	assert.equal(itemAccent(danmaku), nameColor('hash-42', '甲'));

	const sc = {
		t: 'sc' as const,
		id: 2,
		ts: 1,
		uid: 7,
		uh: 'hash-7',
		u: '乙',
		m: 'y',
		price: 30,
		duration: 60,
		lv: 1,
		guard: 0,
		medal: null,
		colorStart: '#EDF5FF',
		colorEnd: '#7E57C2',
		colorBottom: '#5E35B1',
		fontColor: '#FFFFFF'
	};
	assert.equal(itemAccent(sc), '#5E35B1');
});

test('可见行数与 DOM 上限保持合理关系', () => {
	assert.equal(VISIBLE_ROWS, 18);
	assert.equal(MAX_CHAT_ITEMS, 300);
	assert.ok(MAX_CHAT_ITEMS > VISIBLE_ROWS * 10, 'DOM 上限应远大于可见行数，便于回溯');
});

/* ==================== 演示事件生成 ==================== */

test('createDemoEvent 在固定节奏上产出三类事件', () => {
	const kinds = new Set<string>();
	for (let i = 1; i <= 60; i++) kinds.add(createDemoEvent({ index: i }).t);
	assert.deepEqual([...kinds].sort(), ['danmaku', 'gift', 'sc']);
});

test('createDemoEvent 的节奏可预测（不靠随机阈值）', () => {
	/* 这是修过的 bug：前端 mock 曾只造弹幕，导致 MOCK 模式下礼物/SC 永不出现 */
	assert.equal(createDemoEvent({ index: 11 }).t, 'sc');
	assert.equal(createDemoEvent({ index: 22 }).t, 'sc');
	assert.equal(createDemoEvent({ index: 7 }).t, 'gift');
	assert.equal(createDemoEvent({ index: 14 }).t, 'gift');
	assert.equal(createDemoEvent({ index: 1 }).t, 'danmaku');
	/* 12 的倍数（且非 7/11 的倍数）是超长弹幕，用于验证换行 */
	const long = createDemoEvent({ index: 12 });
	assert.equal(long.t, 'danmaku');
	assert.ok(long.t === 'danmaku' && long.m.length > 40, '第 12 条应为超长弹幕');
});

test('createDemoEvent 产出的字段足够渲染', () => {
	const gift = createDemoEvent({ index: 7 });
	assert.equal(gift.t, 'gift');
	if (gift.t === 'gift') {
		assert.ok(gift.g.length > 0, '礼物名');
		assert.ok(gift.n >= 1, '数量');
		assert.ok(['gold', 'silver'].includes(gift.coin), '货币类型');
	}

	const sc = createDemoEvent({ index: 11 });
	assert.equal(sc.t, 'sc');
	if (sc.t === 'sc') {
		assert.ok(sc.price > 0, '金额');
		assert.ok(sc.m.length > 0, '留言正文');
		for (const key of ['colorStart', 'colorEnd', 'colorBottom', 'fontColor'] as const) {
			assert.match(sc[key], /^#[0-9a-fA-F]{6}$/, `${key} 应为 #RRGGBB`);
		}
	}
});

test('createDemoEvent 保留时间戳参数（便于确定性测试）', () => {
	assert.equal(createDemoEvent({ index: 1, ts: 1234567890 }).ts, 1234567890);
});

/* ==================== 摇杆几何 ==================== */

test('摇杆圆点行程按像素算，而不是圆点自身的百分比', () => {
	/* 回归测试：曾用 translate(100% - 50%)，百分比基于 24px 的圆点，
	   实际只移动 12px，跑不满 78px 的摇杆。 */
	assert.equal(STICK_MAX_TRAVEL, STICK_SIZE / 2 - STICK_BORDER - STICK_DOT_SIZE / 2);
	assert.equal(STICK_MAX_TRAVEL, 25);
	assert.ok(STICK_MAX_TRAVEL > STICK_DOT_SIZE / 2, '行程应明显大于圆点半径');
});

test('stickTransform 输出像素且拉满时到达边界', () => {
	assert.equal(stickTransform(0, 0), 'translate(0.00px, 0.00px)');
	assert.equal(stickTransform(1, 0), `translate(${STICK_MAX_TRAVEL}.00px, 0.00px)`);
	assert.equal(stickTransform(0, -1), `translate(0.00px, ${-STICK_MAX_TRAVEL}.00px)`);
	/* 任意方向不超过最大行程 */
	for (const [x, y] of [[1, 1], [-1, -1], [0.5, -0.5], [1, -1]]) {
		const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(stickTransform(x, y));
		assert.ok(m, '格式应为 translate(Npx, Npx)');
		assert.ok(Math.abs(Number(m[1])) <= STICK_MAX_TRAVEL + 1e-9);
		assert.ok(Math.abs(Number(m[2])) <= STICK_MAX_TRAVEL + 1e-9);
	}
});

test('applyDeadzone 把死区内的值归零并平滑放大其余值', () => {
	assert.equal(applyDeadzone(0), 0);
	assert.equal(applyDeadzone(0.05), 0, '死区内归零');
	assert.equal(applyDeadzone(-0.05), 0);
	/* 刚好越过死区时从 0 连续起步 */
	assert.ok(applyDeadzone(0.09) > 0 && applyDeadzone(0.09) < 0.05);
	/* 拉满仍是 1 */
	assert.equal(applyDeadzone(1), 1);
	assert.equal(applyDeadzone(-1), -1);
	/* 单调 */
	assert.ok(applyDeadzone(0.5) > applyDeadzone(0.3));
});

/* ==================== 事件总线 ==================== */

test('EventBus 分配自增 id 并广播', () => {
	const bus = new EventBus();
	const got: number[] = [];
	bus.subscribe((e) => got.push(e.id));
	const a = bus.publish({ t: 'danmaku', ts: 1, uid: 1, uh: 'h1', u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	const b = bus.publish({ t: 'danmaku', ts: 2, uid: 1, uh: 'h2', u: 'u', m: 'm2', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	assert.equal(a.id, 1);
	assert.equal(b.id, 2);
	assert.deepEqual(got, [1, 2]);
});

test('EventBus 补发只返回 since 之后的事件', () => {
	const bus = new EventBus();
	for (let i = 0; i < 5; i++) {
		bus.publish({ t: 'danmaku', ts: i, uid: 1, uh: 'hi', u: 'u', m: 'm' + i, color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	}
	const { events, top } = bus.replay(2);
	assert.deepEqual(events.map((e) => e.id), [3, 4, 5]);
	assert.equal(top, 5);
});

test('EventBus 补发受条数上限约束', () => {
	const bus = new EventBus({ replayMax: 3 });
	for (let i = 0; i < 10; i++) {
		bus.publish({ t: 'danmaku', ts: i, uid: 1, uh: 'hi', u: 'u', m: 'm' + i, color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	}
	const { events } = bus.replay(0);
	assert.equal(events.length, 3);
	assert.deepEqual(events.map((e) => e.id), [8, 9, 10], '保留最近 3 条');
});

test('EventBus 环形历史上限生效', () => {
	const bus = new EventBus({ historySize: 5 });
	for (let i = 0; i < 20; i++) {
		bus.publish({ t: 'danmaku', ts: i, uid: 1, uh: 'hi', u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
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
		bus.publish({ t: 'danmaku', ts: 1, uid: 1, uh: 'h1', u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false })
	);
	assert.equal(called, true);
});

test('EventBus 取消订阅后不再收到事件', () => {
	const bus = new EventBus();
	let n = 0;
	const off = bus.subscribe(() => n++);
	bus.publish({ t: 'danmaku', ts: 1, uid: 1, uh: 'h1', u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	off();
	bus.publish({ t: 'danmaku', ts: 2, uid: 1, uh: 'h2', u: 'u', m: 'm', color: 0, lv: 0, guard: 0, medal: null, vip: false, admin: false });
	assert.equal(n, 1);
});

/* ================== 落盘与回显 ================== */

function danmaku(id: number, ts: number, text: string) {
	return {
		t: 'danmaku' as const,
		id,
		ts,
		uid: id,
		uh: String(id * 7919),
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
		/* 这批全是弹幕，用类型守卫收窄后断言正文 */
		const texts = echo.map((e) => (e.t === 'danmaku' ? e.m : ''));
		assert.equal(texts[0], 'msg21');
		assert.equal(texts[9], 'msg30');
		for (let i = 1; i < echo.length; i++) assert.ok(echo[i].ts >= echo[i - 1].ts);
	});
});

test('Store 回显含弹幕/礼物/SC，忽略其余类型', async () => {
	await withTempDir(async (dir) => {
		const store = new DanmakuStore({ dataDir: dir, room: '1', flushMs: 5 });
		store.append(danmaku(1, Date.now(), 'hello'));
		store.append({
			t: 'gift',
			id: 2,
			ts: Date.now(),
			uid: 1,
			uh: 'h1',
			u: 'g',
			g: '小心心',
			n: 1,
			price: 0,
			coin: 'gold',
			lv: 10,
			guard: 3,
			medal: ['牌', 5]
		});
		store.append({
			t: 'sc',
			id: 3,
			ts: Date.now(),
			uid: 1,
			uh: 'h1',
			u: 'sc',
			m: '留言',
			price: 30,
			duration: 60,
			lv: 1,
			guard: 0,
			medal: null,
			colorStart: '#B39DDB',
			colorEnd: '#7E57C2',
			colorBottom: '#5E35B1',
			fontColor: '#FFFFFF'
		});
		await store.flush();

		const echo = await store.readEcho(10);
		assert.deepEqual(
			echo.map((e) => e.t),
			['danmaku', 'gift', 'sc'],
			'三类可渲染条目都应回显，且保持写入顺序'
		);
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
