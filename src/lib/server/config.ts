/**
 * 服务端配置加载。
 *
 * 优先级：环境变量 > config.json > 内置默认值。
 * （URL 查询参数优先级最高，但只影响单个页面的视图开关，在 shared/view.ts 处理。）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRestrictive, readCookieFile } from './credential';
import type { ViewOptions } from '$lib/shared/view';

export interface Config {
	/** HTTP 监听端口 */
	port: number;
	/** HTTP 监听地址 */
	host: string;
	/** B 站直播间号，支持短号 */
	room: string;
	/** 造弹幕 + 造手柄输入 */
	mock: boolean;
	/** 调试控制条 */
	hud: boolean;
	/** 仅视频框内容区透明 */
	videoHole: boolean;
	/** 框体标题文字 */
	labels: boolean;
	/** 尺寸标注与四角括号 */
	guides: boolean;
	/** JSONL 落盘目录 */
	dataDir: string;
	/** 房间引用计数归零后断开 B 站连接的延时 */
	idleMs: number;
	/** 新客户端连接时回显的弹幕条数（读自当天 JSONL） */
	echoCount: number;
	/** 日志级别 */
	logLevel: 'debug' | 'info' | 'warn' | 'error';
	/**
	 * B 站登录态 Cookie。
	 *
	 * 留空即匿名连接，此时 B 站返回 `uid = 0` 且昵称被打码（`赛***`）。
	 * 带上后弹幕服务器会还原真实昵称。
	 *
	 * ⚠️ 这是凭据，等效于账号登录态，**绝不要提交进仓库**。
	 * 生产建议用 `BILI_COOKIE_FILE` 指向一个不进版本库的文件。
	 */
	biliCookie: string;
}

const DEFAULTS: Config = {
	port: 8080,
	host: '0.0.0.0',
	room: '90932',
	mock: false,
	hud: false,
	videoHole: true,
	labels: true,
	guides: false,
	dataDir: './data',
	idleMs: 60_000,
	echoCount: 10,
	logLevel: 'info',
	biliCookie: ''
};

/** config.json 的字段形状（宽松，全部可选） */
type FileConfig = Partial<Record<keyof Config, unknown>>;

function readConfigFile(path: string): FileConfig {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
	} catch {
		// 没有配置文件就用默认值；解析失败属于人为错误，需要显式提示
		try {
			readFileSync(path);
			console.warn(`[config] ${path} 存在但不是合法 JSON，已忽略`);
		} catch {
			/* 文件不存在，正常 */
		}
		return {};
	}
}

function num(v: unknown, fallback: number): number {
	if (v == null || v === '') return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string): string {
	if (v == null) return fallback;
	const s = String(v).trim();
	return s === '' ? fallback : s;
}

/** 环境变量优先的真值解析：1/true/on/yes 为真 */
function bool(v: unknown, fallback: boolean): boolean {
	if (v == null || v === '') return fallback;
	if (typeof v === 'boolean') return v;
	const s = String(v).trim().toLowerCase();
	if (['1', 'true', 'on', 'yes'].includes(s)) return true;
	if (['0', 'false', 'off', 'no'].includes(s)) return false;
	return fallback;
}

let cached: Config | null = null;

/** 加载配置（结果缓存，进程生命周期内只读一次） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	if (cached) return cached;

	const file = readConfigFile(resolve(env.CONFIG_PATH ?? 'config.json'));

	cached = {
		port: num(env.PORT ?? file.port, DEFAULTS.port),
		host: str(env.HOST ?? file.host, DEFAULTS.host),
		room: str(env.ROOM_ID ?? file.room, DEFAULTS.room),
		mock: bool(env.MOCK ?? file.mock, DEFAULTS.mock),
		hud: bool(env.HUD ?? file.hud, DEFAULTS.hud),
		videoHole: bool(env.VIDEO_HOLE ?? file.videoHole, DEFAULTS.videoHole),
		labels: bool(env.LABELS ?? file.labels, DEFAULTS.labels),
		guides: bool(env.GUIDES ?? file.guides, DEFAULTS.guides),
		dataDir: str(env.DATA_DIR ?? file.dataDir, DEFAULTS.dataDir),
		idleMs: num(env.IDLE_MS ?? file.idleMs, DEFAULTS.idleMs),
		echoCount: num(env.ECHO_COUNT ?? file.echoCount, DEFAULTS.echoCount),
		logLevel: str(env.LOG_LEVEL ?? file.logLevel, DEFAULTS.logLevel) as Config['logLevel'],
		biliCookie: resolveBiliCookie(env, file)
	};

	return cached;
}

/** 仅测试用：清空缓存 */
export function resetConfigCache(): void {
	cached = null;
}

/** 下发给浏览器的视图默认值（不含服务端私有项） */
export function toViewOptions(c: Config): ViewOptions {
	return {
		labels: c.labels,
		guides: c.guides,
		transparent: false,
		hole: c.videoHole,
		hud: c.hud,
		mock: c.mock,
		room: c.room
	};
}

/**
 * 取登录态 Cookie，优先级：BILI_COOKIE 环境变量 > BILI_COOKIE_FILE 文件 > config.json。
 *
 * 为什么要支持「从文件读」：环境变量会被 `docker inspect`、
 * 进程列表（/proc/<pid>/environ）和日志采集系统看到，而 SESSDATA
 * 一旦泄漏就等于账号被别人登录。文件可以单独 chmod 600 并排除在版本库外。
 *
 * 读取失败不抛错 —— 缺个可选凭据不该让服务起不来，降级为匿名并记一条告警。
 */
function resolveBiliCookie(env: NodeJS.ProcessEnv, file: FileConfig): string {
	const inline = str(env.BILI_COOKIE, '');
	if (inline) return inline;

	const path = str(env.BILI_COOKIE_FILE, '');
	if (path) {
		const abs = resolve(path);

		/*
		 * 注意：容器里 ./secrets 是**只读**挂载，扫码 CLI 必须在宿主机上跑
		 * （见 README「登录态」）。这里只负责读。
		 */
		const raw = readCookieFile(abs);
		if (raw) {
			/* 权限过宽只告警不阻断：可能是有意为之（如共享部署） */
			if (!isRestrictive(abs)) {
				console.warn(
					`[config] ${abs} 的权限过于宽松（同机其他用户可读），` +
						'其中含账号凭据，建议 chmod 600'
				);
			}
			return raw;
		}

		console.warn(`[config] 未能从 ${abs} 读到内容（文件不存在或为空），按匿名连接`);
		return '';
	}

	return str(file.biliCookie, '');
}
