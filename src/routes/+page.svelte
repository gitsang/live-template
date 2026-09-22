<script lang="ts">
	import Scene from '$lib/components/Scene.svelte';
	import VideoBox from '$lib/components/VideoBox.svelte';
	import NoticeBox from '$lib/components/NoticeBox.svelte';
	import ChatBox from '$lib/components/ChatBox.svelte';
	import PadBox from '$lib/components/PadBox.svelte';
	import Hud from '$lib/components/Hud.svelte';
	import { panelSpec } from '$lib/shared/geometry';
	import { createDanmakuFeed, type DanmakuFeed } from '$lib/client/feed.svelte';
	import { resolveViewOptions, type ViewOptions } from '$lib/shared/view';
	import { page } from '$app/state';

	let { data } = $props();

	const view = $derived(resolveViewOptions(page.url.search, data.view as Partial<ViewOptions>));

	/* 已配置登录态（服务端判定，扫码成功后无需刷新即可更新） */
	const loggedIn = $derived(Boolean((data as { auth?: boolean }).auth));

	/*
	 * 用 $effect 而不是直接调用：createDanmakuFeed 会建立 WebSocket 连接，
	 * 必须在客户端挂载后运行，并随 room/mock 变化重建（stop() 关闭旧连接）。
	 * 写在组件体里会捕获初始值，且会在 SSR 阶段执行。
	 */
	let feed = $state.raw<DanmakuFeed | null>(null);

	$effect(() => {
		const room = view.room;
		const mock = view.mock;
		const created = createDanmakuFeed({ room, mock });
		feed = created;
		return () => created.stop();
	});

	/* 参考线模式下在标题栏显示 OBS 源应填的宽高与位置 */
	const dim = panelSpec;
</script>

<Scene>
	<div class="col-left">
		<VideoBox guides={view.guides} dimText={dim('video')} />
		<NoticeBox guides={view.guides} dimText={dim('notice')} />
	</div>
	<div class="col-right">
		<ChatBox
			items={feed?.items ?? []}
			live={feed?.status ?? { t: 'status', s: 'idle' }}
			roomLabel={feed?.realRoom || view.room}
			guides={view.guides}
			dimText={dim('chat')}
		/>
		<PadBox mock={view.mock} guides={view.guides} dimText={dim('pad')} />
	</div>
</Scene>

{#if view.hud}
	<Hud
		labels={view.labels}
		guides={view.guides}
		transparent={view.transparent}
		hole={view.hole}
		{loggedIn}
	/>
{/if}
