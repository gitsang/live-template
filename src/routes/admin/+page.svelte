<script lang="ts">
	/**
	 * 管理页 /admin。
	 *
	 * 为什么独立成页而不是放在 OBS 画布的 HUD 上：**二维码绝不能出现在直播画面里**。
	 * HUD 默认关闭且只在鼠标移动时出现（OBS 不派发鼠标事件），但那是「依赖 OBS 行为」
	 * 的间接保证；独立页面才是结构性保证 —— 画布上根本没有这个东西。
	 * 管理动作本身也不该跟画面渲染耦合。
	 *
	 * 本页不参与画布缩放：全局样式里 body 是 overflow: hidden，这里自己开滚动容器。
	 */
	import LoginPanel from '$lib/components/LoginPanel.svelte';

	let { data } = $props();

	const authorized = $derived(Boolean(data.authorized));
	const enabled = $derived(Boolean(data.enabled));
	const bili = $derived(data.bili as { loggedIn: boolean; cookiePath: string; rooms: number } | null);

	/** 登入表单 */
	let token = $state('');
	let busy = $state(false);
	let error = $state('');

	async function signIn(): Promise<void> {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/admin/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token })
			});
			const body = (await res.json()) as { ok: boolean; error?: string };
			if (!res.ok || !body.ok) {
				error = body.error ?? `登入失败（HTTP ${res.status}）`;
				return;
			}
			/*
			 * 口令已换成 Cookie，立刻从内存里清掉，不留在页面状态里。
			 * 随后整页重载，让服务端重新判定授权状态。
			 */
			token = '';
			location.reload();
		} catch (err) {
			error = `请求失败：${(err as Error).message}`;
		} finally {
			busy = false;
		}
	}

	async function signOut(): Promise<void> {
		await fetch('/api/admin/logout', { method: 'POST' });
		location.reload();
	}
</script>

<svelte:head>
	<title>管理 · live-template</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="admin">
	<h1>live-template 管理</h1>

	{#if !enabled}
		<div class="card">
			<p class="warn">
				网页登录未开启。设置环境变量 <code>LOGIN_TOKEN</code> 后重启服务即可启用本页。
			</p>
			<p class="hint">
				不启用也没关系：可以在终端执行 <code>npm run login</code> 扫码登录 B 站
				（Docker 部署见 compose.yml 末尾的说明）。
			</p>
		</div>
	{:else if !authorized}
		<div class="card">
			<h2>需要访问口令</h2>
			<p class="hint">
				口令在服务启动日志里（形如
				<code>[live-template] 网页登录已开启 … 访问口令: xxxxxxxx</code>）。
			</p>
			<div class="row">
				<input
					type="password"
					placeholder="访问口令"
					bind:value={token}
					onkeydown={(e) => e.key === 'Enter' && signIn()}
				/>
				<button class="primary" onclick={signIn} disabled={busy || !token}>
					{busy ? '验证中…' : '进入'}
				</button>
			</div>
			{#if data.reason}
				<p class="muted">（{data.reason}）</p>
			{/if}
			{#if error}
				<p class="bad">{error}</p>
			{/if}
		</div>
	{:else}
		<div class="card">
			<div class="head">
				<h2>B 站登录</h2>
				<button onclick={signOut}>退出管理页</button>
			</div>

			{#if bili?.loggedIn}
				<p class="ok">已配置 B 站登录态，昵称不会被打码。</p>
			{:else}
				<p class="hint">当前为匿名连接，B 站会把部分昵称打码成「赛***」。</p>
			{/if}

			<p class="hint">
				凭据文件：<code>{bili?.cookiePath ?? ''}</code>
			</p>

			<LoginPanel onClose={() => location.reload()} />
		</div>
	{/if}
</div>

<style>
	.admin {
		/* 全局 body 是 overflow:hidden（给画布用的），这里自己开滚动 */
		position: fixed;
		inset: 0;
		overflow: auto;
		padding: 28px 18px 60px;
		background: var(--page);
		color: #cfd4e6;
		font-size: 13px;
	}

	h1 {
		max-width: 560px;
		margin: 0 auto 16px;
		font-size: 16px;
		color: #fff;
	}

	h2 {
		font-size: 13.5px;
		color: #fff;
		margin: 0;
	}

	.card {
		max-width: 560px;
		margin: 0 auto 16px;
		padding: 14px;
		background: rgba(14, 17, 29, 0.95);
		border: 2px solid var(--edge-dk);
		box-shadow:
			0 0 0 2px rgba(255, 255, 255, 0.12),
			8px 8px 0 rgba(0, 0, 0, 0.55);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}

	.row {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}

	input {
		flex: 1;
		min-width: 0;
		height: 32px;
		padding: 0 8px;
		background: #1b2136;
		border: 2px solid var(--edge-dk);
		box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.1);
		color: #fff;
		font-family: inherit;
		font-size: 13px;
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

	.hint {
		margin: 8px 0 0;
		line-height: 1.7;
		color: #8891ad;
	}

	.muted {
		margin: 8px 0 0;
		color: #667090;
		font-size: 12px;
	}

	code {
		color: #ffd479;
		word-break: break-all;
	}

	.ok {
		margin: 4px 0 0;
		color: #7ee08a;
	}

	.bad,
	.warn {
		margin: 8px 0 0;
		color: #ff8080;
		line-height: 1.7;
	}
</style>
