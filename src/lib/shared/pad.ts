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

/** 判断两份状态是否等价（用于跳过无变化的帧） */
export function sameState(a: PadState, b: PadState): boolean {
	if (a.connected !== b.connected || a.pressed !== b.pressed) return false;
	for (let i = 0; i < 4; i++) {
		if (a.axes[i] !== b.axes[i]) return false;
	}
	for (const name of STANDARD_BUTTONS) {
		const x = a.buttons[name];
		const y = b.buttons[name];
		if (!x || !y) return false;
		if (x.pressed !== y.pressed || x.value !== y.value) return false;
	}
	return true;
}

/** 量化到 1/255 步进，避免浮点抖动导致每帧都被判定为「变化」 */
export function quantize(v: number): number {
	return Math.round(v * 255) / 255;
}

/* ============================ 远程上报（采集端 → 服务端 → 页面） ============================ */

/**
 * 判定「采集端已失联」的静默窗口。
 *
 * 采集端每 16ms 采一次、每秒至少发一包心跳，因此 2s 足够区分「手柄真没连」与
 * 「机器卡了一下」。服务端的看门狗与页面的回落逻辑共用同一个值 —— 两边不一致会
 * 出现「服务端已判死、页面还在用旧帧」的错位。
 */
export const PAD_STALE_MS = 2000;

/** 采集端采样周期（60Hz，与页面 rAF 一致；再快也只是白烧 CPU） */
export const PAD_SAMPLE_MS = 16;

/** slot 名（玩家位）。显式绑定，不依赖设备枚举顺序 —— 蓝牙/XInput 混用时顺序会变。 */
export const PAD_SLOT_PATTERN = /^[a-z0-9_-]{1,16}$/i;

/** 单包上限：满量程按键表约 1KB，8KB 留足余量又拦得住垃圾包 */
export const PAD_MAX_PAYLOAD = 8 * 1024;

/** 采集端上行速率上限（包/秒）。60Hz 上报 + 心跳远低于此，超出的直接丢。 */
export const PAD_MAX_RATE = 240;

function clamp(v: number, lo: number, hi: number): number {
	if (!Number.isFinite(v)) return 0;
	return v < lo ? lo : v > hi ? hi : v;
}

function num(v: unknown, fallback = 0): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 把来路不明的 JSON 洗成合法的 PadState。
 *
 * `/ws/pad` 的上行是**外部进程**喂进来的数据，不能假设形状正确：非数组、超长字符串、
 * 上亿的按键表都会直接打进页面渲染，一条野包就能让 OBS 源花屏或卡死。
 * 因此按键名只认 STANDARD_BUTTONS、数值一律 clamp、字符串一律截断，形状不对直接返回 null。
 *
 * 输出总是填满全部标准按键（缺省 0），与 `snapshot()` 的形状保持一致 ——
 * `sameState()` 依赖两边键集合相同，否则每帧都会被判成「有变化」。
 */
export function sanitizePadState(raw: unknown): PadState | null {
	if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const src = raw as Record<string, unknown>;

	const rawButtons =
		src.buttons != null && typeof src.buttons === 'object' && !Array.isArray(src.buttons)
			? (src.buttons as Record<string, unknown>)
			: {};

	const buttons: PadState['buttons'] = {};
	let pressed = false;
	for (const name of STANDARD_BUTTONS) {
		const item = rawButtons[name];
		const obj = item != null && typeof item === 'object' ? (item as Record<string, unknown>) : {};
		const value = quantize(clamp(num(obj.value), 0, 1));
		const on = obj.pressed === true || value > 0;
		buttons[name] = { pressed: on, value };
		if (on) pressed = true;
	}

	const rawAxes = Array.isArray(src.axes) ? src.axes : [];
	const axes: PadState['axes'] = [
		quantize(clamp(num(rawAxes[AXES.LX]), -1, 1)),
		quantize(clamp(num(rawAxes[AXES.LY]), -1, 1)),
		quantize(clamp(num(rawAxes[AXES.RX]), -1, 1)),
		quantize(clamp(num(rawAxes[AXES.RY]), -1, 1))
	];
	if (axes.some((a) => a !== 0)) pressed = true;

	return {
		connected: src.connected === true,
		id: typeof src.id === 'string' ? src.id.slice(0, 64) : '',
		mapping: src.mapping === 'standard' ? 'standard' : '',
		buttons,
		axes,
		pressed
	};
}
