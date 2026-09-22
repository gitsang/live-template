/**
 * 二维码渲染（纯函数，无 Node 依赖）。
 *
 * **别把这当成安全边界**：二维码就是 qrcode_key 的图形编码，两者等价 ——
 * 实测把本模块产出的 SVG 解码回来即可还原 key 并独立轮询，
 * 所以「只暴露图、不暴露 key」提供不了任何保护。真正保护凭据的是访问口令
 * （见 server/login.ts）。服务端渲染的实际理由是前端不必引入二维码依赖、
 * 配色由服务端统一控制，以及将来换成不编码 key 的方案只需改一处。
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
 * XML 转义。颜色值来自配置，理论上可能被写成 `"/><script>…` 这种形态，
 * 直接拼进 SVG 属性就是注入点。SVG 会当图片渲染，但仍应转义 ——
 * 防御不该依赖「调用方不会传坏值」这种假设。
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
 * 自己拼而不库的 createSvgTag 是为了控制配色（像素风需要深色底 + 亮色模块，
 * 库默认硬编码黑白）。用单个 <path> 而非每格一个 <rect>：45×45 的码有近千个
 * 深色块，逐个 rect 会让体积翻数倍。
 */
export function qrSvg(text: string, options: QrRenderOptions = {}): string {
	/* 静默区不足会被扫码器裁掉定位图案 */
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
