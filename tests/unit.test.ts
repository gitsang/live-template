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
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync, deflateSync } from 'node:zlib';

import { OP, VER, decode, encode, parseDanmakuInfo } from '../src/lib/server/bili/packet.ts';
import { wbiMixinKey, wbiSign } from '../src/lib/server/bili/api.ts';
import { DanmakuStore, localDateKey } from '../src/lib/server/store.ts';
import { EventBus } from '../src/lib/server/eventbus.ts';
import { randomQueueUuid } from '../src/lib/server/bili/client.ts';
import {
	DEFAULT_COOKIE_FILE,
	generateToken,
	isRestrictive,
	readCookieFile,
	safeEqual,
	writeCookieFile
} from '../src/lib/server/credential.ts';
import { QR_MIN_MARGIN, qrMatrix, qrSvg } from '../src/lib/shared/qr.ts';
import {
	ADMIN_TTL_MS,
	sessionCookieOptions,
	isSecureRequest,
	issueSession,
	verifySession
} from '../src/lib/server/admin-session.ts';
import { LoginSession } from '../src/lib/server/login.ts';
import {
	QR_CODE,
	QR_STATUS_TEXT,
	extractLoginCookie,
	extractLoginCookieFromUrl,
	parseQrStatus
} from '../src/lib/server/bili/qrlogin.ts';
import {
	buildAuthPacket,
	buvidFromCookie,
	resolveAuth,
	buildAuth,
	cookieValue,
	isMaskedName,
	mergeCookies,
	parseCookie,
	redactCookie,
	serializeCookie,
	userIdFromCookie
} from '../src/lib/server/bili/session.ts';
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

/* ==================== 登录态 Cookie ==================== */

/* 假凭据：值本身不重要，重要的是任何输出里都不能出现完整值 */
const REAL_SESSDATA = 'abcdef1234567890%2BxyzSECRET';
const REAL_JCT = 'deadbeef0123456789CSRF';
const LOGIN_COOKIE =
	`SESSDATA=${REAL_SESSDATA}; bili_jct=${REAL_JCT}; DedeUserID=1557129; ` +
	'DedeUserID__ckMd5=abcdef0123456789; buvid3=4B8559FC-5939-641B-6256-FCA6588EEC2329234infoc';

test('parseCookie 解析键值并容忍脏输入', () => {
	const m = parseCookie(`  a=1 ; b=2;  ; c ; =3 ; d="quoted" ; e=has=equals `);
	assert.equal(m.a, '1');
	assert.equal(m.b, '2');
	assert.equal(m.c, undefined, '没有 = 的段应跳过');
	assert.equal(m[''], undefined, '空名应跳过');
	assert.equal(m.d, 'quoted', '应去掉两侧引号');
	assert.equal(m.e, 'has=equals', '只按第一个 = 切分');
});

test('parseCookie 对空输入返回空对象', () => {
	assert.deepEqual(parseCookie(''), {});
	assert.deepEqual(parseCookie('   '), {});
	assert.deepEqual(parseCookie(';;;'), {});
});

test('serializeCookie / parseCookie 往返一致', () => {
	const raw = 'a=1; b=2; c=3';
	assert.equal(serializeCookie(parseCookie(raw)), raw);
	/* 空值字段应被丢弃，避免发出 `name=` 这种半截 Cookie */
	assert.equal(serializeCookie({ a: '1', b: '' }), 'a=1');
});

test('mergeCookies 后者覆盖前者（用户凭据优先于匿名指纹）', () => {
	/* 关键：用户自带的 buvid3 与他的 SESSDATA 属于同一次会话，必须优先 */
	const merged = mergeCookies('buvid3=ANON; b_nut=1', 'buvid3=USER; SESSDATA=xyz');
	assert.equal(cookieValue(merged, 'buvid3'), 'USER');
	assert.equal(cookieValue(merged, 'b_nut'), '1', '未覆盖的字段应保留');
	assert.equal(cookieValue(merged, 'SESSDATA'), 'xyz');
});

test('cookieValue 缺失时返回空串', () => {
	assert.equal(cookieValue('a=1', 'nope'), '');
	assert.equal(cookieValue('', 'a'), '');
});

test('userIdFromCookie 解析 DedeUserID', () => {
	assert.equal(userIdFromCookie('DedeUserID=1557129'), 1557129);
	assert.equal(userIdFromCookie('DedeUserID=1557129; SESSDATA=x'), 1557129);
	/* 缺失或不合法时必须是 0（匿名），不能是 NaN —— NaN 会让认证包带上非法 uid */
	assert.equal(userIdFromCookie(''), 0);
	assert.equal(userIdFromCookie('SESSDATA=x'), 0);
	assert.equal(userIdFromCookie('DedeUserID=0'), 0);
	assert.equal(userIdFromCookie('DedeUserID=-5'), 0);
	assert.equal(userIdFromCookie('DedeUserID=abc'), 0);
});

test('userIdFromCookie 在只有 ckMd5 时返回 0（不猜测 uid）', () => {
	/*
	 * DedeUserID__ckMd5 是 uid 的校验值，不是可逆编码；
	 * 与其猜一个错误 uid 送进认证包，不如老实按匿名处理。
	 */
	assert.equal(userIdFromCookie('DedeUserID__ckMd5=17c1899abcdef01'), 0);
});

