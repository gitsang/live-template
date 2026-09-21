/**
 * Vite dev 插件：把 /ws 挂到 dev server 上。
 *
 * 生产环境由 server.mjs 挂载（见 src/lib/server/ws-server.ts）；
 * dev 环境没有 http.Server 的直接控制权，只能通过 configureServer 拿到底层
 * server 实例，因此这里复用同一套 DanmakuWsServer。
 *
 * 注意：应用代码必须用 server.ssrLoadModule 动态加载。
 * vite.config.ts 在 Vite 的模块图之外被加载，那里解析不了 `$lib` 别名，
 * 顶层 import 应用模块会直接报 ERR_MODULE_NOT_FOUND。
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { Server } from 'node:http';

export function danmakuDevPlugin(): Plugin {
	return {
		name: 'live-template:danmaku-ws',
		apply: 'serve',

		async configureServer(server: ViteDevServer) {
			const httpServer = server.httpServer as Server | null;
			if (!httpServer) {
				server.config.logger.warn('[live-template] 拿不到 http server，/ws 未挂载');
				return;
			}

			/* 通过 SSR 模块图加载，$lib 别名可用 */
			const { loadConfig } = await server.ssrLoadModule('/src/lib/server/config.ts');
			const { setLogLevel } = await server.ssrLoadModule('/src/lib/server/logger.ts');
			const { RoomHub } = await server.ssrLoadModule('/src/lib/server/hub.ts');
			const { attachDanmakuWs } = await server.ssrLoadModule('/src/lib/server/ws-server.ts');
			/* 直接用与 registry.ts 相同的 Symbol.for 键写入 globalThis，
			   避免 ssrLoadModule 产生模块副本导致路由读到不同的实例 */
			const HUB_KEY = Symbol.for('live-template.hub');
			const START_KEY = Symbol.for('live-template.startTime');

			const config = loadConfig();
			setLogLevel(config.logLevel);

			const hub = new RoomHub({
				dataDir: config.dataDir,
				idleMs: config.idleMs,
				echoCount: config.echoCount,
				mock: config.mock,
				loginCookie: config.biliCookie
			});

			(globalThis as Record<symbol, unknown>)[HUB_KEY] = hub;
			(globalThis as Record<symbol, unknown>)[START_KEY] ??= Date.now();

			const wsServer = attachDanmakuWs(httpServer, { hub, defaultRoom: config.room });

			server.config.logger.info(
				`[live-template] 弹幕 WS 已挂载 /ws（房间=${config.room}${config.mock ? ' MOCK' : ''}）`
			);

			/* dev server 关闭时清理，避免进程挂住 */
			httpServer.once('close', () => {
				void wsServer.close();
				void hub.closeAll();
			});
		}
	};
}
