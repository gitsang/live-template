/**
 * 手柄状态模型（前后端无关，纯客户端）。
 */

/** 归一化后的按键名（按 Gamepad API standard mapping 的索引映射） */
export type PadButtonName =
	| 'A'
	| 'B'
	| 'X'
	| 'Y'
	| 'LB'
	| 'RB'
	| 'LT'
	| 'RT'
	| 'Back'
	| 'Start'
	| 'LS'
	| 'RS'
	| 'Up'
	| 'Down'
	| 'Left'
	| 'Right'
	| 'Guide';

/** standard mapping 的索引 → 名称。非 standard 的手柄按同样索引尽力渲染。 */
export const STANDARD_BUTTONS: readonly PadButtonName[] = [
	'A',
	'B',
	'X',
	'Y',
	'LB',
	'RB',
	'LT',
	'RT',
	'Back',
	'Start',
	'LS',
	'RS',
	'Up',
	'Down',
	'Left',
	'Right',
	'Guide'
];

/** 摇杆轴索引：左摇杆 x/y、右摇杆 x/y */
export const AXES = { LX: 0, LY: 1, RX: 2, RY: 3 } as const;

/** 摇杆死区：低于此幅度视为未推动，避免漂移误报 */
export const DEADZONE = 0.08;

/*
 * 摇杆可视几何（与 theme.css 的 .pad-stick 一致）。
 * 圆点行程必须按像素算（摇杆半径 − 边框 − 圆点半径）：改用 translate(100%) 时百分比
 * 基于圆点自身尺寸（24px）而非摇杆，行程会明显偏小（实测只有 12px，跑不满摇杆）。
 */
export const STICK_SIZE = 78;
export const STICK_BORDER = 2;
export const STICK_DOT_SIZE = 24;

/** 摇杆圆点从中心出发的最大偏移（像素） */
export const STICK_MAX_TRAVEL = STICK_SIZE / 2 - STICK_BORDER - STICK_DOT_SIZE / 2;

/** 把归一化的摇杆轴值换算成圆点的 CSS transform */
export function stickTransform(x: number, y: number): string {
	const dx = (x * STICK_MAX_TRAVEL).toFixed(2);
	const dy = (y * STICK_MAX_TRAVEL).toFixed(2);
	return `translate(${dx}px, ${dy}px)`;
}

export interface PadButtonState {
	pressed: boolean;
	/** 模拟量 0–1（按键为 0/1，扳机为真实模拟值） */
	value: number;
}

export interface PadState {
	/** 是否检测到手柄 */
	connected: boolean;
	/** 设备名，调试页展示 */
	id: string;
	/** 'standard' 或 '' */
	mapping: string;
	/** 按键名 → 状态（未按下的键也会出现，值 0） */
	buttons: Record<string, PadButtonState>;
	/** [LX, LY, RX, RY]，已应用死区 */
	axes: [number, number, number, number];
	/** 是否有任意按键按下或摇杆推动 —— 用于「无输入则半透明」 */
	pressed: boolean;
}

export const EMPTY_PAD_STATE: PadState = {
	connected: false,
	id: '',
	mapping: '',
	buttons: {},
	axes: [0, 0, 0, 0],
	pressed: false
};

/** 应用死区：小于阈值归零，其余按比例放大，保证从阈值处平滑起步 */
export function applyDeadzone(v: number, dz = DEADZONE): number {
	if (Math.abs(v) < dz) return 0;
	const sign = v < 0 ? -1 : 1;
	return sign * ((Math.abs(v) - dz) / (1 - dz));
}

/** 量化到 1/255 步进，避免浮点抖动导致每帧都被判定为「变化」 */
export function quantize(v: number): number {
	return Math.round(v * 255) / 255;
}
