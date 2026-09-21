<script lang="ts">
	import type { Snippet } from 'svelte';
	import Panel from './Panel.svelte';

	interface Props {
		guides?: boolean;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dimText?: string;
		/** 内容区插槽，视频/公告框当前为空 */
		children?: Snippet;
	}

	let { guides = false, dimText = '', children }: Props = $props();
</script>

<!-- 视频框内容区由 html.hole-on 置为透明，让 OBS 下方的显示器采集透出 -->
<Panel variant="video" accent="--cy" sprite="screen" en="VIDEO" cn="视频框" {guides}>
	{#snippet dim()}{dimText}{/snippet}
	{#if children}{@render children()}{/if}
</Panel>
