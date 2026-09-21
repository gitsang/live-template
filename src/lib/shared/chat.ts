/**
 * 聊天框的共享常量与状态映射。
 * 放在这里而不是组件里，是因为容量与状态文案既被 UI 使用，
 * 也被 feed（数据源）用于裁剪数组，两边必须一致。
 */
import type { RoomState } from './types';

/**
 * 聊天框可见行数（由 geometry 的 474×630 与 16px/1.6 行高推得）。
 * 见 docs/design.md §6.3。
 */
export const VISIBLE_ROWS = 23;

/**
 * DOM 中最多保留的弹幕条数。
 *
 * 取「可见行数的若干倍」而不是固定大数：既要能回溯一点历史，
 * 又要避免 OBS 长时间运行导致 DOM 无限增长。
 */
export const MAX_CHAT_ITEMS = 300;

/** 状态 → 中文文案 */
export const STATE_TEXT: Record<RoomState, string> = {
	idle: '未连接',
	connecting: '连接中',
	connected: '已连接',
	reconnecting: '重连中',
	error: '异常'
};
