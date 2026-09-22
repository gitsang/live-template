/**
 * 运行时注册表：让 SvelteKit 路由能访问到 server.mjs 创建的 RoomHub。
 *
 * 用 globalThis 而非模块级变量：生产环境下 build/handler.js 与
 * build/danmaku/entry.js 是两次独立打包，各有自己的模块实例，模块级单例互不可见；
 * 两者在同一 Node 进程里，挂 globalThis 是唯一可靠的桥接方式。
 */

const HUB_KEY = Symbol.for('live-template.hub');
const START_KEY = Symbol.for('live-template.startTime');

type GlobalWithRegistry = typeof globalThis & {
	[HUB_KEY]?: unknown;
	[START_KEY]?: number;
};

const g = globalThis as GlobalWithRegistry;

/** 入口注册 hub */
export function registerHub(instance: unknown): void {
	g[HUB_KEY] = instance;
	if (g[START_KEY] === undefined) g[START_KEY] = Date.now();
}

/** 取得的 hub（类型由调用方断言；未注册时为 undefined） */
export function getHub<T>(): T | undefined {
	return g[HUB_KEY] as T | undefined;
}

/** 进程启动时刻 */
export function getStartTime(): number {
	return g[START_KEY] ?? Date.now();
}