test('buvidFromCookie 取 buvid3', () => {
	assert.equal(buvidFromCookie('buvid3=ABC; buvid4=DEF'), 'ABC');
	assert.equal(buvidFromCookie('buvid4=DEF'), '');
});

test('buildAuth：匿名时 uid=0 且 authenticated=false', () => {
	const auth = buildAuth({ anonymousCookie: 'buvid3=ANON; buvid4=B4; b_nut=1' });
	assert.equal(auth.uid, 0);
	assert.equal(auth.authenticated, false);
	assert.equal(auth.buvid, 'ANON');
	assert.match(auth.cookie, /buvid3=ANON/);
});

test('buildAuth：带登录态时解析出 uid 并标记已认证', () => {
	const auth = buildAuth({ anonymousCookie: 'buvid3=ANON; b_nut=1', loginCookie: LOGIN_COOKIE });
	assert.equal(auth.uid, 1557129);
	assert.equal(auth.authenticated, true);
	/* 用户的 buvid3 应覆盖匿名的 */
	assert.equal(auth.buvid, '4B8559FC-5939-641B-6256-FCA6588EEC2329234infoc');
	assert.match(auth.cookie, /SESSDATA=/);
});

test('buildAuth：配了 Cookie 但没有 DedeUserID 时退回匿名而不抛错', () => {
	const auth = buildAuth({ anonymousCookie: 'buvid3=ANON', loginCookie: 'SESSDATA=only' });
	assert.equal(auth.uid, 0);
	assert.equal(auth.authenticated, false);
	/* 但 Cookie 本身仍然带上：有些接口只看 SESSDATA */
	assert.match(auth.cookie, /SESSDATA=only/);
});

test('buildAuth：空白 loginCookie 等同匿名', () => {
	for (const v of ['', '   ', '\n']) {
		const auth = buildAuth({ anonymousCookie: 'buvid3=ANON', loginCookie: v });
		assert.equal(auth.authenticated, false, `loginCookie=${JSON.stringify(v)} 应为匿名`);
	}
});

test('buildAuthPacket：匿名时 uid=0', () => {
	const body = JSON.parse(
		buildAuthPacket({ uid: 0, roomId: 90932, token: 'T', buvid: 'B', queueUuid: 'q1' })
	);
	assert.equal(body.uid, 0);
	assert.equal(body.roomid, 90932);
	assert.equal(body.key, 'T');
	assert.equal(body.buvid, 'B');
	assert.equal(body.protover, 3, '用 brotli');
	assert.equal(body.platform, 'web');
	assert.equal(body.scene, 'room');
	assert.equal(body.support_ack, true);
});

test('buildAuthPacket：登录态时 uid 必须带上（否则昵称依旧打码）', () => {
	/*
	 * 这是匿名与登录唯一的差别。漏传不会有任何报错，
	 * 表现只是「昵称还是打码的」，所以用断言钉住。
	 */
	const body = JSON.parse(
		buildAuthPacket({ uid: 1557129, roomId: 1, token: 'T', buvid: 'B', queueUuid: 'q' })
	);
	assert.equal(body.uid, 1557129);
});

test('buildAuthPacket：queue_uuid 必须存在', () => {
	/*
	 * 不带 queue_uuid 时，同房间多条连接会被当成同一消费组被轮询分流，
	 * 每条连接只拿到一部分弹幕（参考实现实测差约 8 倍）。
	 */
	const body = JSON.parse(
		buildAuthPacket({ uid: 0, roomId: 1, token: 'T', buvid: 'B', queueUuid: 'abc12345' })
	);
	assert.equal(body.queue_uuid, 'abc12345');
});

test('buildAuthPacket 不含 Cookie（Cookie 只用于 HTTP API）', () => {
	const raw = buildAuthPacket({
		uid: 1557129,
		roomId: 1,
		token: 'T',
		buvid: 'B',
		queueUuid: 'q'
	});
	assert.ok(!raw.includes('SESSDATA'), '认证包不得携带 Cookie');
});

test('resolveAuth：校验通过时保留登录 uid', async () => {
	const { auth, warning } = await resolveAuth({
		anonymousCookie: 'buvid3=ANON',
		loginCookie: LOGIN_COOKIE,
		verify: async (cookie) => cookie.includes('SESSDATA=')
	});
	assert.equal(auth.uid, 1557129);
	assert.equal(auth.authenticated, true);
	assert.equal(warning, null);
});

test('resolveAuth：校验失败时降级为匿名并给出告警', async () => {
	/*
	 * 回归测试：实测在**不带 Cookie** 的情况下填一个真实 uid（官方账号 2），
	 * 弹幕服务器会以 1006 直接断开且不回认证回应 —— 比匿名连接还糟。
	 * 所以 Cookie 里能解析出 DedeUserID 并不等于服务端认可这个身份。
	 */
	const { auth, warning } = await resolveAuth({
		anonymousCookie: 'buvid3=ANON',
		loginCookie: LOGIN_COOKIE,
		verify: async () => false
	});
	assert.equal(auth.uid, 0, '校验失败必须退回 uid=0');
	assert.equal(auth.authenticated, false);
	assert.ok(warning, '必须给出告警，否则使用者以为已登录');
	assert.match(warning!, /过期|失效/);
});

