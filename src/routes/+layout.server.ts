import { loadConfig, toViewOptions } from '$lib/server/config';
import type { LayoutServerLoad } from './$types';

/**
 * 把服务端配置作为视图默认值下发给所有页面。
 * URL 查询参数会在客户端覆盖这里的值（见 $lib/shared/view.ts）。
 */
export const load: LayoutServerLoad = () => {
	const config = loadConfig();
	return { view: toViewOptions(config) };
};
