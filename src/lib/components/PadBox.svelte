<script lang="ts">
	/**
	 * 手柄操作框。
	 *
	 * 读取：rAF 持续轮询 navigator.getGamepads()，不依赖 gamepadconnected 事件
	 *       （Chromium 只在收到一次按键后才把设备暴露给页面）。
	 * 渲染：全量键位，只显示当前按下，松开即熄灭，无历史序列。
	 * 状态：无手柄或全部松开时整框 opacity 0.55；无设备时显示呼吸提示。
	 */
	import Panel from './Panel.svelte';
	import { GamepadReader } from '$lib/client/gamepad';
	import { PadMockReader } from '$lib/client/pad-mock';
	import { stickTransform, type PadState } from '$lib/shared/pad';

	interface Props {
		guides?: boolean;
		/** 标题栏右侧尺寸标注 */
		dimText?: string;
		/** 用假输入序列替代真实手柄（无手柄的开发环境） */
		mock?: boolean;
		/** 撑满父容器（独立单框页用） */
		fill?: boolean;
	}

	let { guides = false, dimText = '', mock = false, fill = false }: Props = $props();

	const EMPTY: PadState = {
		connected: false,
		id: '',
		mapping: '',
		buttons: {},
		axes: [0, 0, 0, 0],
		pressed: false
	};

	let state: PadState = $state(EMPTY);

	$effect(() => {
		const reader = mock ? new PadMockReader() : new GamepadReader();
		const stop = reader.start((s) => {
			state = s;
		});
		return stop;
	});

	/* ---- 取值助手 ---- */
	const b = (n: string): boolean => state.buttons[n]?.pressed ?? false;
	const v = (n: string): number => state.buttons[n]?.value ?? 0;

	/** 扳机进度条：0 → 1 */
	function trig(name: string): { pct: string; num: string } {
		const val = v(name);
		return { pct: `${(val * 100).toFixed(0)}%`, num: `${Math.round(val * 100)}` };
	}

	/* 摇杆圆点位移按像素计算，具体原因见 shared/pad.ts 的 STICK_MAX_TRAVEL */
	const stick = stickTransform;

	const [lx, ly, rx, ry] = $derived(state.axes);
	const lMag = $derived(Math.hypot(lx, ly));
	const rMag = $derived(Math.hypot(rx, ry));
</script>

<Panel variant="pad" accent="--mg" sprite="pad" en="GAMEPAD" cn="手柄操作框" {guides} {fill}>
	{#snippet dim()}
		{state.connected ? (state.pressed ? '● 输入中' : '○ 待机') : ''}{dimText
			? (state.connected ? ' · ' : '') + dimText
			: ''}
	{/snippet}

	<div class="pad-body" class:idle={!state.connected || !state.pressed}>
		<!-- 键位底图水印（沿用模板） -->
		<svg
			class="padhint"
			viewBox="0 0 120 76"
			shape-rendering="crispEdges"
			preserveAspectRatio="xMidYMid meet"
			aria-hidden="true"
		>
			<rect x="30" y="20" width="14" height="36" fill="rgba(255,255,255,.10)" />
			<rect x="19" y="31" width="36" height="14" fill="rgba(255,255,255,.10)" />
			<rect x="33" y="34" width="8" height="8" fill="rgba(255,255,255,.06)" />
			<rect x="86" y="24" width="14" height="14" fill="rgba(255,255,255,.10)" />
			<rect x="102" y="38" width="14" height="14" fill="rgba(255,255,255,.10)" />
			<rect x="86" y="52" width="14" height="14" fill="rgba(255,255,255,.10)" />
			<rect x="70" y="38" width="14" height="14" fill="rgba(255,255,255,.10)" />
			<rect x="52" y="60" width="10" height="4" fill="rgba(255,255,255,.08)" />
			<rect x="66" y="60" width="10" height="4" fill="rgba(255,255,255,.08)" />
		</svg>

		<!-- 肩键 + 扳机 -->
		<div class="pad-triggers">
			<div class="pad-side">
				<span class="pad-bumper" class:on={b('LB')}>LB</span>
				<span class="pad-trigger">
					<span class="pad-trigger-label">LT</span>
					<span class="pad-bar"><i style="width:{trig('LT').pct}"></i></span>
					<span class="pad-trigger-value">{trig('LT').num}</span>
				</span>
			</div>
			<div class="pad-side">
				<span class="pad-trigger">
					<span class="pad-trigger-label">RT</span>
					<span class="pad-bar"><i style="width:{trig('RT').pct}"></i></span>
					<span class="pad-trigger-value">{trig('RT').num}</span>
				</span>
				<span class="pad-bumper" class:on={b('RB')}>RB</span>
			</div>
		</div>

		<!-- 主体 -->
		<div class="pad-main">
			<!-- 左：摇杆 + 十字键 -->
			<div class="pad-wing">
				<div class="pad-stick" class:pushed={lMag > 0.08} class:pressed={b('LS')}>
					<i style="transform:{stick(lx, ly)}"></i>
					<b>L3</b>
				</div>
				<div class="pad-dpad">
					<button class="d-up" class:on={b('Up')} aria-label="十字键上"></button>
					<button class="d-left" class:on={b('Left')} aria-label="十字键左"></button>
					<button class="d-center" disabled aria-hidden="true"></button>
					<button class="d-right" class:on={b('Right')} aria-label="十字键右"></button>
					<button class="d-down" class:on={b('Down')} aria-label="十字键下"></button>
				</div>
			</div>

			<!-- 中：中键 -->
			<div class="pad-center">
				<button class="pad-mini" class:on={b('Back')}>VIEW</button>
				<button class="pad-mini guide" class:on={b('Guide')} aria-label="Guide">G</button>
				<button class="pad-mini" class:on={b('Start')}>MENU</button>
			</div>

			<!-- 右：ABXY + 右摇杆 -->
			<div class="pad-wing">
				<div class="pad-face">
					<button class="f-y" class:on={b('Y')} aria-label="Y">Y</button>
					<button class="f-x" class:on={b('X')} aria-label="X">X</button>
					<button class="f-b" class:on={b('B')} aria-label="B">B</button>
					<button class="f-a" class:on={b('A')} aria-label="A">A</button>
				</div>
				<div class="pad-stick" class:pushed={rMag > 0.08} class:pressed={b('RS')}>
					<i style="transform:{stick(rx, ry)}"></i>
					<b>R3</b>
				</div>
			</div>
		</div>

		{#if !state.connected}
			<div class="pad-hint">
				按任意键唤醒手柄
				<br />
				<span style="font-size:10px;letter-spacing:1px">PRESS ANY BUTTON</span>
			</div>
		{/if}
	</div>
</Panel>
