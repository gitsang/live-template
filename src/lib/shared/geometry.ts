/**
 * 版面几何 —— 唯一事实来源。
 *
 * 全部数值来自 statics/basic-framework.html 的 :root 变量与 flex 推导结果。
 * theme.css 里的同名变量只是同值的静态镜像（保证无 JS 时也能正确渲染），
 * 运行时会由 Scene.svelte / BoxFrame.svelte 用这里的值以内联变量覆盖。
 *
 * 画布坐标系 = 1080p 下的真实像素，OBS 中即 1:1，可直接用于对齐采集源。
 */

export const CANVAS = { w: 1920, h: 1080 } as const;

/** 基础变量（改动这里即可整体换版面，视频框会自动重算 16:9） */
export const BASE = {
	/** 画布宽 */
	w: CANVAS.w,
	/** 画布高 */
	h: CANVAS.h,
	/** 画布内边距 */
	pad: 28,
	/** 框体间距 */
	gap: 18,
	/** 右栏宽度 */
	right: 480,
	/** 手柄操作框高度（面板外高） */
	padH: 340,
	/** 标题栏高度 */
	hd: 30,
	/** 边框宽度（像素块） */
	bw: 3
} as const;

/** 面板内容区（纯黑/透明预留区）的尺寸与位置 */
export interface Box {
	/** 内容区左上角 x（画布坐标） */
	x: number;
	/** 内容区左上角 y（画布坐标） */
	y: number;
	w: number;
	h: number;
}

/** 面板外框高度（内容区 + 标题栏 + 上下边框） */
const outerH = (bodyH: number) => bodyH + BASE.hd + BASE.bw * 2;

/** 左栏宽度 = 场景宽 - 间距 - 右栏宽 */
export const LEFT_W = BASE.w - BASE.pad * 2 - BASE.gap - BASE.right;

/** 左栏内容区宽度（= 视频框预留区宽度） */
export const LEFT_BODY_W = LEFT_W - BASE.bw * 2;

/** 视频预留区严格 16:9：由左栏可用宽度反推 */
export const VIDEO_BODY_W = LEFT_BODY_W;
export const VIDEO_BODY_H = (LEFT_BODY_W * 9) / 16;

/** 视频面板外高，公告框吃掉左栏剩余空间 */
const VIDEO_OUTER_H = outerH(VIDEO_BODY_H);
const NOTICE_OUTER_H = BASE.h - BASE.pad * 2 - BASE.gap - VIDEO_OUTER_H;

/** 右栏内容区宽度 */
export const RIGHT_BODY_W = BASE.right - BASE.bw * 2;

/** 聊天面板吃掉右栏剩余空间（除手柄框外） */
const CHAT_OUTER_H = BASE.h - BASE.pad * 2 - BASE.gap - BASE.padH;
const PAD_OUTER_H = BASE.padH;

/** 各内容区在画布中的精确位置 —— 用于对齐显示器采集、坐标参考 */
export const BOXES = {
	video: {
		x: BASE.pad + BASE.bw,
		y: BASE.pad + BASE.bw + BASE.hd,
		w: VIDEO_BODY_W,
		h: VIDEO_BODY_H
	},
	notice: {
		x: BASE.pad + BASE.bw,
		y: BASE.pad + VIDEO_OUTER_H + BASE.gap + BASE.bw + BASE.hd,
		w: VIDEO_BODY_W,
		h: NOTICE_OUTER_H - BASE.hd - BASE.bw * 2
	},
	chat: {
		x: BASE.pad + LEFT_W + BASE.gap + BASE.bw,
		y: BASE.pad + BASE.bw + BASE.hd,
		w: RIGHT_BODY_W,
		h: CHAT_OUTER_H - BASE.hd - BASE.bw * 2
	},
	pad: {
		x: BASE.pad + LEFT_W + BASE.gap + BASE.bw,
		y: BASE.pad + CHAT_OUTER_H + BASE.gap + BASE.bw + BASE.hd,
		w: RIGHT_BODY_W,
		h: PAD_OUTER_H - BASE.hd - BASE.bw * 2
	}
} as const satisfies Record<string, Box>;

export type BoxName = keyof typeof BOXES;

/**
 * 各面板的**外框**矩形（含边框与标题栏）。
 *
 * 这是 OBS 里该填的数值：`/only/<box>` 页渲染的是完整面板，
 * 所以浏览器源的宽高与位置应照这里填，叠在整页画布上才能像素级对齐。
 */
export const PANELS = {
	video: {
		x: BOXES.video.x - BASE.bw,
		y: BOXES.video.y - BASE.bw - BASE.hd,
		w: BOXES.video.w + BASE.bw * 2,
		h: VIDEO_OUTER_H
	},
	notice: {
		x: BOXES.notice.x - BASE.bw,
		y: BOXES.notice.y - BASE.bw - BASE.hd,
		w: BOXES.notice.w + BASE.bw * 2,
		h: NOTICE_OUTER_H
	},
	chat: {
		x: BOXES.chat.x - BASE.bw,
		y: BOXES.chat.y - BASE.bw - BASE.hd,
		w: BOXES.chat.w + BASE.bw * 2,
		h: CHAT_OUTER_H
	},
	pad: {
		x: BOXES.pad.x - BASE.bw,
		y: BOXES.pad.y - BASE.bw - BASE.hd,
		w: BOXES.pad.w + BASE.bw * 2,
		h: PAD_OUTER_H
	}
} as const satisfies Record<string, Box>;

/** `OBS 源 WxH @ x,y` 文本，写入标题栏便于抄写 */
export function panelSpec(name: BoxName): string {
	const p = PANELS[name];
	return `${p.w}×${p.h} @ ${p.x},${p.y}`;
}


/** 每个面板的外高，供 flex 布局使用 */
export const OUTER_H = {
	video: VIDEO_OUTER_H,
	notice: NOTICE_OUTER_H,
	chat: CHAT_OUTER_H,
	pad: PAD_OUTER_H
} as const;

/** 渲染成内联 CSS 自定义属性，供 theme.css 使用 */
export function baseVars(): string {
	return [
		`--w:${BASE.w}`,
		`--h:${BASE.h}`,
		`--pad:${BASE.pad}`,
		`--gap:${BASE.gap}`,
		`--right:${BASE.right}`,
		`--pad-h:${BASE.padH}`,
		`--hd:${BASE.hd}`,
		`--bw:${BASE.bw}`
	].join(';');
}

