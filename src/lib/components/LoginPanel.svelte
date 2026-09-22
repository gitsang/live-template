<script lang="ts">
	/**
	 * 扫码登录面板。
	 *
	 * 设计约束：
	 * - 二维码由**服务端**渲染成 SVG 下发（注意：这只是实现选择，
	 *   图本身就等同于 key，安全边界是访问口令，不是「不下发 key」）
	 * - 访问口令只存在内存 + sessionStorage，绝不用 localStorage（跨会话残留更危险）
	 * - 面板关闭即停止轮询，避免在后台空转打扰 B 站接口
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
		onClose: () => void;
	}

	let { onClose }: Props = $props();

	const TOKEN_KEY = 'live-template.login-token';

	/* 口令：sessionStorage 而非 localStorage —— 关掉标签页即失效 */
	let token = $state(sessionStorage.getItem(TOKEN_KEY) ?? '');
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
		const res = await fetch(path, {
			...init,
			headers: { ...(init.headers ?? {}), 'x-login-token': token }
		});
		const body = (await res.json()) as { ok: boolean; error?: string } & Partial<Status>;
		if (!res.ok || !body.ok) {
			error = body.error ?? `请求失败（HTTP ${res.status}）`;
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

			/* 口令正确才记住，避免把打错的串留在会话里 */
			sessionStorage.setItem(TOKEN_KEY, token);
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
		if (!s) {
			/* 口令错或被拒就停掉，别无限重试 */
			stopPolling();
			return;
		}
		/*
		 * 保留上一份 SVG。
		 * 轮询接口**不会**回传二维码图（每 2s 传几十 KB 纯属浪费，而且码本身不变），
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

<div class="mask" onclick={onClose} role="presentation"></div>

<div class="dialog" role="dialog" aria-label="扫码登录">
	<header>
		<span>扫码登录</span>
		<button class="x" onclick={onClose} aria-label="关闭">✕</button>
	</header>

	{#if !status}
		<p class="hint">
			用 B 站 App 扫码即可登录，昵称将不再被打码。<br />
			需要访问口令（服务端启动日志里的 <code>LOGIN_TOKEN</code>）。
		</p>
		<div class="row">
			<input
				type="password"
				placeholder="访问口令"
				bind:value={token}
				onkeydown={(e) => e.key === 'Enter' && start()}
			/>
			<button class="primary" onclick={start} disabled={busy || !token}>
				{busy ? '生成中…' : '生成二维码'}
			</button>
		</div>
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
				<button class="primary" onclick={onClose}>完成</button>
			{/if}
		</div>
	{/if}

	{#if error}
		<p class="bad">{error}</p>
	{/if}
</div>

<style>
	.mask {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		z-index: 100;
	}

	.dialog {
		position: fixed;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: 340px;
		padding: 14px;
		background: rgba(14, 17, 29, 0.98);
		border: 2px solid var(--edge-dk);
		box-shadow:
			0 0 0 2px rgba(255, 255, 255, 0.12),
			8px 8px 0 rgba(0, 0, 0, 0.55);
		z-index: 101;
		color: #cfd4e6;
		font-size: 12.5px;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
		font-size: 13px;
		color: #fff;
	}

	.x {
		background: none;
		border: none;
		color: #8891ad;
		cursor: pointer;
		font-size: 14px;
		padding: 2px 6px;
	}

	.x:hover {
		color: #fff;
	}

	.hint {
		margin: 0 0 12px;
		line-height: 1.65;
		color: #8891ad;
	}

	code {
		color: #ffd479;
	}

	.row {
		display: flex;
		gap: 8px;
	}

	input {
		flex: 1;
		min-width: 0;
		height: 30px;
		padding: 0 8px;
		background: #1b2136;
		border: 2px solid var(--edge-dk);
		box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.1);
		color: #fff;
		font-family: inherit;
		font-size: 12.5px;
	}

	button {
		height: 30px;
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
		padding: 8px;
		background: #e8ecff;
		border: 2px solid var(--edge-dk);
	}

	.qr :global(svg) {
		display: block;
		width: 100%;
		max-width: 232px;
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
		text-align: center;
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