test('resolveAuth：校验抛错也按失败处理，不向上抛', async () => {
	const { auth, warning } = await resolveAuth({
		anonymousCookie: 'buvid3=ANON',
		loginCookie: LOGIN_COOKIE,
		verify: async () => {
			throw new Error('网络炸了');
		}
	});
	assert.equal(auth.authenticated, false);
	assert.ok(warning);
});

test('resolveAuth：匿名连接不调用校验（省一次请求）', async () => {
	let called = false;
	const { auth, warning } = await resolveAuth({
		anonymousCookie: 'buvid3=ANON',
		loginCookie: '',
		verify: async () => {
			called = true;
			return true;
		}
	});
	assert.equal(called, false);
	assert.equal(auth.authenticated, false);
	assert.equal(warning, null, '没配 Cookie 不该告警');
});

test('resolveAuth：无 verify 回调时不做校验（单测/离线场景）', async () => {
	const { auth } = await resolveAuth({ anonymousCookie: 'buvid3=ANON', loginCookie: LOGIN_COOKIE });
	assert.equal(auth.authenticated, true);
});

/* ---- 脱敏：这是安全相关的核心断言 ---- */

test('redactCookie 绝不泄漏凭据原值', () => {
	const out = redactCookie(LOGIN_COOKIE);
	assert.ok(!out.includes(REAL_SESSDATA), 'SESSDATA 原值不得出现');
	assert.ok(!out.includes(REAL_JCT), 'bili_jct 原值不得出现');
	assert.match(out, /SESSDATA=\*\*\*/);
	assert.match(out, /bili_jct=\*\*\*/);
});

test('redactCookie 保留公开 uid（排查登错号的关键线索）', () => {
	const out = redactCookie(LOGIN_COOKIE);
	assert.match(out, /DedeUserID=1557129/, 'uid 是公开信息，应可读');
});

test('redactCookie 对 buvid 只留前 8 位', () => {
	const out = redactCookie(LOGIN_COOKIE);
	assert.match(out, /buvid3=4B8559FC…/);
	assert.ok(!out.includes('FCA6588EEC2329234infoc'), 'buvid 完整值不得出现');
});

test('redactCookie 覆盖各种凭据字段名（大小写不敏感）', () => {
	for (const name of ['SESSDATA', 'sessdata', 'bili_jct', 'csrf', 'Sfa', 'sid', 'ckMd5']) {
		const out = redactCookie(`${name}=SUPERSECRETVALUE`);
		assert.ok(!out.includes('SUPERSECRETVALUE'), `${name} 未被脱敏: ${out}`);
	}
});

test('redactCookie 对空 Cookie 给出可读结果', () => {
	assert.equal(redactCookie(''), '(空)');
});

test('redactCookie 输出可以直接进日志（不含换行）', () => {
	const out = redactCookie('a=1\nb=2');
	assert.ok(!out.includes('\n'), '脱敏结果不应含换行，避免伪造日志行');
});

test('isMaskedName 识别 B 站的打码昵称', () => {
	assert.equal(isMaskedName('赛***'), true);
	assert.equal(isMaskedName('x***'), true);
	assert.equal(isMaskedName('夜航船'), false);
	assert.equal(isMaskedName(''), false);
	/* 单个星号不算打码（真实昵称里可能有 *） */
	assert.equal(isMaskedName('a*b'), false);
});

/* ==================== 扫码登录 ==================== */

/*
 * 「登录成功」这一分支需要真人扫码，无法在无人值守环境复现，
 * 因此把解析全部做成纯函数，用**实测得到的真实报文**做夹具。
 */

test('parseQrStatus 覆盖实测到的四种状态码', () => {
	/* 未扫码：实测连续轮询 8 次都稳定返回 86101 */
	assert.equal(parseQrStatus(QR_CODE.PENDING), 'pending');
	assert.equal(parseQrStatus(QR_CODE.SCANNED), 'scanned');
	assert.equal(parseQrStatus(QR_CODE.SUCCESS), 'success');
	assert.equal(parseQrStatus(QR_CODE.EXPIRED), 'expired');
});

test('parseQrStatus 对未知码给 unknown 而不是误判成功', () => {
	/* 关键：宁可显示「未知」也不能把非零码当成登录成功 */
	for (const code of [undefined, -1, 1, -101, 86102, 99999]) {
		assert.notEqual(parseQrStatus(code as number), 'success', `code=${code} 不应判定成功`);
	}
	assert.equal(parseQrStatus(undefined), 'unknown');
});

test('每个状态都有给人看的文案', () => {
	for (const st of ['pending', 'scanned', 'success', 'expired', 'timeout', 'unknown'] as const) {
		assert.ok(QR_STATUS_TEXT[st]?.length > 0, `${st} 缺文案`);
	}
});

