/**
 * Gamepad 读取器（见 docs/design.md §2.4）。
 *
 * Chromium 只会在收到一次按键后才把设备暴露给 navigator.getGamepads()，
 * 因此无条件持续轮询，不依赖 gamepadconnected 事件。无手柄时也要回调一次未连接状态，
 * 让 UI 显示唤醒提示；只在状态真正变化时回调，避免每帧触发重渲染。
 */
import {
	AXES,
	EMPTY_PAD_STATE,
	STANDARD_BUTTONS,
	applyDeadzone,
	quantize,
	sameState,
	type PadState
} from '$lib/shared/pad';

/* sameState 落在 shared/pad.ts：采集端也要用它做「只发变化」，放在 client/ 里跨包取不到 */
export { sameState };

/**
 * 手柄数据的来源。
 *
 * - `remote`：Windows 采集端经 /ws/pad 上报（OBS 在后台也能用，见 docs/design.md §21）
 * - `local`：本页通过 Gamepad API 自己读（需要浏览器窗口有焦点）
 * - `mock`：脚本化的假输入（无手柄的开发环境）
 */
export type PadSource = 'remote' | 'local' | 'mock';

export type PadListener = (state: PadState, source: PadSource) => void;

export interface PadReader {
	/** 本读取器的数据来源，用于 UI 提示与排障 */
	readonly kind: PadSource;
	start(onChange: PadListener): () => void;
}

/** 从 Gamepad 快照构造归一化状态 */
export function snapshot(pad: Gamepad): PadState {
	const buttons: PadState['buttons'] = {};
	let pressed = false;

	for (let i = 0; i < STANDARD_BUTTONS.length; i++) {
		const name = STANDARD_BUTTONS[i];
		const btn = pad.buttons[i];
		const value = btn ? quantize(btn.value) : 0;
		const isPressed = btn ? btn.pressed || btn.value > 0 : false;
		buttons[name] = { pressed: isPressed, value };
		if (isPressed) pressed = true;
	}

	const axes: [number, number, number, number] = [
		quantize(applyDeadzone(pad.axes[AXES.LX] ?? 0)),
		quantize(applyDeadzone(pad.axes[AXES.LY] ?? 0)),
		quantize(applyDeadzone(pad.axes[AXES.RX] ?? 0)),
		quantize(applyDeadzone(pad.axes[AXES.RY] ?? 0))
	];
	if (axes.some((a) => a !== 0)) pressed = true;

	return {
		connected: true,
		id: pad.id,
		mapping: pad.mapping ?? '',
		buttons,
		axes,
		pressed
	};
}

/** 真实手柄读取器：rAF 轮询 */
export class GamepadReader implements PadReader {
	readonly kind = 'local' as const;

	start(onChange: PadListener): () => void {
		let raf = 0;
		let last: PadState = EMPTY_PAD_STATE;

		const tick = (): void => {
			const pads = navigator.getGamepads?.() ?? [];
			// 取第一个已连接的手柄
			let pad: Gamepad | null = null;
			for (const p of pads) {
				if (p && p.connected) {
					pad = p;
					break;
				}
			}

			const next = pad ? snapshot(pad) : EMPTY_PAD_STATE;
			if (!sameState(last, next)) {
				last = next;
				onChange(next, 'local');
			}

			raf = requestAnimationFrame(tick);
		};

		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}
}
