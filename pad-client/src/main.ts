#!/usr/bin/env node
/**
 * live-template 手柄采集端。
 *
 * 存在的原因：浏览器只能在**拥有焦点**的窗口里读手柄，而 OBS 浏览器源是无焦点离屏窗口 ——
 * 于是「OBS 不在前台，手柄框就不动」。OBS ≥ 31.0.2 修掉了 Windows.Gaming.Input 那一层，
 * 但「浏览器源不可见时 rAF 被节流」仍在。把采集搬到进程外就同时绕开了这两件事。
 *
 * 用法：
 *   npm start -- --server http://192.168.1.10:8080 --token 你的PAD_TOKEN
 *   npm run list                       # 只列出手柄，确认驱动/连接是否正常
 *
 * 状态机很简单：60Hz 采样 → 与上一帧比较 → 有变化或过了心跳间隔就发。
 */
import { PAD_SAMPLE_MS, sameState, type PadState } from '../../src/lib/shared/pad.ts';
import { PadReporter } from './reporter.ts';
import { SdlPad } from './sdl.ts';

/** 状态没变时也发一包，让服务端的看门狗（2s）知道采集端还活着 */
const HEARTBEAT_MS = 1000;

interface Options {
	server: string;
	token: string;
	slot: string;
	rate: number;
	index: number;
	list: boolean;
	verbose: boolean;
}

const USAGE = `live-template 手柄采集端

用法：
  npm start -- [选项]

选项：
  --server <url>   直播模板服务地址，http(s):// 或 ws(s):// 均可
                   默认取环境变量 PAD_SERVER，否则 http://127.0.0.1:8080
  --token <口令>   与服端 PAD_TOKEN 相同的口令
                   默认取环境变量 PAD_TOKEN
  --slot <名字>    玩家位，默认 p1（页面按 slot 取帧）
  --rate <hz>      采样率，默认 60（10–240）
  --index <n>      用第 n 个手柄设备（0 起），默认 0
  --list           只列出手柄设备后退出，用于排查驱动/连接
  --verbose        打印每帧的按键变化
  -h, --help       显示本帮助

示例：
  npm start -- --server http://192.168.1.10:8080 --token 8f3k2m9q
`;

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		server: process.env.PAD_SERVER ?? 'http://127.0.0.1:8080',
		token: process.env.PAD_TOKEN ?? '',
		slot: process.env.PAD_SLOT ?? 'p1',
		rate: 60,
		index: 0,
		list: false,
		verbose: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${arg} 缺少参数值`);
			return v;
		};
		switch (arg) {
			case '--server':
				opts.server = next();
				break;
			case '--token':
				opts.token = next();
				break;
			case '--slot':
				opts.slot = next();
				break;
			case '--rate':
				opts.rate = Number(next());
				break;
			case '--index':
				opts.index = Number(next());
				break;
			case '--list':
				opts.list = true;
				break;
			case '--verbose':
				opts.verbose = true;
				break;
			case '-h':
			case '--help':
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				throw new Error(`未知参数：${arg}\n\n${USAGE}`);
		}
	}

	if (!Number.isFinite(opts.rate)) throw new Error('--rate 需要数字');
	opts.rate = Math.min(240, Math.max(10, Math.round(opts.rate)));
	if (!Number.isFinite(opts.index) || opts.index < 0) throw new Error('--index 需要非负整数');
	if (!/^[a-z0-9_-]{1,16}$/i.test(opts.slot)) throw new Error('--slot 只能含字母数字下划线横线');
	return opts;
}

/** 拼出上报地址；token 放在 query 里（与 /ws/pad 的约定一致） */
function padUrl(server: string, slot: string, token: string): string {
	let base = server.trim().replace(/\/+$/, '');
	if (!/^wss?:\/\//i.test(base)) {
		if (/^https:\/\//i.test(base)) base = base.replace(/^https:\/\//i, 'wss://');
		else if (/^http:\/\//i.test(base)) base = base.replace(/^http:\/\//i, 'ws://');
		else base = `ws://${base}`;
	}
	const url = new URL('/ws/pad', `${base}/`);
	url.searchParams.set('role', 'pub');
	url.searchParams.set('slot', slot);
	url.searchParams.set('token', token);
	return url.toString();
}

function stamp(): string {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg: string): void {
	console.log(`[${stamp()}] ${msg}`);
}

/** 只列出「按下了什么」，用于 --verbose */
function describe(state: PadState): string {
	const on = Object.entries(state.buttons)
		.filter(([, b]) => b.pressed)
		.map(([name, b]) => (b.value < 1 ? `${name}:${Math.round(b.value * 100)}` : name));
	const axes = state.axes
		.map((v, i) => (v === 0 ? null : `${['LX', 'LY', 'RX', 'RY'][i]}=${v.toFixed(2)}`))
		.filter(Boolean);
	const parts = [...on, ...axes];
	return parts.length > 0 ? parts.join(' ') : '（无输入）';
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));

	const pad = new SdlPad({ index: opts.index, log });
	await pad.init();

	if (opts.list) {
		const devices = pad.devices();
		if (devices.length === 0) {
			console.log('没有检测到手柄。检查：USB/蓝牙是否连上、驱动是否正常、是否被别的程序独占。');
			return;
		}
		console.log(`检测到 ${devices.length} 个手柄设备：`);
		devices.forEach((d, i) => console.log(`  [${i}] ${d.name}  type=${d.type ?? '未知'}`));
		return;
	}

	if (!opts.token) {
		console.error(
			'缺少上报口令：用 --token 或环境变量 PAD_TOKEN 指定，值需与服务端的 PAD_TOKEN 一致。' +
				'\n（服务端未设置 PAD_TOKEN 时手柄上报是关闭状态，见 README）'
		);
		process.exit(1);
	}

	const url = padUrl(opts.server, opts.slot, opts.token);
	const reporter = new PadReporter({ url, log });

	/* 日志里绝不带 token，只报「连哪儿、哪个玩家位」 */
	log(`服务端 ${opts.server} · 玩家位 ${opts.slot} · 采样 ${opts.rate}Hz`);
	const detected = pad.devices();
	log(
		detected.length > 0
			? `手柄：${detected[opts.index]?.name ?? detected[0].name}`
			: '暂未检测到手柄，插上后会自动识别'
	);

	reporter.start();

	const interval = Math.max(PAD_SAMPLE_MS, Math.round(1000 / opts.rate));
	let seq = 0;
	let last: PadState | null = null;
	let lastSent = 0;
	let lastLine = '';

	const timer = setInterval(() => {
		const state = pad.poll();
		const now = Date.now();
		const changed = last === null || !sameState(last, state);

		if (!changed && now - lastSent < HEARTBEAT_MS) return;

		last = state;
		lastSent = now;
		reporter.send({ t: 'pad', slot: opts.slot, seq: ++seq, ts: now, state });

		if (opts.verbose) {
			const line = state.connected ? `${state.id} › ${describe(state)}` : '未连接手柄';
			/* 只在内容变化时出行，避免 60Hz 刷屏 */
			if (line !== lastLine) {
				lastLine = line;
				log(line);
			}
		}
	}, interval);

	const shutdown = (): void => {
		clearInterval(timer);
		reporter.stop();
		pad.close();
		log('已退出');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
	console.error(`启动失败：${(err as Error).message}`);
	process.exitCode = 1;
});
