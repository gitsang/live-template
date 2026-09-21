<script lang="ts">
	import Scene from '$lib/components/Scene.svelte';
	import VideoBox from '$lib/components/VideoBox.svelte';
	import NoticeBox from '$lib/components/NoticeBox.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import PadBox from '$lib/components/PadBox.svelte';
	import { BOXES } from '$lib/shared/geometry';
	import { createDanmakuFeed, type DanmakuFeed } from '$lib/client/feed.svelte';
	import { resolveViewOptions, type ViewOptions } from '$lib/shared/view';
	import { page } from '$app/state';

	let { data } = $props();

	const view = $derived(resolveViewOptions(page.url.search, data.view as Partial<ViewOptions>));

	/**
	 * 弹幕数据源：mock 时完全离线。
	 *
	 * 用 $effect 而不是直接调用：createDanmakuFeed 会建立 WebSocket 连接，
	 * 必须在客户端挂载后运行，并且随 room/mock 变化重建（返回的 stop() 负责
	 * 关闭旧连接）。直接写在组件体里会捕获初始值且会在 SSR 阶段执行。
	 */
	let feed = $state.raw<DanmakuFeed | null>(null);

	$effect(() => {
		const room = view.room;
		const mock = view.mock;
		const created = createDanmakuFeed({ room, mock });
		feed = created;
		return () => created.stop();
	});

	const dim = (k: keyof typeof BOXES): string =>
		`${Math.round(BOXES[k].w)}×${Math.round(BOXES[k].h)}`;
</script>

<Scene>
	<div class="col-left">
		<VideoBox guides={view.guides} dimText={dim('video')} />
		<NoticeBox guides={view.guides} dimText={dim('notice')} />
	</div>
	<div class="col-right">
		<ChatPanel
			items={feed?.items ?? []}
			live={feed?.status ?? { t: 'status', s: 'idle' }}
			roomLabel={feed?.realRoom || view.room}
			guides={view.guides}
			dimText={dim('chat')}
		/>
		<PadBox mock={view.mock} guides={view.guides} dimText={dim('pad')} />
	</div>
</Scene>
