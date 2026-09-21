<script lang="ts">
	import type { Snippet } from 'svelte';
	import Panel from './Panel.svelte';

	interface Props {
		guides?: boolean;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dimText?: string;
		/** 内容区插槽，公告框本期为空 */
		children?: Snippet;
	}

	let { guides = false, dimText = '', children }: Props = $props();
</script>

<!-- 公告框：本期不做内容，仅保留框体与标题栏 -->
<Panel variant="notice" accent="--yl" sprite="bell" en="NOTICE" cn="公告框" {guides}>
	{#snippet dim()}{dimText}{/snippet}
	{#if children}{@render children()}{/if}
</Panel>
