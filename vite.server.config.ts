/**
 * 弹幕服务端的独立构建配置。
 *
 * 产物：build/danmaku/index.js（ESM，供 server.mjs import）
 * ws 一并打包，容器里只需生产依赖即可运行。
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
			entry: fileURLToPath(new URL('./src/lib/server/entry.ts', import.meta.url)),
			formats: ['es'],
			fileName: () => 'entry.js'
		},
		rollupOptions: {
			/* 只保留 Node 内置模块为外部依赖，ws 打包进来 */
			external: [/^node:/]
		}
	}
});
