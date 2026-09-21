/**
 * 生产入口。
 *
 * 1. 用 SvelteKit 的 adapter-node handler 处理 HTTP
 * 2. 在同一个 http.Server 上挂载 /ws（弹幕推送）
 * 3. 优雅退出时落盘并关闭连接
 */
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { RoomHub, attachDanmakuWs, loadConfig, setLogLevel } from './build/danmaku/entry.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const hub = new RoomHub({
	dataDir: config.dataDir,
	idleMs: config.idleMs,
	echoCount: config.echoCount,
	mock: config.mock
});

const server = createServer(handler);
attachDanmakuWs(server, { hub, defaultRoom: config.room });

server.listen(config.port, config.host, () => {
	const mode = config.mock ? 'MOCK' : 'LIVE';
	console.log(`[live-template] http://${config.host}:${config.port}`);
	console.log(`[live-template] 房间=${config.room} 模式=${mode} 数据目录=${config.dataDir}`);
	console.log('[live-template] OBS 浏览器源: /?hole=1  (1920x1080)');
});

/* 优雅退出：落盘 + 关闭 WS */
let shuttingDown = false;
async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\n[live-template] 收到 ${signal}，正在退出…`);
	server.close();
	try {
		await hub.closeAll();
	} catch (err) {
		console.error('[live-template] 清理失败:', err);
	}
	process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => void shutdown(signal));
}
