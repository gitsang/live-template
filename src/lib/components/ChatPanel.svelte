<script lang="ts">
	import Panel from './Panel.svelte';
	import ChatBox from './ChatBox.svelte';
	import { STATE_TEXT } from '$lib/shared/chat';
	import type { DanmakuEvent, StatusEvent } from '$lib/shared/types';

	interface Props {
		items: DanmakuEvent[];
		/** 连接状态，标题栏指示灯用 */
		live: StatusEvent;
		/** 真实房间号，显示在指示灯后 */
		roomLabel?: string;
		guides?: boolean;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dimText?: string;
	}

	let { items, live, roomLabel = '', guides = false, dimText = '' }: Props = $props();
</script>

<Panel variant="chat" accent="--gr" sprite="bubble" en="CHAT" cn="聊天框" {guides}>
	{#snippet status()}
		<span class="status status-{live.s}">
			<span class="status-dot"></span>{roomLabel ? `${roomLabel} · ` : ''}{STATE_TEXT[live.s]}
		</span>
	{/snippet}
	{#snippet dim()}{dimText}{/snippet}

	<ChatBox {items} />
</Panel>
