<script lang="ts">
	import Scene from '$lib/components/Scene.svelte';
	import VideoBox from '$lib/components/VideoBox.svelte';
	import NoticeBox from '$lib/components/NoticeBox.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import PadBox from '$lib/components/PadBox.svelte';
	import { BOXES } from '$lib/shared/geometry';
	import type { DanmakuEvent } from '$lib/shared/types';
	import { resolveViewOptions, type ViewOptions } from '$lib/shared/view';
	import { page } from '$app/state';

	let { data } = $props();

	const view = $derived(
		resolveViewOptions(page.url.search, data.view as Partial<ViewOptions>) as ViewOptions
	);

	const dim = (k: keyof typeof BOXES) =>
		`${Math.round(BOXES[k].w)}×${Math.round(BOXES[k].h)}`;

	/* 占位：弹幕接入在后续提交完成 */
	const items: DanmakuEvent[] = $state([]);
</script>

<Scene>
	<div class="col-left">
		<VideoBox guides={view.guides} dimText={dim('video')} />
		<NoticeBox guides={view.guides} dimText={dim('notice')} />
	</div>
	<div class="col-right">
		<ChatPanel {items} guides={view.guides} dimText={dim('chat')} roomLabel={view.room} />
		<PadBox mock={view.mock} guides={view.guides} dimText={dim('pad')} />
	</div>
</Scene>
