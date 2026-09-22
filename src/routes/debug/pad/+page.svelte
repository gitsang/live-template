<script lang="ts">
	/**
	 * 手柄调试页 /debug/pad：在 OBS 之外用普通浏览器打开，快速判断「手柄没反应」是
	 * 设备/驱动、API 还是 OBS 的问题（见 docs/design.md §2.4）。
	 */
	import { GamepadReader } from '$lib/client/gamepad';
	import { PadMockReader } from '$lib/client/pad-mock';
	import { STANDARD_BUTTONS, type PadState } from '$lib/shared/pad';
	import { page } from '$app/state';

	const EMPTY: PadState = {
		connected: false,
		id: '',
		mapping: '',
		buttons: {},
		axes: [0, 0, 0, 0],
		pressed: false
	};

	/* 变量名不能叫 state —— 会与 $state rune 冲突 */
	let pad = $state<PadState>(EMPTY);
	/** 是否支持 Gamepad API */
	let supported = $state(true);

	const mock = $derived(page.url.searchParams.has('mock'));

	$effect(() => {
		supported = typeof navigator !== 'undefined' && 'getGamepads' in navigator;
		const useMock = mock;
		const reader = useMock ? new PadMockReader() : new GamepadReader();
		return reader.start((s) => (pad = s));
	});

	function bar(v: number): string {
		return `${Math.round(v * 100)}%`;
	}

	/** 轴列表显式标注为 [名称, 值] 元组，避免 {#each} 推断出 (string|number)[] */
	const axisList = $derived<Array<[string, number]>>([
		['LX', pad.axes[0]],
		['LY', pad.axes[1]],
		['RX', pad.axes[2]],
		['RY', pad.axes[3]]
	]);
</script>

<svelte:head><title>手柄调试</title></svelte:head>

<div class="dbg">
	<h1>手柄调试 <span class="tag">/debug/pad</span></h1>

	{#if !supported}
		<p class="warn">当前浏览器不支持 Gamepad API。</p>
	{/if}

	<section>
		<h2>设备</h2>
		<dl>
			<dt>状态</dt>
			<dd class:ok={pad.connected} class:bad={!pad.connected}>
				{pad.connected ? '已检测到手柄' : '未检测到（请按一次手柄上的任意键唤醒）'}
			</dd>
			<dt>名称</dt>
			<dd>{pad.id || '—'}</dd>
			<dt>mapping</dt>
			<dd>{pad.mapping || '—'} {pad.mapping === 'standard' ? '(标准布局)' : ''}</dd>
			<dt>有输入</dt>
			<dd>{pad.pressed ? '是' : '否'}</dd>
		</dl>
		{#if mock}
			<p class="note">mock 模式：使用脚本化的假输入序列。</p>
		{/if}
	</section>

	<section>
		<h2>摇杆原始轴</h2>
		<div class="axes">
			{#each axisList as [name, val] (name)}
				<div class="axis">
					<span class="k">{name}</span>
					<span class="track"><i style="width:{bar((val + 1) / 2)}"></i></span>
					<span class="v">{val.toFixed(3)}</span>
				</div>
			{/each}
		</div>
	</section>

	<section>
		<h2>按键</h2>
		<div class="buttons">
			{#each STANDARD_BUTTONS as name (name)}
				{@const b = pad.buttons[name]}
				<div class="btn" class:on={b?.pressed}>
					<span class="k">{name}</span>
					<span class="track"><i style="width:{bar(b?.value ?? 0)}"></i></span>
					<span class="v">{(b?.value ?? 0).toFixed(2)}</span>
				</div>
			{/each}
		</div>
	</section>
</div>

<style>
	.dbg {
		min-height: 100vh;
		padding: 22px 26px 40px;
		background: #0d1120;
		color: #cfd4e6;
		font-family: ui-monospace, Consolas, monospace;
		font-size: 13px;
		overflow-y: auto;
	}

	h1 {
		font-size: 17px;
		letter-spacing: 1px;
		margin-bottom: 18px;
	}

	.tag {
		font-size: 12px;
		color: #6b7bb5;
	}

	h2 {
		font-size: 13px;
		color: #4de2ff;
		letter-spacing: 1.4px;
		margin: 18px 0 8px;
	}

	section {
		border-top: 1px solid rgba(107, 123, 181, 0.25);
		padding-top: 6px;
	}

	dl {
		display: grid;
		grid-template-columns: 88px 1fr;
		gap: 3px 10px;
	}

	dt {
		color: #6b7bb5;
	}

	.ok {
		color: #5ef08a;
	}

	.bad {
		color: #ffd93d;
	}

	.warn {
		color: #ff5c72;
	}

	.note {
		margin-top: 8px;
		color: #6b7bb5;
	}

	.axes,
	.buttons {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 4px 18px;
	}

	.axis,
	.btn {
		display: grid;
		grid-template-columns: 38px 1fr 46px;
		align-items: center;
		gap: 7px;
	}

	.k {
		color: #6b7bb5;
	}

	.btn.on .k {
		color: #5ef08a;
	}

	.axis .v,
	.btn .v {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.track {
		height: 8px;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid rgba(255, 255, 255, 0.1);
	}

	.track > i {
		display: block;
		height: 100%;
		background: #4de2ff;
		opacity: 0.8;
	}

	.btn.on .track > i {
		background: #5ef08a;
		opacity: 1;
	}
</style>
