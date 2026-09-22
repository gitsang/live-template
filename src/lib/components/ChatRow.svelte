<script lang="ts">
	/**
	 * 单条聊天记录的内容（不含外壳）。
	 *
	 * 外壳由 ChatBox 的 .chat-row 提供，左侧色条是它的 ::before ——
	 * CSS 自定义属性只向下继承，所以强调色必须由外层设置。
	 * 弹幕/礼物/SC 都带 uid / u / lv / guard / medal，徽章部分共用。
	 */
	import Sprite from './Sprite.svelte';
	import { formatPrice, guardColor, guardName, nameColor, pickAccent } from '$lib/shared/chat';
	import type { DanmakuItem } from '$lib/shared/types';

	interface Props {
		item: DanmakuItem;
	}

	let { item }: Props = $props();

	/* 种子优先 user_hash：真实环境 uid 恒为 0、昵称可能是打码串 */
	const color = $derived(nameColor(item.uh || item.uid, item.u));
	const guard = $derived(guardName(item.guard));
	const guardTint = $derived(guardColor(item.guard));

	const isDanmaku = $derived(item.t === 'danmaku');
	const admin = $derived(item.t === 'danmaku' && item.admin);
	const vip = $derived(item.t === 'danmaku' && item.vip);
	const scAccent = $derived(
		item.t === 'sc' ? pickAccent(item.colorBottom, item.colorEnd, item.colorStart) : ''
	);
</script>

<!-- 弹幕 -->
{#if item.t === 'danmaku'}
	<span class="name" style="color:{color}">{item.u}</span>
	{#if admin}<span class="badge badge-admin" title="房管">管</span>{/if}
	{#if vip}<span class="badge badge-vip" title="大会员">大</span>{/if}
	{#if item.medal}
		<span class="medal" title="粉丝牌 {item.medal[0]} {item.medal[1]}">
			<b>{item.medal[0]}</b><i>{item.medal[1]}</i>
		</span>
	{/if}
	{#if guard}
		<span class="badge badge-guard" style="--g:{guardTint}">{guard}</span>
	{/if}
	{#if item.lv > 0}<span class="lv" title="UL {item.lv}">{item.lv}</span>{/if}
	<span class="text">{item.m}</span>

	<!-- 礼物 -->
{:else if item.t === 'gift'}
	<span class="gift-icon" aria-hidden="true"><Sprite name="gift" /></span>
	<span class="name" style="color:{color}">{item.u}</span>
	{#if item.medal}
		<span class="medal" title="粉丝牌 {item.medal[0]} {item.medal[1]}">
			<b>{item.medal[0]}</b><i>{item.medal[1]}</i>
		</span>
	{/if}
	{#if guard}
		<span class="badge badge-guard" style="--g:{guardTint}">{guard}</span>
	{/if}
	<span class="text gift-text">
		赠送 <em class="gift-name">{item.g}</em>
		{#if item.n > 1}<span class="gift-num">×{item.n}</span>{/if}
	</span>

	<!-- 醒目留言 -->
{:else if item.t === 'sc'}
	<span class="sc-head">
		<span class="sc-icon" aria-hidden="true"><Sprite name="star" /></span>
		<span class="sc-price">￥{formatPrice(item.price)}</span>
		<span class="name" style="color:{color}">{item.u}</span>
		{#if item.medal}
			<span class="medal" title="粉丝牌 {item.medal[0]} {item.medal[1]}">
				<b>{item.medal[0]}</b><i>{item.medal[1]}</i>
			</span>
		{/if}
		{#if guard}
			<span class="badge badge-guard" style="--g:{guardTint}">{guard}</span>
		{/if}
		{#if item.lv > 0}<span class="lv" title="UL {item.lv}">{item.lv}</span>{/if}
	</span>
	<span class="text sc-text">{item.m}</span>
{/if}
