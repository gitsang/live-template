/**
 * 二维码渲染（纯函数，无 Node 依赖）。
 *
 * ## 别把这当成安全边界
 *
 * 把二维码渲染成 SVG 而不是把 URL 交给前端，是个**实现选择**，
 * 不是安全措施：**二维码就是 `qrcode_key` 的图形编码**，两者等价。
 * 已实测：把本模块产出的 SVG 解码回来，即可还原出 key 并拿去独立轮询。
 *
 * 所以「只暴露图、不暴露 key」提供不了任何保护。真正保护凭据的是
 * 那个访问口令（见 server/login.ts 顶部注释）。
 *
 * 选择服务端渲染的实际理由是：
 *   - 前端不需要引入二维码依赖
 *   - 排版与配色完全由服务端控制，风格统一
 *   - 将来若真要换成不编码 key 的方案（如服务端代理轮询），改一处即可
 *
 * 放在 shared 下是因为它不依赖 Node，既能被服务端调用，也方便单测。
 */
import qrcode from 'qrcode-generator';

export interface QrRenderOptions {
	/** 每个模块的像素边长 */
	cell?: number;
	/** 静默区宽度（模块数）。规范要求至少 4，低于此值扫码率会明显下降 */
	margin?: number;
	/** 深色模块颜色 */
	dark?: string;
	/** 浅色底色 */
	light?: string;
}

/** 静默区最小宽度：二维码规范要求 4 个模块，少了会影响识别 */
export const QR_MIN_MARGIN = 4;

/** 生成模块矩阵；`isDark(r, c)` 为真表示该点需要着色 */
export interface QrMatrix {
	/** 边长（模块数），总是奇数 */
	count: number;
	isDark(row: number, col: number): boolean;
}

export function qrMatrix(text: string, errorCorrection: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
	if (!text) throw new Error('二维码内容不能为空');

	/* 0 = 自动选择版本号（按内容长度取最小可用版本） */
	const qr = qrcode(0, errorCorrection);
	qr.addData(text);
	qr.make();

	return {
		count: qr.getModuleCount(),
		isDark: (row, col) => qr.isDark(row, col)
	};
}

/**
 * XML 转义。
 *
 * 颜色值来自配置，理论上可能被写成 `"/><script>…` 这种形态；
 * 直接拼进 SVG 属性就是一个注入点。SVG 会被当作图片渲染，
 * 但仍应转义 —— 防御不该依赖「调用方不会传坏值」这种假设。
 */
function esc(v: string): string {
	return v
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 把文本渲染成 SVG 字符串。
 *
 * 自己拼 SVG 而不是用库的 `createSvgTag`，是为了控制配色 ——
 * 模板是像素风，二维码需要跟着走深色底 + 亮色模块，
 * 而库的默认输出是硬编码的黑白。
 *
 * 用单个 `<path>` 承载所有深色模块，而不是每格一个 `<rect>`：
 * 45×45 的码有近千个深色块，逐个 rect 会让 SVG 体积翻数倍。
 */
export function qrSvg(text: string, options: QrRenderOptions = {}): string {
	/* 静默区不足会被扫码器裁掉定位图案，这里做下限保护而不是相信调用方 */
	const margin = Math.max(QR_MIN_MARGIN, options.margin ?? QR_MIN_MARGIN);
	const cell = Math.max(1, options.cell ?? 8);
	const dark = options.dark ?? '#0e111d';
	const light = options.light ?? '#e8ecff';

	const matrix = qrMatrix(text);
	const n = matrix.count;
	const size = (n + margin * 2) * cell;

	let path = '';
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (!matrix.isDark(r, c)) continue;
			const x = (c + margin) * cell;
			const y = (r + margin) * cell;
			/* 相邻方块共享边框，视觉上自然连成整片 */
			path += `M${x} ${y}h${cell}v${cell}h-${cell}z`;
		}
	}

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
		`width="${size}" height="${size}" shape-rendering="crispEdges" role="img" ` +
		`aria-label="登录二维码">` +
		`<rect width="${size}" height="${size}" fill="${esc(light)}"/>` +
		`<path d="${path}" fill="${esc(dark)}"/>` +
		`</svg>`
	);
}
