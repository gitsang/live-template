/**
 * 弹幕服务端的独立打包入口。
 *
 * 为什么需要它：SvelteKit 只把被路由引用的服务端代码编进 build/handler.js，
 * 而 RoomHub / WebSocket 服务需要在 server.mjs 里访问 http.Server，
 * 所以单独用一份 Vite lib 构建把它打成 build/danmaku/entry.js。
 */
import { resolve } from 'node:path';

export { RoomHub } from './hub';
export { attachDanmakuWs, DanmakuWsServer } from './ws-server';
export { loadConfig, toViewOptions } from './config';
export { setLogLevel } from './logger';
export { localDateKey } from './store';

/** 项目根目录，供 server.mjs 解析 dataDir 等相对路径 */
export const projectRoot = resolve(process.cwd());
