<script lang="ts">
	/**
	 * B 站扫码登录面板（管理页内联使用）。
	 *
	 * 授权由**管理会话 Cookie** 负责（见 admin-session.ts），本组件不接触访问口令 ——
	 * 口令只在 /admin 的登入表单里出现一次。二维码由服务端渲染成 SVG，
	 * 但这只是实现选择，**不是**安全边界：图本身就是 qrcode_key 的图形编码。
	 */
	import type { QrStatus } from '$lib/shared/types';

	interface Status {
		status: QrStatus;
		text: string;
		svg?: string;
		account?: { uid: number; uname: string };
		error?: string;
		remainingMs: number;
	}

	interface Props {
		/** 登录完成（或用户主动结束）后的回调，由页面决定是否刷新 */
		onClose?: () => void;
	}

	let { onClose }: Props = $props();

	let status = $state<Status | null>(null);
	let busy = $state(false);
	let error = $state('');
	let timer: ReturnType<typeof setInterval> | null = null;

	const done = $derived(status?.status === 'success');
	const failed = $derived(status?.status === 'expired');

	function stopPolling(): void {
		if (timer) clearInterval(timer);
		timer = null;
	}

	async function call(path: string, init: RequestInit = {}): Promise<Status | null> {
		const res = await fetch(path, init);
		const body = (await res.json()) as { ok: boolean; error?: string } & Partial<Status>;
		if (!res.ok || !body.ok) {
			error = body.error ?? `请求失败（HTTP ${res.status}）`;
			stopPolling();
			return null;
		}
		error = '';
		return body as Status;
	}

	/** 开起挑战并开始轮询 */
	async function start(): Promise<void> {
		if (busy) return;
		busy = true;
		stopPolling();
		try {
			const s = await call('/api/login/qr', { method: 'POST' });
			if (!s) return;
			status = s;

			/*
			 * 轮询间隔取 2s：服务端还有 900ms 的节流兜底，
			 * 这里宽松一点既够及时，也不会对 B 站造成压力。
			 */
			timer = setInterval(() => void poll(), 2000);
		} finally {
			busy = false;
		}
	}

	async function poll(): Promise<void> {
		const s = await call('/api/login/status');
		if (!s) return;

		/*
		 * 保留上一份 SVG。
		 * 轮询接口**不会**回传二维码图（图即凭据等价物，且码本身不变），
		 * 所以直接 status = s 会把图抹掉 —— 表现为「刚出图就消失」，
		 * 只剩下状态文字，根本没法扫。
		 * 登录成功后不再保留：此时码已无用，界面只显示账号信息。
		 */
		const keepSvg = s.status === 'success' ? undefined : (s.svg ?? status?.svg);
		status = { ...s, svg: keepSvg };

		if (s.status === 'success' || s.status === 'expired') stopPolling();
	}

	async function cancel(): Promise<void> {
		stopPolling();
		await call('/api/login/cancel', { method: 'POST' });
		status = null;
	}

	$effect(() => () => stopPolling());
</script>

<div class="panel">
	{#if !status}
		<p class="hint">用 B 站 App 扫码即可登录，登录后昵称不再被打码。</p>
		<button class="primary" onclick={start} disabled={busy}>
			{busy ? '生成中…' : '生成二维码'}
		</button>
	{:else}
		<div class="qr" class:dim={failed}>
			{#if status.svg}
				<!-- 服务端渲染的 SVG；内容来自我方服务端，非用户输入 -->
				{@html status.svg}
			{/if}
		</div>

		<p class="state" class:ok={done} class:bad={failed}>
			{status.text}
			{#if status.status === 'pending' || status.status === 'scanned'}
				<span class="remain">（{Math.ceil((status.remainingMs ?? 0) / 1000)}s）</span>
			{/if}
		</p>

		{#if status.account}
			<p class="ok">已登录：{status.account.uname}（uid {status.account.uid}）</p>
		{/if}
		{#if status.error}
			<p class="bad">{status.error}</p>
		{/if}

		<div class="actions">
			{#if failed}
				<button class="primary" onclick={start}>刷新二维码</button>
			{/if}
			{#if !done}
				<button onclick={cancel}>取消</button>
			{/if}
			{#if done}
				<button class="primary" onclick={() => onClose?.()}>完成</button>
			{/if}
		</div>
	{/if}

	{#if error}
		<p class="bad">{error}</p>
	{/if}
</div>

<style>
	.panel {
		margin-top: 12px;
	}

	.hint {
		margin: 0 0 10px;
		line-height: 1.7;
		color: #8891ad;
	}

	button {
		height: 32px;
		padding: 0 12px;
		cursor: pointer;
		background: #1b2136;
		border: 2px solid var(--edge-dk);
		box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.1);
		color: #cfd4e6;
		font-family: inherit;
		font-size: 12.5px;
		white-space: nowrap;
	}

	button:hover:not(:disabled) {
		background: #252c47;
		color: #fff;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.primary {
		background: #2a3f6b;
		color: #fff;
	}

	.qr {
		display: flex;
		justify-content: center;
		padding: 10px;
		background: #e8ecff;
		border: 2px solid var(--edge-dk);
	}

	.qr :global(svg) {
		display: block;
		width: 100%;
		max-width: 260px;
		height: auto;
	}

	.qr.dim {
		opacity: 0.25;
	}

	.state {
		margin: 10px 0 0;
		text-align: center;
		color: #ffd479;
	}

	.remain {
		color: #8891ad;
	}

	.ok {
		margin: 8px 0 0;
		text-align: center;
		color: #7ee08a;
	}

	.bad {
		margin: 8px 0 0;
		color: #ff8080;
		line-height: 1.6;
	}

	.actions {
		display: flex;
		gap: 8px;
		justify-content: center;
		margin-top: 12px;
	}
</style>
