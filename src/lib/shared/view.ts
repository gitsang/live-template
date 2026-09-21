/**
 * 客户端视图开关。
 *
 * 优先级：URL 查询参数 > 服务端注入的配置（config.json / 环境变量）> 内置默认值。
 * 服务端配置由 /api/config 提供，在页面挂载前通过 `data` 属性或 fetch 注入。
 */
import { browser } from '$app/environment';

export interface ViewOptions {
	/** 框体标题文字 */
	labels: boolean;
	/** 尺寸标注与四角括号 */
	guides: boolean;
	/** 画布与留白区整体透明 */
	transparent: boolean;
	/** 仅视频框内容区透明（让 OBS 下方的显示器采集透出） */
	hole: boolean;
	/** 调试控制条 */
	hud: boolean;
	/** 造弹幕 + 造手柄输入 */
	mock: boolean;
	/** B 站直播间号（URL 可覆盖） */
	room: string;
}

const DEFAULTS: ViewOptions = {
	labels: true,
	guides: false,
	transparent: false,
	hole: true,
	hud: false,
	mock: false,
	room: ''
};

/** 解析布尔型开关：`1`/`true`/`on`/`yes` 为真，`0`/`false`/`off`/`no` 为假，缺失返回 undefined */
export function parseBool(v: string | null | undefined): boolean | undefined {
	if (v == null || v === '') return undefined;
	const s = v.toLowerCase();
	if (['1', 'true', 'on', 'yes', 'transparent'].includes(s)) return true;
	if (['0', 'false', 'off', 'no', 'none', 'opaque'].includes(s)) return false;
	return undefined;
}

/**
 * 从 URL 与（服务端下发的）基础配置合并出最终视图开关。
 * `base` 通常来自 config，键名与 ViewOptions 一致。
 */
export function resolveViewOptions(search: string, base?: Partial<ViewOptions>): ViewOptions {
	const q = new URLSearchParams(search);

	/** URL 参数优先，其次服务端配置，最后内置默认值 */
	const pick = (key: string, fallback: boolean): boolean => {
		const fromUrl = parseBool(q.get(key));
		if (fromUrl !== undefined) return fromUrl;
		const fromBase = base?.[key as keyof ViewOptions];
		if (typeof fromBase === 'boolean') return fromBase;
		return fallback;
	};

	const merged: ViewOptions = {
		labels: pick('label', base?.labels ?? DEFAULTS.labels),
		guides: pick('guide', base?.guides ?? DEFAULTS.guides),
		transparent: pick('bg', base?.transparent ?? DEFAULTS.transparent),
		hole: pick('hole', base?.hole ?? DEFAULTS.hole),
		hud: pick('hud', base?.hud ?? DEFAULTS.hud),
		mock: pick('mock', base?.mock ?? DEFAULTS.mock),
		room: q.get('room')?.trim() || base?.room || DEFAULTS.room
	};

	return merged;
}

/** 把开关映射成 <html> 上的类名 */
export function viewClasses(o: ViewOptions): string[] {
	return [
		o.labels ? 'label-on' : 'label-off',
		o.guides ? 'guide-on' : '',
		o.transparent ? 'bg-transparent' : '',
		o.hole ? 'hole-on' : ''
	].filter(Boolean);
}

/** 应用开关到 <html>（客户端专用） */
export function applyViewOptions(o: ViewOptions): void {
	if (!browser) return;
	const root = document.documentElement;
	for (const c of ['label-on', 'label-off', 'guide-on', 'bg-transparent', 'hole-on']) {
		root.classList.remove(c);
	}
	root.classList.add(...viewClasses(o));
}
