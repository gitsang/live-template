/**
 * 链路自检 /api/self-test
 *
 * 往指定房间的事件总线注入几条假弹幕，用来确认「WS → 渲染」这一段是通的：
 * 打开页面后访问这个地址，聊天框应立即出现这几条。
 *
 * 注入的事件也会正常落盘（与真实弹幕同一条路径），因此同时验证了 Store。
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { getHub } from '$lib/server/registry';

interface SessionLike {
	bus: { publish(event: unknown): unknown };
}

interface HubLike {
	snapshot(): Array<{ room: string }>;
	/** 直接取已存在的会话；不存在则不创建，避免自检意外连上 B 站 */
	peek?(room: string): SessionLike | undefined;
}

export const GET: RequestHandler = ({ url }) => {
	const config = loadConfig();
	const hub = getHub<HubLike>();

	if (!hub) {
		throw error(503, '事件总线不可用（hub 未注册）');
	}

	const room = url.searchParams.get('room')?.trim() || config.room;
	const session = hub.peek?.(room);

	if (!session) {
		throw error(404, `房间 ${room} 当前没有活跃会话。先打开一次页面让它建立连接。`);
	}

	const now = Date.now();
	const samples = [
		{ t: 'danmaku', ts: now, uid: 1, u: '自检机器人', m: '显示链路测试 ①', color: 0xffffff, lv: 60, guard: 0, medal: null, vip: false, admin: false },
		{ t: 'danmaku', ts: now + 1, uid: 1, u: '自检机器人', m: '能看到这两条 → 显示正常；看不到就是渲染或中继的问题', color: 0xffffff, lv: 60, guard: 0, medal: null, vip: false, admin: false },
		{ t: 'danmaku', ts: now + 2, uid: 1, u: '自检机器人', m: '这是一条特别特别长的自检弹幕，用来顺便确认超长文本会换行而不是撑破聊天框布局', color: 0xffffff, lv: 60, guard: 0, medal: null, vip: false, admin: false }
	];

	for (const sample of samples) session.bus.publish(sample);

	return json({ ok: true, room, injected: samples.length, hint: '看 OBS 预览里的聊天框' });
};
