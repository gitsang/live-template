<script lang="ts">
	import type { Snippet } from 'svelte';
	import Panel from './Panel.svelte';

	interface Props {
		guides?: boolean;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dimText?: string;
		/** 内容区插槽，视频框当前为空 */
		children?: Snippet;
		/** 撑满父容器（独立单框页用） */
		fill?: boolean;
		/** 仅内容区透明（视频框的透明洞）。整页模式由 html.hole-on 控制。 */
		hole?: boolean;
	}

	let { guides = false, dimText = '', children, fill = false, hole = false }: Props = $props();
</script>

<!-- 视频框内容区可置为透明，让 OBS 下方的显示器采集透出 -->
<Panel variant="video" accent="--cy" sprite="screen" en="VIDEO" cn="视频框" {guides} {fill} {hole}>
	{#snippet dim()}{dimText}{/snippet}
	{#if children}{@render children()}{/if}
</Panel>