test('超时与过期是不同的状态（不能混为一谈）', () => {
	/*
	 * 回归测试：曾经把超时直接标成 expired，于是打印出
	 * 「二维码已过期（状态码 86101）」—— 86101 其实是「未扫码」，
	 * 使用者会以为二维码失效，实际只是没人扫。
	 */
	assert.notEqual(QR_STATUS_TEXT.timeout, QR_STATUS_TEXT.expired);
	assert.match(QR_STATUS_TEXT.timeout, /超时/);
	assert.match(QR_STATUS_TEXT.expired, /过期/);
});

test('extractLoginCookie 只保留凭据字段并剥掉 Cookie 属性', () => {
	/*
	 * 真实 Set-Cookie 会带 Path/Expires/HttpOnly 等属性，
	 * 直接拼进 Cookie 头会污染请求，必须按第一个分号截断。
	 */
	const setCookies = [
		'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jan 2027 00:00:00 GMT; HttpOnly',
		'bili_jct=deadbeef; Path=/; Domain=.bilibili.com',
		'DedeUserID=1557129; Path=/',
		'DedeUserID__ckMd5=abcdef0123456789; Path=/',
		'sid=xyz789; Path=/'
	];
	const out = extractLoginCookie(setCookies);
	assert.match(out, /SESSDATA=abc%2Cdef/);
	assert.match(out, /bili_jct=deadbeef/);
	assert.match(out, /DedeUserID=1557129/);
	assert.ok(!out.includes('Path='), '不得包含 Cookie 属性');
	assert.ok(!out.includes('HttpOnly'), '不得包含 Cookie 属性');
	assert.ok(!out.includes('Domain='), '不得包含 Cookie 属性');
	assert.ok(!out.includes('Expires='), '不得包含 Cookie 属性');
});

test('extractLoginCookie 过滤无关字段与空值', () => {
	const out = extractLoginCookie([
		'SESSDATA=good; Path=/',
		'LIVE_BUVID=AUTO123; Path=/',
		'buvid3=; Path=/',
		'b_nut=123; Path=/'
	]);
	assert.match(out, /SESSDATA=good/);
	assert.ok(!out.includes('LIVE_BUVID'), '无关字段应丢弃');
	assert.ok(!out.includes('b_nut'), '无关字段应丢弃');
	assert.ok(!out.includes('buvid3=;'), '空值应丢弃（B 站会下发清除指令）');
});

test('extractLoginCookie 没有 SESSDATA 时返回空（视为未登录成功）', () => {
	assert.equal(extractLoginCookie(['bili_jct=x; Path=/', 'DedeUserID=1; Path=/']), '');
	assert.equal(extractLoginCookie([]), '');
	assert.equal(extractLoginCookie(['garbage']), '');
});

test('extractLoginCookie 能处理没有属性的裸 Cookie', () => {
	assert.equal(extractLoginCookie(['SESSDATA=raw']), 'SESSDATA=raw');
});

test('extractLoginCookie 对畸形输入不抛错', () => {
	assert.doesNotThrow(() => extractLoginCookie(['', '; ', '=x', 'SESSDATA=']));
	assert.equal(extractLoginCookie(['', '=x', 'SESSDATA=']), '');
});

test('extractLoginCookieFromUrl 从跳转地址兜底取凭据', () => {
	/* 旧版行为：凭据出现在 poll 返回的 url 查询串里（这里用占位值避免像真凭据） */
	const url =
		'https://www.bilibili.com/?DedeUserID=1557129&Expires=9999999999' +
		'&SESSDATA=PLACEHOLDER%2CFAKE&bili_jct=PLACEHOLDERJCT&sid=PLACEHOLDERSID';
	const out = extractLoginCookieFromUrl(url);
	assert.match(out, /SESSDATA=PLACEHOLDER%2CFAKE/, '应保留 URL 编码形态');
	assert.match(out, /DedeUserID=1557129/);
	assert.match(out, /bili_jct=PLACEHOLDERJCT/);
	assert.ok(!out.includes('Expires='), '无关参数应丢弃');
});

test('extractLoginCookieFromUrl 缺 SESSDATA 或非法地址时返回空', () => {
	assert.equal(extractLoginCookieFromUrl(''), '');
	assert.equal(extractLoginCookieFromUrl('not-a-url'), '');
	assert.equal(extractLoginCookieFromUrl('https://x.com/?DedeUserID=1'), '');
});

/* ==================== 凭据文件 ==================== */

test('writeCookieFile / readCookieFile 往返一致', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'nested', 'bili-cookie.txt');
		const written = writeCookieFile(path, 'SESSDATA=a; DedeUserID=1');
		assert.equal(written, resolve(path), '应返回绝对路径');
		assert.equal(readCookieFile(path), 'SESSDATA=a; DedeUserID=1');
	});
});

test('writeCookieFile 自动创建父目录', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'a', 'b', 'c', 'cookie.txt');
		assert.doesNotThrow(() => writeCookieFile(path, 'SESSDATA=x'));
		assert.equal(readCookieFile(path), 'SESSDATA=x');
	});
});

