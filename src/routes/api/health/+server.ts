/**
 * 健康检查 /api/health：房间会话、连接状态与运行时长，用于排查「弹幕没上来」。
 * hub 通过 globalThis 注册表取得（见 registry.ts），故 server.mjs 创建的实例在这里也可见。
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadConfig, toViewOptions } from '$lib/server/config';
import { getHub, getPadHub, getStartTime } from '$lib/server/registry';

interface HubLike {
	snapshot(): unknown[];
}

interface PadHubLike {
	snapshot(): Array<{ slot: string; connected: boolean; id: string; at: number; seq: number }>;
}

export const GET: RequestHandler = () => {
	const config = loadConfig();
	const hub = getHub<HubLike>();
	const padHub = getPadHub<PadHubLike>();
	const now = Date.now();

	return json({
		ok: true,
		uptimeMs: now - getStartTime(),
		config: {
			room: config.room,
			mock: config.mock,
			dataDir: config.dataDir,
			idleMs: config.idleMs,
			echoCount: config.echoCount
		},
		view: toViewOptions(config),
		rooms: hub ? hub.snapshot() : [],
		/* hub 不可见时明确说明，避免误读成「没有房间」 */
		hubAvailable: hub !== undefined,
		/* 手柄：谁在线、最后一帧是多久以前 —— 排查「手柄框不动」的第一步看这里 */
		pads: padHub ? padHub.snapshot() : [],
		padAvailable: padHub !== undefined,
		/* OBS 对齐用的精确尺寸 */
		geo: {
			video: '1360x765',
			notice: '1360x169',
			chat: '474x630',
			pad: '474x304'
		}
	});
};
