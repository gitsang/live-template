/**
 * 网页端扫码登录的会话状态机。
 *
 * ## 为什么必须加访问口令
 *
 * 二维码登录有一个容易被忽略的性质：**持有 `qrcode_key` 的人就能领走凭据**。
 * 轮询接口不校验任何身份（已实测：不带 cookie 也能轮询，返回 86101）。
 * 于是存在这样的攻击：
 *
 *   1. 攻击者打开你的登录页，服务端为他生成一个挑战 A
 *   2. 攻击者想让你去扫的却是**他自己**的码 —— 但他拿不到你的 A 的图？
 *      不，他能：他只要访问同一个接口，看到的就是服务端当前那个挑战。
 *
 * 也就是说，如果登录接口不设访问控制，任何人都能：
 *   - 抢占唯一的活动挑战（把操作者正在看的二维码换掉）
 *   - 从轮询响应里读出 `scanned` 状态，确认「有人扫了」
 *   - 而在成功那一刻，凭据会写到服务端文件 —— 这一步他偷不走。
 *
 * 但**真正的风险在反向**：攻击者可以自己开一个挑战，然后把那个二维码
 * 展示给操作者（钓鱼），操作者一扫，凭据就通过攻击者可控的挑战下发。
 * 所以关键不是「凭据会不会泄漏」，而是**不能允许未授权方开启挑战**。
 *
 * 结论：登录接口必须有访问口令，且口令只在服务端日志里出现一次。
 * HTTPS 解决的是「传输途中被人截获」，与上面的问题完全无关 ——
 * 攻击者走的是你自己的合法接口，流量全程加密也没有用。
 *
 * ## 并发
 *
 * 只保留一个活动挑战：同时存在多个既无使用场景，又会让
 * 「网页上显示的是哪个码」变得含糊，反而制造钓鱼空间。
 */
import {
	QR_STATUS_TEXT,
	generateQrChallenge,
	pollQrOnce,
	type QrStatus
} from './bili/qrlogin';
import { createLogger } from './logger';

const log = createLogger('login');

export interface LoginStatus {
	/** 二维码 SVG（仅在需要展示时返回，避免每次轮询都传一份大字符串） */
	svg?: string;
	status: QrStatus;
	/** 给人看的状态文案 */
	text: string;
	/** 成功后的账号信息 */
	account?: { uid: number; uname: string };
	/** 出错信息 */
	error?: string;
	/** 距过期还剩多少毫秒 */
	remainingMs: number;
}

/** 挑战有效期。B 站的码约 3 分钟失效，这里留一点余量提前放弃 */
const TTL_MS = 175_000;

/**
 * 轮询节流。
 *
 * 放在服务端而不是信任客户端：网页端只要有个刷新的 `setInterval`
 * 就能把 B 站的轮询接口打到限流，而前端代码是可以被绕过的。
 */
const MIN_POLL_INTERVAL_MS = 900;

export interface LoginSessionDeps {
	/** 生成二维码 SVG */
	renderSvg: (url: string) => string;
	/** 登录成功后的处理：写凭据文件并热重载采集会话 */
	onSuccess: (cookie: string) => Promise<{ uid: number; uname: string }>;
	/** 生成挑战（可注入，便于测试） */
	generate?: typeof generateQrChallenge;
	/** 轮询一次（可注入，以便测试节流而不打网络） */
	pollOnce?: typeof pollQrOnce;
	/** 供测试注入的时钟 */
	now?: () => number;
}

export class LoginSession {
	#challenge: { url: string; key: string } | null = null;
	#status: QrStatus = 'pending';
	#createdAt = 0;
	#lastPollAt = 0;
	/** 结算标记：一次登录流程只允许成功/失败一次 */
	#settled = false;
	#account: { uid: number; uname: string } | undefined;
	#error: string | undefined;

	readonly #deps: LoginSessionDeps;