test('writeCookieFile 权限为 600，且覆盖已存在文件时也会收紧', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'cookie.txt');

		/* 先造一个宽松权限的文件，模拟手工创建过 */
		await writeFile(path, 'old', { mode: 0o644 });
		assert.equal(isRestrictive(path), false, '前置条件：初始权限应过宽');

		writeCookieFile(path, 'SESSDATA=new');
		assert.equal(isRestrictive(path), true, '覆盖写入后应变成仅本人可读写');
	});
});

test('writeCookieFile 去掉首尾空白并补换行', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'c.txt');
		writeCookieFile(path, '   SESSDATA=x   \n');
		assert.equal(await readFile(path, 'utf8'), 'SESSDATA=x\n');
	});
});

test('readCookieFile 把多行 Cookie 压成一行', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'c.txt');
		/* 浏览器复制出来的 Cookie 常带换行 */
		await writeFile(path, 'SESSDATA=a;\n  bili_jct=b;\n  DedeUserID=1\n', 'utf8');
		const out = readCookieFile(path);
		assert.ok(!out.includes('\n'), '结果不得含换行，否则会形成非法请求头');
		assert.equal(out, 'SESSDATA=a; bili_jct=b; DedeUserID=1');
	});
});

test('readCookieFile 文件不存在或为空时返回空串而不抛错', async () => {
	await withTempDir(async (dir) => {
		assert.equal(readCookieFile(join(dir, 'nope.txt')), '');
		const empty = join(dir, 'empty.txt');
		await writeFile(empty, '   \n  ', 'utf8');
		assert.equal(readCookieFile(empty), '');
	});
});

test('isRestrictive 判定 group/other 位', async () => {
	await withTempDir(async (dir) => {
		for (const [mode, expected] of [
			[0o600, true],
			[0o400, true],
			[0o640, false],
			[0o644, false],
			[0o666, false]
		] as const) {
			const path = join(dir, `m${mode.toString(8)}`);
			await writeFile(path, 'x', { mode });
			chmodSync(path, mode);
			assert.equal(isRestrictive(path), expected, `mode=${mode.toString(8)}`);
		}
		/* 不存在的文件不应抛错 */
		assert.equal(isRestrictive(join(dir, 'missing')), false);
	});
});

test('默认凭据路径与文档/容器挂载点保持一致', () => {
	/*
	 * 回归测试：CLI 的默认输出路径必须与 compose 挂载点对得上，
	 * 否则会出现「扫码成功但服务仍匿名」这种极难排查的现象。
	 */
	assert.equal(DEFAULT_COOKIE_FILE, 'secrets/bili-cookie.txt');
});

/* ==================== 管理会话签名 ==================== */

const TOKEN = 'unit-test-token';

test('管理会话：签发的会话可被校验通过', () => {
	const s = issueSession(TOKEN);
	assert.equal(verifySession(s, TOKEN), true);
});

test('管理会话：换口令即失效（轮换口令 = 吊销所有会话）', () => {
	/*
	 * 密钥由口令派生，所以改 LOGIN_TOKEN 等于立刻让所有已下发的会话失效。
	 * 这是无状态签名方案的代价与收益：不能单独吊销某一个，但轮换是彻底的。
	 */
	const s = issueSession(TOKEN);
	assert.equal(verifySession(s, 'another-token'), false);
});

test('管理会话：篡改签名或过期时间都不通过', () => {
	const s = issueSession(TOKEN);
	const [exp, sig] = s.split('.');

	assert.equal(verifySession(`${exp}.${sig}x`, TOKEN), false, '签名尾部被改');
	assert.equal(verifySession(`${exp}.x${sig.slice(1)}`, TOKEN), false, '签名首部被改');
	/* 把过期时间往后改，签名就对不上了 —— 这正是签名的意义 */
	assert.equal(verifySession(`${Number(exp) + 100_000}.${sig}`, TOKEN), false, '延长过期时间');
});

test('管理会话：过期后不通过', () => {
	const now = 1_700_000_000_000;
	const s = issueSession(TOKEN, now);

	assert.equal(verifySession(s, TOKEN, now + 1000), true, '有效期内应通过');
	assert.equal(verifySession(s, TOKEN, now + ADMIN_TTL_MS - 1), true, '临到期前应通过');
	assert.equal(verifySession(s, TOKEN, now + ADMIN_TTL_MS + 1), false, '过期后应拒绝');
});

test('管理会话：空值、空口令、畸形输入一律拒绝', () => {
	for (const bad of [undefined, null, '', 'no-dot', '.sig', 'abc.sig', '123.', '12.34']) {
		assert.equal(verifySession(bad as string, TOKEN), false, `应拒绝: ${String(bad)}`);
	}
	/* 未配置口令时必须拒绝，而不是「没有口令就等于放行」 */
	assert.equal(verifySession(issueSession(TOKEN), ''), false, '空口令不得放行');
});

test('管理会话：不同口令签发的会话互不通融', () => {
	const a = issueSession('token-a');
	const b = issueSession('token-b');
	assert.equal(verifySession(a, 'token-b'), false);
	assert.equal(verifySession(b, 'token-a'), false);
	assert.equal(verifySession(a, 'token-a'), true);
	assert.equal(verifySession(b, 'token-b'), true);
});

