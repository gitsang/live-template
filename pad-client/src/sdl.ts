/**
 * 手柄采集：SDL3 的 GameController 抽象 → PadState。
 *
 * 为什么是 SDL 而不是 `Windows.Gaming.Input`：WGI 要求窗口拥有焦点，而采集端是个常驻后台、
 * 没有窗口的进程 —— 「OBS 不在前台就读不到手柄」正是这条限制造成的。SDL 走 XInput /
 * HIDAPI / RawInput，都不看焦点（实测：headless 进程照样能读到轴值）。
 *
 * 另外显式设置 `SDL_JOYSTICK_WGI=0` 关掉 SDL 自己的 WGI 后端，与 obs-browser PR #471
 * 在 OBS 31.0.2 里做的修复是同一件事：绕开会要求焦点的那条路径。
 *
 * 选 SDL 的 GameController 而不是 Joystick：Joystick 给的是原始按键下标，每只手柄都不同，
 * 页面那边就得为每种设备写映射表；Controller 直接给出 `buttons.a` / `axes.leftTrigger`
 * 这类语义名，Xbox / DualShock / DualSense / Switch Pro 走同一套代码。
 */
import {
	applyDeadzone,
	EMPTY_PAD_STATE,
	quantize,
	type PadButtonName,
	type PadState
} from '../../src/lib/shared/pad.ts';

/**
 * SDL 绑定的类型在这里手写一份最小集合，而不是 import 它自带的 .d.ts。
 * 原生绑定的类型定义会随版本漂移，而这里只是消费几个只读属性 ——
 * 让第三方类型参与编译，等于让一次 `npm update` 就能弄坏采集端的类型检查。
 */
interface SdlDevice {
	readonly id: number;
	readonly name: string;
	readonly type: string | null;
}

interface SdlAxes {
	readonly leftStickX: number;
	readonly leftStickY: number;
	readonly rightStickX: number;
	readonly rightStickY: number;
	readonly leftTrigger: number;
	readonly rightTrigger: number;
}

interface SdlButtons {
	readonly a: boolean;
	readonly b: boolean;
	readonly x: boolean;
	readonly y: boolean;
	readonly back: boolean;
	readonly start: boolean;
	readonly guide: boolean;
	readonly leftStick: boolean;
	readonly rightStick: boolean;
	readonly leftShoulder: boolean;
	readonly rightShoulder: boolean;
	readonly dpadUp: boolean;
	readonly dpadDown: boolean;
	readonly dpadLeft: boolean;
	readonly dpadRight: boolean;
}

interface SdlInstance {
	readonly device: SdlDevice;
	readonly axes: SdlAxes;
	readonly buttons: SdlButtons;
	close(): void;
}

interface SdlModule {
	readonly controller: {
		readonly devices: SdlDevice[];
		openDevice(device: SdlDevice): SdlInstance;
	};
}

/** SDL 语义名 → 页面用的标准名（与 shared/pad.ts 的 STANDARD_BUTTONS 对齐） */
const BUTTON_MAP: ReadonlyArray<[keyof SdlButtons, PadButtonName]> = [
	['a', 'A'],
	['b', 'B'],
	['x', 'X'],
	['y', 'Y'],
	['leftShoulder', 'LB'],
	['rightShoulder', 'RB'],
	['back', 'Back'],
	['start', 'Start'],
	['leftStick', 'LS'],
	['rightStick', 'RS'],
	['dpadUp', 'Up'],
	['dpadDown', 'Down'],
	['dpadLeft', 'Left'],
	['dpadRight', 'Right'],
	['guide', 'Guide']
];

/** 扳机按下判定阈值：SDL 给的扳机是 0–1 连续量，轻微抖动不该点亮按键 */
const TRIGGER_THRESHOLD = 0.02;

/** 重新扫描设备的间隔：插拔检测靠轮询，但不必每帧都枚举 */
const RESCAN_MS = 1000;