	constructor(deps: LoginSessionDeps) {
		this.#deps = deps;
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	/** 是否有可用挑战（未结算且未过期） */
	get active(): boolean {
		return this.#challenge !== null && !this.#settled;
	}

	/**
	 * 开起一个新挑战（覆盖旧的）。
	 *
	 * 允许重复调用是有意的：二维码过期后操作者需要「刷新」。
	 */
	async start(): Promise<LoginStatus> {
		const now = this.#now();
		this.#challenge = await (this.#deps.generate ?? generateQrChallenge)();
		this.#status = 'pending';
		this.#createdAt = now;
		this.#lastPollAt = 0;
		this.#settled = false;
		this.#account = undefined;
		this.#error = undefined;
		log.info('已生成登录二维码，等待扫码');
		return this.#snapshot(true);
	}

	/** 取消当前流程（不删除已写入的凭据，那属于另一件事） */
	cancel(): LoginStatus {
		this.#challenge = null;
		this.#settled = false;
		this.#status = 'pending';
		this.#account = undefined;
		this.#error = undefined;
		return this.#snapshot(false);
	}

	/** 状态快照；`withSvg` 为真时附带二维码图 */
	#snapshot(withSvg: boolean): LoginStatus {
		const remainingMs = this.#challenge
			? Math.max(0, TTL_MS - (this.#now() - this.#createdAt))
			: 0;

		const out: LoginStatus = {
			status: this.#status,
			text: QR_STATUS_TEXT[this.#status],
			remainingMs
		};

		if (withSvg && this.#challenge) out.svg = this.#deps.renderSvg(this.#challenge.url);
		if (this.#account) out.account = this.#account;
		if (this.#error) out.error = this.#error;

		return out;
	}

	/**
	 * 推进一次轮询并返回最新状态。
	 *
	 * 轮询节流在这里做：距离上次不足 `MIN_POLL_INTERVAL_MS` 就直接回快照，
	 * 不打扰 B 站。
	 */
	async poll(withSvg = false): Promise<LoginStatus> {
		const challenge = this.#challenge;
		if (!challenge || this.#settled) return this.#snapshot(withSvg);

		const now = this.#now();

		/* 本地超时：不白等 B 站返回 86038 */
		if (now - this.#createdAt > TTL_MS) {
			this.#status = 'expired';
			this.#settled = true;
			log.info('二维码已过期（本地超时）');
			return this.#snapshot(withSvg);
		}

		if (now - this.#lastPollAt < MIN_POLL_INTERVAL_MS) return this.#snapshot(withSvg);
		this.#lastPollAt = now;

		try {
			const result = await (this.#deps.pollOnce ?? pollQrOnce)(challenge.key);
			this.#status = result.status;

			if (result.status === 'expired') {
				this.#settled = true;
				log.info('二维码已过期');
				return this.#snapshot(withSvg);
			}

			if (result.status === 'scanned') {
				log.info('已扫码，等待手机确认');
				return this.#snapshot(withSvg);
			}

			if (result.status === 'success') {
				/*
				 * 立即置 settled：成功路径只会走一次，
				 * 否则并发轮询会让 onSuccess 被重复调用（重复写文件、重复重连）。
				 */
				this.#settled = true;

				if (!result.cookie) {
					/*
					 * 轮询说成功却没拿到凭据：明确报错，不要静默降级成匿名 ——
					 * 使用者会以为登录成功了，之后才发现昵称还在打码。
					 */
					this.#status = 'unknown';
					this.#error = '登录成功但未获取到凭据（SESSDATA 缺失），请重试';
					log.warn(this.#error);
					return this.#snapshot(withSvg);
				}

				try {
					const account = await this.#deps.onSuccess(result.cookie);
					this.#account = account;
					log.info(`登录成功 uid=${account.uid} 昵称=${account.uname}`);
				} catch (err) {
					this.#error = `凭据保存失败：${(err as Error).message}`;
					log.error(this.#error);
				}
				return this.#snapshot(withSvg);
			}

			return this.#snapshot(withSvg);
		} catch (err) {
			/*
			 * 网络抖动不该终结整个流程：保留状态，等下一次轮询重试。
			 * 但要把错误透出去，否则界面上会一直停在「等待扫码」，
			 * 使用者无法区分「没人扫」和「网络挂了」。
			 */
			const message = (err as Error).message;
			log.warn(`轮询失败（将重试）: ${message}`);
			this.#error = message;
			return this.#snapshot(withSvg);
		}
	}
}
