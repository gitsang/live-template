<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { CANVAS, baseVars } from '$lib/shared/geometry';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	let canvasEl: HTMLDivElement | undefined = $state();
	/** 画布缩放比（OBS 内 16:9 时为 1） */
	let scale = $state(1);

	function layout(): void {
		scale = Math.min(window.innerWidth / CANVAS.w, window.innerHeight / CANVAS.h);
	}

	onMount(() => {
		layout();
		window.addEventListener('resize', layout);
		/* 字体加载完可能改变布局，需重算 */
		document.fonts?.ready.then(layout);
		return () => window.removeEventListener('resize', layout);
	});
</script>

<div class="viewport">
	<div class="canvas" bind:this={canvasEl} style="{baseVars()};transform:scale({scale})">
		<div class="scene">
			{@render children()}
		</div>
	</div>
</div>
