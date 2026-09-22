<script lang="ts">
	/**
	 * 调试控制条（HUD）。
	 *
	 * 默认关闭（配置项 hud），`?hud=1` 打开。
	 * 只在鼠标移动时出现；OBS 浏览器源不派发鼠标事件，所以即使开着也不会
	 * 出现在直播画面里，但为了保险仍默认关闭。
	 */
	import { page } from '$app/state';
	import LoginPanel from './LoginPanel.svelte';

	interface Props {
		/** 当前视图开关，用于按钮高亮 */
		labels: boolean;
		guides: boolean;
		transparent: boolean;
		hole: boolean;
		/** 是否已配置登录态（仅表示「传进去了」，不代表已校验有效） */
		loggedIn?: boolean;
	}

	let { labels, guides, transparent, hole, loggedIn = false }: Props = $props();

	let visible = $state(false);
	let loginOpen = $state(false);
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	function show(): void {
		visible = true;
		if (hideTimer) clearTimeout(hideTimer);
		/* 登录面板开着时不要自动隐藏控制条，否则面板会显得没有归属 */
		if (loginOpen) return;
		hideTimer = setTimeout(() => (visible = false), 2800);
	}

	/** 切换某个 URL 参数并重载（保持简单、无状态） */
	function toggle(key: string, current: boolean): void {
		const q = new URLSearchParams(page.url.search);
		q.set(key, current ? '0' : '1');
		location.search = q.toString();
	}

	/** 复制 OBS 用的地址（去掉调试参数，带上 hole） */
	function copyObsUrl(): void {
		const url = `${location.origin}/?hole=1`;
		void navigator.clipboard?.writeText(url);
		show();
	}

	$effect(() => {
		const onMove = () => show();
		window.addEventListener('mousemove', onMove);
		return () => window.removeEventListener('mousemove', onMove);
	});

	/*
	 * 面板开着时阻止快捷键切换视图：在输入口令时按到 l/g/b/h
	 * 会直接重载页面（toggle 是改 URL 参数），把已输入的流程全丢掉。
	 */
	function onKeydown(e: KeyboardEvent): void {
		if (loginOpen) return;
		const k = e.key.toLowerCase();
		if (k === 'l') toggle('label', labels);
		if (k === 'g') toggle('guide', guides);
		if (k === 'b') toggle('bg', transparent);
		if (k === 'h') toggle('hole', hole);
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="hud" class:on={visible}>
	<button class:on={labels} onclick={() => toggle('label', labels)}>标签</button>
	<button class:on={guides} onclick={() => toggle('guide', guides)}>参考线</button>
	<button class:on={transparent} onclick={() => toggle('bg', transparent)}>透明背景</button>
	<button class:on={hole} onclick={() => toggle('hole', hole)}>视频洞</button>
	<div class="sep"></div>
	<button onclick={copyObsUrl}>复制 OBS 地址</button>
	<div class="sep"></div>
	<button class:on={loggedIn} onclick={() => (loginOpen = !loginOpen)}>
		{loggedIn ? '已登录' : '登录'}
	</button>
	<div class="sep"></div>
	<span class="tip">OBS: 1920×1080 · /only/chat 474×630 · /only/pad 474×304</span>
</div>

{#if loginOpen}
	<LoginPanel onClose={() => (loginOpen = false)} />
{/if}