test('管理会话：两次签发同一时刻结果为确定值（便于断言）', () => {
	const now = 1_700_000_000_000;
	assert.equal(issueSession(TOKEN, now), issueSession(TOKEN, now));
});

test('管理会话 Cookie：HttpOnly + SameSite=Strict + Path=/', () => {
	const o = sessionCookieOptions(false);
	assert.equal(o.httpOnly, true, 'JS 必须读不到（XSS 也偷不走）');
	assert.equal(o.sameSite, 'strict', '管理操作有副作用，必须防 CSRF');
	assert.equal(o.path, '/', '需在 /admin 与 /api/login/* 上都能带上');
	assert.equal(o.maxAge, Math.floor(ADMIN_TTL_MS / 1000));
});

test('管理会话 Cookie：secure 必须随实际协议，不能写死', () => {
	/*
	 * 回归测试：SvelteKit 的 cookie 默认 secure 除 localhost 外全为 true。
	 * 本项目 compose 默认把端口发布到 0.0.0.0，即从局域网 http 访问，
	 * 此时若带 Secure，浏览器会**直接丢弃** Cookie ——
	 * 表现为「登入提示成功但页面依旧未授权」，极难排查。
	 */
	assert.equal(sessionCookieOptions(false).secure, false, 'http 下不得加 Secure');
	assert.equal(sessionCookieOptions(true).secure, true, 'https 下应加 Secure');
});

test('isSecureRequest 识别协议与反向代理头', () => {
	const mk = (proto: string, xfp?: string) =>
		isSecureRequest(
			new Request('http://example.com/', xfp ? { headers: { 'x-forwarded-proto': xfp } } : undefined),
			new URL(proto + '://example.com/')
		);

	assert.equal(mk('https'), true);
	assert.equal(mk('http'), false);
	assert.equal(mk('http', 'https'), true, '反代终止 TLS 时应识别');
	assert.equal(mk('http', 'https, http'), true, '多级代理取第一段');
	assert.equal(mk('https', 'http'), false, 'XFP 优先于 url');
});

/* ==================== 二维码渲染 ==================== */

test('qrMatrix 输出奇数模块数（二维码规范要求）', () => {
	for (const text of ['a', 'https://example.com/', 'x'.repeat(200)]) {
		const m = qrMatrix(text);
		assert.equal(m.count % 2, 1, `内容长度 ${text.length} 时模块数应为奇数`);
		assert.ok(m.count >= 21, '最小版本为 21 模块');
	}
});

test('qrMatrix 空内容抛错而不是产出无效码', () => {
	assert.throws(() => qrMatrix(''), /不能为空/);
});

test('qrMatrix 相同输入结果稳定（同一内容必须出同一张图）', () => {
	const a = qrMatrix('https://example.com/stable');
	const b = qrMatrix('https://example.com/stable');
	assert.equal(a.count, b.count);
	for (let r = 0; r < a.count; r++) {
		for (let c = 0; c < a.count; c++) {
			assert.equal(a.isDark(r, c), b.isDark(r, c), `(${r},${c}) 不一致`);
		}
	}
});

test('qrSvg 产出合法 SVG 且含深色模块', () => {
	const svg = qrSvg('https://example.com/x');
	assert.ok(svg.startsWith('<svg '), '应以 <svg 开头');
	assert.ok(svg.endsWith('</svg>'), '应以 </svg> 结尾');
	assert.ok(svg.includes('<path'), '应有承载模块的 path');
	assert.ok(svg.includes('viewBox='), '应有 viewBox 以便缩放');
	assert.ok(svg.includes('shape-rendering="crispEdges"'), '像素风需要关闭抗锯齿');
});

test('qrSvg 静默区不低于规范下限 4 模块', () => {
	/*
	 * 静默区是二维码能被识别的必要条件，缺了定位图案会被裁掉。
	 * 这里验证下限保护真的生效 —— 调用方传 0 也不该画出无法扫描的码。
	 */
	for (const margin of [0, 1, -5]) {
		const svg = qrSvg('https://example.com/m', { margin, cell: 4 });
		const n = qrMatrix('https://example.com/m').count;
		const expected = (n + QR_MIN_MARGIN * 2) * 4;
		assert.ok(
			svg.includes(`viewBox="0 0 ${expected} ${expected}"`),
			`margin=${margin} 时尺寸应仍按下限 ${QR_MIN_MARGIN} 计算`
		);
	}
});

test('qrSvg 转义颜色值，避免 SVG 注入', () => {
	const svg = qrSvg('https://example.com/i', {
		dark: '"/><script>alert(1)</script><path d="'
	});
	assert.ok(!svg.includes('<script'), '不得出现未转义的 <script>');
	assert.ok(svg.includes('&lt;script&gt;'), '应转义为实体');
	assert.ok(!svg.includes('"/><script'), '不得破坏属性结构');
});

test('qrSvg 尺寸随 cell 线性增长', () => {
	const small = qrSvg('https://example.com/s', { cell: 4 });
	const big = qrSvg('https://example.com/s', { cell: 8 });
	const w = (svg: string): number => Number(svg.match(/width="(\d+)"/)![1]);
	assert.equal(w(big), w(small) * 2);
});

