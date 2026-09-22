/**
 * 服务端侧的独立构建配置。产物都输出到 build/danmaku/：
 * - entry.js 供 server.mjs import（HTTP + /ws 挂载）
 * - login.js 扫码登录 CLI
 *
 * CLI 也要打包：生产镜像执行了 `npm prune --omit=dev`，而运行 TS 需要 tsx（devDependency），
 * 不打包则容器里必然失败 —— 恰恰是容器部署时最需要扫码登录的场景。
 * ws 与 qrcode-terminal 一并打包，容器里无需额外依赖。
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const libDir = fileURLToPath(new URL('./src/lib', import.meta.url));

export default defineConfig({
	/* SvelteKit 的 $lib 别名在这里需要手动补上 */
	resolve: {
		alias: { $lib: libDir }
	},
	build: {
		outDir: 'build/danmaku',
		emptyOutDir: true,
		/* 服务端代码不做浏览器兼容转换 */
		target: 'node22',
		minify: false,
		sourcemap: true,
		ssr: true,
		lib: {
			entry: {
				entry: fileURLToPath(new URL('./src/lib/server/entry.ts', import.meta.url)),
				login: fileURLToPath(new URL('./scripts/bili-login.ts', import.meta.url))
			},
			formats: ['es'],
			fileName: (_format, entryName) => `${entryName}.js`
		},
		rollupOptions: {
			/* 只保留 Node 内置模块为外部依赖，ws 打包进来 */
			external: [/^node:/]
		}
	}
});
