import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { danmakuDevPlugin } from './tools/vite-plugin-danmaku.ts';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Node adapter: needs a real Node process because the danmaku hub
			// keeps long-lived WebSocket connections and appends to JSONL files.
			adapter: adapter({ out: 'build' })
		}),

		/* dev 环境把 /ws 挂到 Vite 的 http server 上 */
		danmakuDevPlugin()
	]
});
