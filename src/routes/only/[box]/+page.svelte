<script lang="ts">
	/**
	 * 独立单框页：/only/<box>，渲染成恰好该框的精确像素尺寸并填满视口（无缩放、无 HUD）。
	 * OBS 里把浏览器源的宽高填成上面 geometry 给出的外框数值即可零误差对齐。
	 */
	import { page } from '$app/state';
	import ChatBox from '$lib/components/ChatBox.svelte';
	import PadBox from '$lib/components/PadBox.svelte';
	import VideoBox from '$lib/components/VideoBox.svelte';
	import NoticeBox from '$lib/components/NoticeBox.svelte';
	import { BOXES, PANELS, type BoxName } from '$lib/shared/geometry';
	import { STATE_TEXT } from '$lib/shared/chat';
	import { createDanmakuFeed, type DanmakuFeed } from '$lib/client/feed.svelte';
	import { resolveViewOptions, type ViewOptions } from '$lib/shared/view';

	let { data } = $props();

	const view = $derived(resolveViewOptions(page.url.search, data.view as Partial<ViewOptions>));

	const box = $derived((page.params.box ?? 'chat') as BoxName);
	const valid = $derived(box in BOXES);

	/** 只有聊天页需要弹幕数据源 */
	let feed = $state.raw<DanmakuFeed | null>(null);

	$effect(() => {
		if (box !== 'chat') return;
		const created = createDanmakuFeed({ room: view.room, mock: view.mock });
		feed = created;
		return () => created.stop();
	});

	/* 面板外框尺寸，即 OBS 里该填的数值 */
	const dimText = $derived(
		valid ? `${Math.round(PANELS[box].w)}×${Math.round(PANELS[box].h)}` : ''
	);

</script>

<svelte:head>
	<title>only/{box} · {dimText}</title>
</svelte:head>

{#if !valid}
	<div class="only-error">
		<p>未知的框名：<code>{box}</code></p>
		<p>可用：video / notice / chat / pad</p>
	</div>
{:else}
	<!-- 每个 XxxBox 都是完整面板（含标题栏），这里直接用，不要再包一层 Panel -->
	<div class="only-page" class:bg-transparent={view.transparent}>
		{#if box === 'chat'}
			<ChatBox
				items={feed?.items ?? []}
				live={feed?.status ?? { t: 'status', s: 'idle' }}
				roomLabel={feed?.realRoom || view.room}
				guides={view.guides}
				dimText={dimText}
				fill
			/>
		{:else if box === 'pad'}
			<PadBox mock={view.mock} guides={view.guides} dimText={dimText} fill />
		{:else if box === 'video'}
			<VideoBox guides={view.guides} dimText={dimText} fill hole={view.hole} />
		{:else}
			<NoticeBox guides={view.guides} dimText={dimText} fill />
		{/if}
	</div>
{/if}

<style>
	.only-error {
		position: fixed;
		inset: 0;
		display: grid;
		place-content: center;
		gap: 6px;
		background: #0d1120;
		color: #cfd4e6;
		font-family: ui-monospace, Consolas, monospace;
		font-size: 14px;
		text-align: center;
	}

	code {
		color: #4de2ff;
	}
</style>
