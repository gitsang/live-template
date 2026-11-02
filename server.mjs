/**
 * 生产入口：adapter-node handler 处理 HTTP，在同一个 http.Server 上挂载 /ws，
 * 退出时落盘并关闭连接。
 */
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import {
	PadHub,
	RoomHub,
	attachDanmakuWs,
	attachPadWs,
	loadConfig,
	registerHub,
	registerPadHub,
	setLogLevel
} from './build/danmaku/entry.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const hub = new RoomHub({
	dataDir: config.dataDir,
	idleMs: config.idleMs,
	echoCount: config.echoCount,
	mock: config.mock,
	loginCookie: config.biliCookie
});

/* 让 /api/health 能访问到同一个 hub 实例 */
registerHub(hub);

/* 手柄中枢：与房间无关，故独立于 RoomHub */
const padHub = new PadHub();
registerPadHub(padHub);

const server = createServer(handler);
attachDanmakuWs(server, { hub, defaultRoom: config.room });
attachPadWs(server, { padHub, token: config.padToken });

server.listen(config.port, config.host, () => {
	const mode = config.mock ? 'MOCK' : 'LIVE';
	console.log(`[live-template] http://${config.host}:${config.port}`);
	console.log(`[live-template] 房间=${config.room} 模式=${mode} 数据目录=${config.dataDir}`);
	/*
	 * 只说明「有没有配登录态」，绝不打印 Cookie 本身。这里不能断言「已登录」——
	 * 此刻还没校验，凭据无效时会降级为匿名，真实结果由首次连接的 nav 校验决定。
	 */
	console.log(
		`[live-template] 身份=${config.biliCookie ? '已配置登录态（连接时校验）' : '匿名（部分昵称会被打码）'}`
	);
	/*
	 * 把口令打印在启动日志里（仅此处一次）：口令要人工从终端抄进网页，而日志是运维
	 * 看得到的地方。因此**不要**把它写进任何会被采集/上报的日志级别。
	 */
	if (config.loginToken) {
		console.log(`[live-template] 管理页已开启: /admin （访问口令: ${config.loginToken}）`);
	} else {
		console.log('[live-template] 管理页未开启（设置 LOGIN_TOKEN 可启用）；可用 npm run login 在终端扫码');
	}
	if (config.padToken) {
		console.log('[live-template] 手柄上报已开启: /ws/pad（采集端需带同一 PAD_TOKEN）');
	} else {
		console.log('[live-template] 手柄上报未开启（设置 PAD_TOKEN 可启用采集端上报）');
	}
	console.log('[live-template] OBS 浏览器源: /?hole=1  (1920x1080)');
});

/* 优雅退出：落盘 + 关闭 WS */
let shuttingDown = false;
async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\n[live-template] 收到 ${signal}，正在退出…`);
	server.close();
	padHub.close();
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