/* ==================== 恒定时间比较与令牌 ==================== */

test('safeEqual 正确判定相等与不等', () => {
	assert.equal(safeEqual('abc', 'abc'), true);
	assert.equal(safeEqual('abc', 'abd'), false);
	assert.equal(safeEqual('abc', 'abcd'), false, '长度不同应为 false 而非抛错');
	assert.equal(safeEqual('', ''), false, '空串不得视为相等，否则等于无口令放行');
	assert.equal(safeEqual('abc', ''), false);
});

test('generateToken 长度正确且字面不易混淆', () => {
	for (let i = 0; i < 30; i++) {
		const t = generateToken(6);
		assert.equal(t.length, 6);
		/* 去掉 0/O、1/l/I 等易混字符，因为要人工从终端抄进网页 */
		assert.ok(!/[01loIO]/.test(t), `不应含易混字符: ${t}`);
	}
});

test('generateToken 多次调用不重复', () => {
	const seen = new Set(Array.from({ length: 50 }, () => generateToken(8)));
	assert.equal(seen.size, 50, '50 次生成应互不相同');
});

/* ==================== 登录会话状态机 ==================== */

/** 造一个可控的登录会话，网络层全部替换成假实现 */
function makeSession(over: Partial<ConstructorParameters<typeof LoginSession>[0]> = {}) {
	const calls = { success: 0, svg: 0 };
	const session = new LoginSession({
		renderSvg: (url) => {
			calls.svg++;
			return `<svg data-url="${url}"/>`;
		},
		onSuccess: async () => {
			calls.success++;
			return { uid: 1557129, uname: '测试账号' };
		},
		...over
	});
	return { session, calls };
}

test('LoginSession 初始无活动挑战', () => {
	const { session } = makeSession();
	assert.equal(session.active, false);
});

test('LoginSession 取消后回到无活动状态', async () => {
	const { session } = makeSession();
	await session.start();
	assert.equal(session.active, true);
	const after = session.cancel();
	assert.equal(session.active, false);
	assert.equal(after.status, 'pending');
});

test('LoginSession 在节流窗口内不重复打 B 站接口', async () => {
	/*
	 * 节流必须在服务端做：前端的 setInterval 可被绕过，
	 * 一个刷新循环就能把 B 站轮询接口打到限流。
	 */
	let now = 1_000_000;
	let polls = 0;
	const { session } = makeSession({
		now: () => now,
		pollOnce: async () => {
			polls++;
			return { status: 'pending', cookie: '', redirectUrl: '', rawCode: 86101 };
		}
	});

	await session.start();

	/* 连续 5 次调用都落在 900ms 节流窗口内 → 只应真正打 1 次网络 */
	for (let i = 0; i < 5; i++) {
		now += 10;
		await session.poll();
	}
	assert.equal(polls, 1, `节流窗口内应只请求 1 次，实际 ${polls} 次`);

	/* 越过窗口后再调用应放行 */
	now += 1_000;
	await session.poll();
	assert.equal(polls, 2, '越过节流窗口后应放行');
});

test('LoginSession 成功后结算，onSuccess 只调用一次', async () => {
	/*
	 * 关键回归：成功路径若未及时置 settled，
	 * 后续轮询会重复调用 onSuccess —— 重复写凭据文件、重复重连采集。
	 *
	 * 注意两道防线是分层的：同一节流窗口内的并发轮询会被**节流**挡掉
	 * （返回快照，不透传），而 settled 负责挡掉窗口之后的所有重放。
	 * 这里验证的是后者。
	 */
	let now = 1_000_000;
	const { session, calls } = makeSession({
		now: () => now,
		pollOnce: async () => ({
			status: 'success',
			cookie: 'SESSDATA=abc; DedeUserID=1557129',
			redirectUrl: '',
			rawCode: 0
		})
	});

	await session.start();

	now += 1_000;
	const first = await session.poll();
	assert.equal(first.status, 'success');
	assert.equal(calls.success, 1, `首次成功应调用 onSuccess 1 次，实际 ${calls.success}`);
	assert.equal(first.account?.uid, 1557129);
	assert.equal(first.account?.uname, '测试账号');
	assert.equal(session.active, false, '结算后不应再有活动挑战');

	/* 越过节流窗口再轮询多次：状态仍是 success，但不得重复结算 */
	for (let i = 0; i < 3; i++) {
		now += 5_000;
		const again = await session.poll();
		assert.equal(again.status, 'success', '应保持成功状态');
		assert.equal(again.account?.uid, 1557129, '账号信息应仍在快照里');
	}
	assert.equal(calls.success, 1, `onSuccess 不得重复调用，实际 ${calls.success} 次`);
});

