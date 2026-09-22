<script lang="ts">
	import '../lib/styles/theme.css';
	import { page } from '$app/state';
	import { applyViewOptions, resolveViewOptions, type ViewOptions } from '$lib/shared/view';

	let { children, data } = $props();

	/** 服务端下发的默认值（config.json / 环境变量） */
	const base = $derived(data.view as Partial<ViewOptions>);

	/** URL 参数覆盖服务端配置 */
	const view = $derived(resolveViewOptions(page.url.search, base));

	/* 开关映射到 <html> 类名；DOM 未就绪时忽略（SSR 阶段） */
	$effect(() => {
		applyViewOptions(view);
	});
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

{@render children()}
