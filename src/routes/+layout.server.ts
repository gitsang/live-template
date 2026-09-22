import { loadConfig, toViewOptions } from '$lib/server/config';
import { getHub } from '$lib/server/registry';
import type { LayoutServerLoad } from './$types';

interface HubLike {
	hasAuth: boolean;
}

/**
 * 把服务端配置作为视图默认值下发给所有页面，客户端 URL 查询参数会覆盖它。
 *
 * auth 只暴露「是否已配置登录态」这一个布尔值，**绝不下发凭据本身** ——
 * 页面源码、浏览器缓存、OBS 的源配置都可能把它带走。
 * 用 hub.hasAuth 而非 config.biliCookie：前者会被 reloadAuth() 更新，后者是进程级缓存的。
 */
export const load: LayoutServerLoad = () => {
	const config = loadConfig();
	const hub = getHub<HubLike>();

	return {
		view: toViewOptions(config),
		/* hub 不可用（如构建期）时退回配置值；HUD 据此把管理入口标成「已登录」 */
		auth: hub ? hub.hasAuth : Boolean(config.biliCookie)
	};
};
