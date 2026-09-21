<script lang="ts">
	/**
	 * 聊天框内容区。
	 *
	 * - 上旧下新，最新在底部
	 * - 内容超出高度才滚动，始终自动吸底
	 * - 长文换行（overflow-wrap: anywhere）
	 * - 进场淡入
	 * - DOM 上限 300 条，超出移除最旧
	 * - 追加/裁剪时用 FLIP 位移动画，保证既有条目平滑上移而不跳变
	 */
	import Panel from './Panel.svelte';
	import ChatRow from './ChatRow.svelte';
	import { STATE_TEXT, itemAccent, pickAccent } from '$lib/shared/chat';
	import type { DanmakuItem, StatusEvent } from '$lib/shared/types';

	interface Props {
		items: DanmakuItem[];
		/** 连接状态，用于标题栏指示灯 */
		live?: StatusEvent;
		/** 真实房间号 */
		roomLabel?: string;
		guides?: boolean;
		/** 尺寸标注，仅参考线模式显示 */
		dimText?: string;
		/** 撑满父容器（独立单框页用） */
		fill?: boolean;
	}

	let {
		items,
		live = { t: 'status', s: 'idle' },
		roomLabel = '',
		guides = false,
		dimText = '',
		fill = false
	}: Props = $props();

	/** DOM 中最多保留的行数 */
	const MAX_DOM = 300;

	let listEl: HTMLDivElement | undefined = $state();

	/** 只保留最近 MAX_DOM 条 */
	const visible = $derived(items.slice(-MAX_DOM));

	/** 更新前的行位置，用于 FLIP */
	let prevTops = new Map<number, number>();

	/** DOM 更新前记录位置 */
	$effect.pre(() => {
		void visible;
		const el = listEl;
		if (!el) return;
		const next = new Map<number, number>();
		for (const row of Array.from(el.children) as HTMLElement[]) {
			const id = Number(row.dataset.id);
			if (!Number.isNaN(id)) next.set(id, row.offsetTop);
		}
		prevTops = next;
	});

	/** DOM 更新后做位移补偿并吸底 */
	$effect(() => {
		void visible;
		const el = listEl;
		if (!el) return;

		const rows = Array.from(el.children) as HTMLElement[];
		for (const row of rows) {
			const id = Number(row.dataset.id);
			const before = prevTops.get(id);
			if (before === undefined) continue; // 新增行，交给淡入动画
			const delta = before - row.offsetTop;
			if (delta === 0) continue;

			/* 先瞬移到旧位置，下一帧再过渡回原位 */
			row.style.transition = 'none';
			row.style.transform = `translateY(${delta}px)`;
			requestAnimationFrame(() => {
				row.style.transition = '';
				row.style.transform = '';
			});
		}

		/* 始终吸底（OBS 中不会有用户滚动） */
		el.scrollTop = el.scrollHeight;
	});
</script>

<Panel variant="chat" accent="--gr" sprite="bubble" en="CHAT" cn="聊天框" {guides} {fill}>
	{#snippet status()}
		<span class="status status-{live.s}">
			<span class="status-dot"></span>{roomLabel ? `${roomLabel} · ` : ''}{STATE_TEXT[live.s]}
		</span>
	{/snippet}
	{#snippet dim()}{dimText}{/snippet}

	<div class="chat-list" bind:this={listEl}>
		{#each visible as item (item.id)}
			<!--
				强调色与 SC 主题色必须设在 .chat-row 上：
				左侧色条是它的 ::before，而自定义属性只向下继承。
			-->
			<div
				class="chat-row in"
				data-id={item.id}
				data-kind={item.t}
				data-coin={item.t === 'gift' ? item.coin : undefined}
				style="--row-accent:{itemAccent(item)}{item.t === 'sc'
					? `;--sc:${pickAccent(item.colorBottom, item.colorEnd, item.colorStart)}`
					: ''}"
			>
				<ChatRow {item} />
			</div>
		{/each}
</div>

	{#if visible.length === 0}
		<div class="chat-empty">等待弹幕…</div>
	{/if}
</Panel>