function clamp01(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 把一帧 SDL 状态归一化成 PadState（死区/量化与页面侧完全一致） */
export function readState(instance: SdlInstance): PadState {
	const buttons: PadState['buttons'] = {};
	let pressed = false;

	for (const [key, name] of BUTTON_MAP) {
		const on = Boolean(instance.buttons[key]);
		buttons[name] = { pressed: on, value: on ? 1 : 0 };
		if (on) pressed = true;
	}

	/* 扳机是模拟量：既要点亮（pressed），也要有数值给进度条 */
	for (const [key, name] of [
		['leftTrigger', 'LT'],
		['rightTrigger', 'RT']
	] as const) {
		const value = quantize(clamp01(instance.axes[key]));
		const on = value > TRIGGER_THRESHOLD;
		buttons[name] = { pressed: on, value };
		if (on) pressed = true;
	}

	const axes: PadState['axes'] = [
		quantize(applyDeadzone(instance.axes.leftStickX)),
		quantize(applyDeadzone(instance.axes.leftStickY)),
		quantize(applyDeadzone(instance.axes.rightStickX)),
		quantize(applyDeadzone(instance.axes.rightStickY))
	];
	if (axes.some((a) => a !== 0)) pressed = true;

	return {
		connected: true,
		id: instance.device.name.slice(0, 64),
		/* SDL 的 Controller 抽象本身就是标准布局 */
		mapping: 'standard',
		buttons,
		axes,
		pressed
	};
}

export interface SdlPadOptions {
	/** 用第几个设备（0 起）。默认 0；多手柄时靠它区分 */
	index?: number;
	/** 设备插拔等事件的日志出口 */
	log: (msg: string) => void;
}

/**
 * 手柄设备管理器：负责「打开 / 掉线重开」，每次 poll() 返回最新一帧。
 *
 * 不做事件驱动的按键流，只做 60Hz 采样：页面那边是按帧渲染的，采样比事件更简单，
 * 也天然把「一帧内多次变化」压成一次上报。
 */
export class SdlPad {
	readonly #index: number;
	readonly #log: (msg: string) => void;
	#sdl: SdlModule | null = null;
	#instance: SdlInstance | null = null;
	#deviceId: number | null = null;
	#lastScan = 0;

	constructor(options: SdlPadOptions) {
		this.#index = options.index ?? 0;
		this.#log = options.log;
	}

	async init(): Promise<void> {
		/*
		 * 必须在加载原生库**之前**设置：SDL 在初始化 joystick 子系统时读这个 hint。
		 * 已经在环境里显式设过就不覆盖（留一个自己排查的余地）。
		 */
		if (process.env.SDL_JOYSTICK_WGI === undefined) process.env.SDL_JOYSTICK_WGI = '0';

		const mod = (await import('@kmamal/sdl')) as unknown as { default: SdlModule };
		this.#sdl = mod.default;
		this.#log(`SDL 已就绪，检测到 ${this.devices().length} 个手柄设备`);
	}

	/** 当前可见的控制器设备 */
	devices(): SdlDevice[] {
		return this.#sdl?.controller.devices ?? [];
	}

	get deviceName(): string {
		return this.#instance?.device.name ?? '';
	}

	/** 采样一帧；没有手柄时返回未连接状态 */
	poll(): PadState {
		this.#ensure();
		return this.#instance ? readState(this.#instance) : EMPTY_PAD_STATE;
	}

	close(): void {
		this.#closeInstance();
	}

	#ensure(): void {
		const sdl = this.#sdl;
		if (!sdl) return;

		const list = sdl.controller.devices;

		/* 已打开的实例：确认设备还在，不在就是拔了 */
		if (this.#instance) {
			if (this.#deviceId !== null && list.some((d) => d.id === this.#deviceId)) return;
			this.#closeInstance();
			this.#log('手柄已断开');
		}

		const now = Date.now();
		if (now - this.#lastScan < RESCAN_MS) return;
		this.#lastScan = now;

		const device = list[this.#index] ?? list[0];
		if (!device) return;

		try {
			this.#instance = sdl.controller.openDevice(device);
			this.#deviceId = device.id;
			this.#log(`已打开手柄：${device.name}（${device.type ?? '未知型号'}）`);
		} catch (err) {
			/* 驱动没装好 / 设备正被独占：不致命，下一轮再试 */
			this.#log(`打开手柄失败：${(err as Error).message}`);
		}
	}

	#closeInstance(): void {
		try {
			this.#instance?.close();
		} catch {
			/* 已经没了就算了 */
		}
		this.#instance = null;
		this.#deviceId = null;
	}
}