test('LoginSession 同一节流窗口内的并发轮询不透传成功', async () => {
	/*
	 * 记录真实语义：节流命中时返回的是**快照**，不推进状态。
	 * 因此并发轮询不会让成功被重复结算 —— 这是 settled 之外的独立防线。
	 */
	let now = 1_000_000;
	const { session, calls } = makeSession({
		now: () => now,
		pollOnce: async () => ({
			status: 'success',
			cookie: 'SESSDATA=abc',
			redirectUrl: '',
			rawCode: 0
		})
	});

	await session.start();
	now += 1_000;

	/* 三个调用同一时刻发起：只有第一个能进入网络层 */
	const results = await Promise.all([session.poll(), session.poll(), session.poll()]);
	const successCount = results.filter((r) => r.status === 'success').length;

	assert.equal(successCount, 1, `只有首个应成功，实际 ${successCount} 个`);
	assert.equal(calls.success, 1, 'onSuccess 只应调用一次');
});

test('LoginSession 成功但无凭据时报错而非静默降级匿名', async () => {
	/*
	 * 「登录成功但拿不到 SESSDATA」必须显式报错：
	 * 静默降级会让使用者以为登录成功了，之后才发现昵称还在打码。
	 */
	let now = 1_000_000;
	const { session, calls } = makeSession({
		now: () => now,
		pollOnce: async () => ({ status: 'success', cookie: '', redirectUrl: '', rawCode: 0 })
	});

	await session.start();
	now += 1_000;
	const s = await session.poll();

	assert.equal(s.status, 'unknown');
	assert.match(s.error ?? '', /SESSDATA/);
	assert.equal(calls.success, 0, '无凭据时不应调用 onSuccess');
});

test('LoginSession 网络抖动不终结流程，且错误可见', async () => {
	let now = 1_000_000;
	let attempt = 0;
	const { session } = makeSession({
		now: () => now,
		pollOnce: async () => {
			attempt++;
			if (attempt === 1) throw new Error('ECONNRESET');
			return { status: 'pending', cookie: '', redirectUrl: '', rawCode: 86101 };
		}
	});

	await session.start();

	now += 1_000;
	const first = await session.poll();
	/* 错误要透出去，否则界面会一直停在「等待扫码」，无法区分「没人扫」和「网络挂了」 */
	assert.match(first.error ?? '', /ECONNRESET/);
	assert.equal(session.active, true, '网络抖动后流程应仍然可继续');

	now += 1_000;
	const second = await session.poll();
	assert.equal(second.status, 'pending');
});

test('LoginSession onSuccess 抛错时把原因暴露给界面', async () => {
	let now = 1_000_000;
	const { session } = makeSession({
		now: () => now,
		onSuccess: async () => {
			throw new Error('EROFS: read-only file system');
		},
		pollOnce: async () => ({
			status: 'success',
			cookie: 'SESSDATA=abc',
			redirectUrl: '',
			rawCode: 0
		})
	});

	await session.start();
	now += 1_000;
	const s = await session.poll();

	assert.match(s.error ?? '', /凭据保存失败/);
	assert.match(s.error ?? '', /EROFS/);
});

test('LoginSession 本地超时置为 expired 而非 timeout', async () => {
	/*
	 * 回归：超时（未扫码）与过期（B 站判失效）语义不同。
	 * 混淆会向使用者输出「二维码已过期（状态码 86101）」这种自相矛盾的提示。
	 */
	let now = 5_000_000;
	const { session } = makeSession({ now: () => now });
	await session.start();

	/* 直接跳过 TTL（175s） */
	now += 200_000;
	const s = await session.poll();
	assert.equal(s.status, 'expired');
	assert.equal(s.remainingMs, 0);
	assert.equal(session.active, false, '过期后不应再有活动挑战');
});

test('LoginSession 轮询永不回传二维码图（图即凭据等价物）', async () => {
	/*
	 * 回归：轮询接口曾经支持 ?svg=1，但它没有调用方，且会把二维码重新发出去。
	 * 二维码就是 qrcode_key 的图形编码，而持有 key 的人能在扫码成功后领走凭据
	 * （已实测：可把下图解码还原出 key 并独立轮询），因此它是凭据等价物，
	 * 不该被反复取回。状态变化时码本身不变，重传也毫无意义。
	 */
	let now = 1_000_000;
	const { session } = makeSession({
		now: () => now,
		pollOnce: async () => ({ status: 'pending', cookie: '', redirectUrl: '', rawCode: 86101 })
	});

	await session.start();
	for (let i = 0; i < 3; i++) {
		now += 5_000;
		const s = await session.poll();
		assert.equal(s.svg, undefined, '轮询结果不得包含二维码图');
	}
});

test('LoginSession 快照默认不带 SVG，显式请求才带', async () => {
	/* 轮询是高频调用，每次都塞几十 KB 的 SVG 纯属浪费 */
	const { session } = makeSession();
	const started = await session.start();
	assert.ok(started.svg, '开起时应带图，否则界面没东西可显示');

	const plain = session.cancel();
	assert.equal(plain.svg, undefined, '取消后的快照不应带图');
});

test('LoginSession 剩余时间随时钟递减', async () => {
	let now = 0;
	const { session } = makeSession({ now: () => now });
	const started = await session.start();
	const t0 = started.remainingMs;

	now += 60_000;
	const later = await session.poll();
	assert.ok(later.remainingMs < t0, `剩余时间应减少: ${t0} -> ${later.remainingMs}`);
	assert.ok(later.remainingMs > 0);
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
