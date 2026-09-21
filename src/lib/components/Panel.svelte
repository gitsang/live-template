<script lang="ts">
	import type { Snippet } from 'svelte';
	import Sprite from './Sprite.svelte';
	import type { BoxName } from '$lib/shared/geometry';
	import { OUTER_H } from '$lib/shared/geometry';

	interface Props {
		/** 决定 slot-* 类名与默认高度 */
		variant: BoxName;
		/** 强调色变量名，如 '--cy' */
		accent: string;
		sprite: string;
		en: string;
		cn: string;
		/** 内容区附加类名（如 chat-list / pad-body） */
		bodyClass?: string;
		/** 仅内容区透明（视频框的透明洞） */
		hole?: boolean;
		/** 是否画四角参考括号 */
		guides?: boolean;
		/** 拉伸填满父容器（独立单框页用），不套用几何高度 */
		fill?: boolean;
		/** 标题栏右侧常驻状态区（连接指示灯等） */
		status?: Snippet;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dim?: Snippet;
		children: Snippet;
	}

	let {
		variant,
		accent,
		sprite,
		en,
		cn,
		bodyClass = '',
		hole = false,
		guides = false,
		fill = false,
		status,
		dim,
		children
	}: Props = $props();

	const slotClass = $derived(['slot', `slot-${variant}`].join(' '));

	const slotStyle = $derived(
		[
			`--accent:var(${accent})`,
			hole ? '--slot:transparent' : '',
			fill ? '' : `height:${OUTER_H[variant].toFixed(2)}px`,
			/* 视频框内容区高度由 theme.css 用 --video-h 推导 */
			variant === 'video' ? `--video-h:${OUTER_H.video.toFixed(2)}px` : ''
		]
			.filter(Boolean)
			.join(';')
	);
</script>

<div class={slotClass} style={slotStyle}>
	<div class="hd">
		<span class="sprite" style="color:var({accent})">
			<Sprite name={sprite} cut="var(--panel)" />
		</span>
		<b class="en">{en}</b>
		<span class="cn">{cn}</span>
		<span class="dim">
			{#if status}{@render status()}{/if}
			{#if dim}<span class="guide dim-measure">{@render dim()}</span>{/if}
		</span>
	</div>
	<div class="body {bodyClass}">
		{#if guides}
			<div class="guide brk tl"></div>
			<div class="guide brk tr"></div>
			<div class="guide brk bl"></div>
			<div class="guide brk br"></div>
		{/if}
		{@render children()}
	</div>
</div>
