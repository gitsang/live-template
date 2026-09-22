<script lang="ts">
	import type { Snippet } from 'svelte';
	import Panel from './Panel.svelte';

	interface Props {
		guides?: boolean;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dimText?: string;
		/** 内容区插槽，当前为空 */
		children?: Snippet;
		/** 撑满父容器（独立单框页用） */
		fill?: boolean;
		/** 仅内容区透明；整页模式由 html.hole-on 控制 */
		hole?: boolean;
	}

	let { guides = false, dimText = '', children, fill = false, hole = false }: Props = $props();
</script>

<!-- 内容区透明，让 OBS 下方的显示器采集透出 -->
<Panel variant="video" accent="--cy" sprite="screen" en="VIDEO" cn="视频框" {guides} {fill} {hole}>
	{#snippet dim()}{dimText}{/snippet}
	{#if children}{@render children()}{/if}
</Panel>
