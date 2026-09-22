/**
 * 手柄 mock：无手柄的开发环境也能验证手柄框渲染。按固定脚本循环播放假输入，
 * 走与真实手柄完全相同的 PadState 通道，因此组件代码零分支。
 */
import {
	AXES,
	EMPTY_PAD_STATE,
	STANDARD_BUTTONS,
	quantize,
	type PadState
} from '$lib/shared/pad';
import type { PadListener, PadReader } from './gamepad';

interface Step {
	/** 持续毫秒 */
ms: number;
	/** 按下的键 */
	down?: string[];
	/** 扳机模拟量 */
	triggers?: { LT?: number; RT?: number };
	/** 摇杆 [LX, LY, RX, RY]，-1 → 1 */
	axes?: [number, number, number, number];
	/** 中键 */
	label?: string;
}

/** 一段覆盖所有可视化元素的演示序列 */
const SCRIPT: Step[] = [
	{ ms: 700, label: '待机' },
	{ ms: 420, down: ['A'] },
	{ ms: 420, down: ['B'] },
	{ ms: 420, down: ['X'] },
	{ ms: 420, down: ['Y'] },
	{ ms: 520, down: ['A', 'B'] },
	{ ms: 480, down: ['LB'] },
	{ ms: 480, down: ['RB'] },
	{ ms: 900, triggers: { LT: 1 } },
	{ ms: 900, triggers: { RT: 1 } },
	{ ms: 700, triggers: { LT: 0.45, RT: 0.8 } },
	{ ms: 380, down: ['Up'] },
	{ ms: 380, down: ['Right'] },
	{ ms: 380, down: ['Down'] },
	{ ms: 380, down: ['Left'] },
	{ ms: 900, axes: [0.85, -0.7, 0, 0] },
	{ ms: 900, axes: [0, 0, -0.8, 0.75] },
	{ ms: 700, axes: [0.5, 0.5, -0.5, -0.5], down: ['LS'] },
	{ ms: 600, down: ['LS', 'RS'] },
	{ ms: 500, down: ['Start'] },
	{ ms: 500, down: ['Back'] },
	{ ms: 500, down: ['Guide'] },
	{ ms: 600, down: ['A'], axes: [0.3, -0.2, -0.3, 0.2], triggers: { LT: 0.6, RT: 0.35 } }
];

const TOTAL = SCRIPT.reduce((s, x) => s + x.ms, 0);

/** 由脚本时间点构造完整 PadState */
function stateAt(t: number): PadState {
	let acc = 0;
	let step: Step = SCRIPT[SCRIPT.length - 1];
	for (const s of SCRIPT) {
		if (t < acc + s.ms) {
			step = s;
			break;
		}
		acc += s.ms;
	}

	const down = new Set(step.down ?? []);
	const lt = step.triggers?.LT ?? 0;
	const rt = step.triggers?.RT ?? 0;
	const axes = step.axes ?? [0, 0, 0, 0];

	const buttons: PadState['buttons'] = {};
	let pressed = false;
	for (const name of STANDARD_BUTTONS) {
		let value = 0;
		if (name === 'LT') value = lt;
		else if (name === 'RT') value = rt;
		else value = down.has(name) ? 1 : 0;

		const isPressed = value > 0;
		buttons[name] = { pressed: isPressed, value: quantize(value) };
		if (isPressed) pressed = true;
	}

	const quantizedAxes = axes.map(quantize) as [number, number, number, number];
	if (quantizedAxes.some((a) => a !== 0)) pressed = true;

	return {
		connected: true,
		id: 'MOCK Gamepad (scripted)',
		mapping: 'standard',
		buttons,
		axes: quantizedAxes,
		pressed
	};
}

/** 假手柄读取器 */
export class PadMockReader implements PadReader {
	start(onChange: PadListener): () => void {
		const t0 = performance.now();
		let raf = 0;
		let last: PadState = EMPTY_PAD_STATE;

		const tick = (): void => {
			const t = (performance.now() - t0) % TOTAL;
			const next = stateAt(t);
			/* 脚本按帧变化，直接比较轴值即可，JSON 比较足够廉价 */
			if (JSON.stringify(next) !== JSON.stringify(last)) {
				last = next;
				onChange(next);
			}
			raf = requestAnimationFrame(tick);
		};

		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}
}

/** 调试用：当前脚本长度 */
export const MOCK_TOTAL_MS = TOTAL;

/* AXES 在脚本里通过位置隐式使用，显式引用避免未使用告警 */
void AXES;
