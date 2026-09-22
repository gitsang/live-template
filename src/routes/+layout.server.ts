import { loadConfig, toViewOptions } from '$lib/server/config';
import { getHub } from '$lib/server/registry';
import type { LayoutServerLoad } from './$types';

interface HubLike {
	hasAuth: boolean;
}

/**
 * 把服务端配置作为视图默认值下发给所有页面。
 * URL 查询参数会在客户端覆盖这里的值（见 $lib/shared/view.ts）。
 *
 * `auth` 只暴露「是否已配置登录态」这一个布尔值，**绝不下发凭据本身** ——
 * 页面源码、浏览器缓存、OBS 的源配置都可能把它带走。
 * 用 hub.hasAuth 而不是 config.biliCookie：前者会被网页扫码成功后的
 * reloadAuth() 更新，后者是进程级缓存的，扫码后不会变。
 */
export const load: LayoutServerLoad = () => {
	const config = loadConfig();
	const hub = getHub<HubLike>();

	return {
		view: toViewOptions(config),
		/* hub 不可用（如构建期）时退回配置值 */
		auth: hub ? hub.hasAuth : Boolean(config.biliCookie),
		/* 网页登录是否开启：用于决定 HUD 是否显示登录入口 */
		loginEnabled: Boolean(config.loginToken)
	};
};
