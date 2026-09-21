<script lang="ts">
	import Panel from './Panel.svelte';
	import ChatBox from './ChatBox.svelte';
	import type { DanmakuEvent, RoomState } from '$lib/shared/types';

	interface Props {
		items: DanmakuEvent[];
		/** 连接状态，标题栏指示灯用 */
		stateName?: RoomState;
		/** 真实房间号，显示在指示灯后 */
		roomLabel?: string;
		guides?: boolean;
		/** 标题栏右侧尺寸标注，仅参考线模式显示 */
		dimText?: string;
	}

	let { items, stateName = 'idle', roomLabel = '', guides = false, dimText = '' }: Props = $props();

	/** 状态 → 指示灯文案与配色类 */
	const STATE_TEXT: Record<RoomState, string> = {
		idle: '未连接',
		connecting: '连接中',
		connected: '已连接',
		reconnecting: '重连中',
		error: '异常'
	};
</script>

<Panel variant="chat" accent="--gr" sprite="bubble" en="CHAT" cn="聊天框" {guides}>
	{#snippet status()}
		<span class="status status-{stateName}">
			<span class="status-dot"></span>{roomLabel ? `${roomLabel} · ` : ''}{STATE_TEXT[stateName]}
		</span>
	{/snippet}
	{#snippet dim()}{dimText}{/snippet}

	<ChatBox {items} />
</Panel>
