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
	type PadState
} from '$lib/shared/pad';

export type PadListener = (state: PadState) => void;

export interface PadReader {
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

/** 真实手柄读取器：rAF 轮询 */
export class GamepadReader implements PadReader {
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
				onChange(next);
			}

			raf = requestAnimationFrame(tick);
		};

		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}
}
