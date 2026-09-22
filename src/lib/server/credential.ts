/**
 * 登录凭据的落盘与读取，由配置加载、扫码 CLI、网页登录接口共用。
 * 写入路径必须与读取路径一致，否则会出现「扫码成功了但服务还是匿名」这种难查现象。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { createLogger } from './logger';

const log = createLogger('credential');

/** 默认落盘路径（与 compose.yml 的挂载点一致） */
export const DEFAULT_COOKIE_FILE = 'secrets/bili-cookie.txt';

/**
 * 写入凭据文件，权限固定 600（同机其他用户不应读到 SESSDATA）。
 *
 * writeFileSync 的 mode **只在新建文件时生效**，故已存在的文件必须再 chmodSync 一次 ——
 * 否则反复登录时权限会一直停留在上一次的宽松设置。
 */
export function writeCookieFile(path: string, cookie: string): string {
	const abs = resolve(path);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, `${cookie.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
	try {
		chmodSync(abs, 0o600);
	} catch (err) {
		/* 某些文件系统（如挂载进来的只读卷）不支持 chmod，不应因此失败 */
		log.warn(`设置 ${abs} 权限失败（不影响登录）: ${(err as Error).message}`);
	}
	return abs;
}

/**
 * 读取凭据文件。浏览器复制出来的 Cookie 常带换行，统一压成一行 ——
 * 否则拼进 HTTP 头会形成非法请求，日志里也会断行。读取失败返回空串（降级为匿名）。
 */
export function readCookieFile(path: string): string {
	const abs = resolve(path);
	try {
		if (!existsSync(abs)) return '';
		return readFileSync(abs, 'utf8').trim().replace(/\s*\r?\n\s*/g, ' ');
	} catch (err) {
		log.warn(`读取 ${abs} 失败: ${(err as Error).message}`);
		return '';
	}
}

/**
 * 请求令牌比较（恒定时间）。用 timingSafeEqual 而不是 ===：后者在第一个不同字符处
 * 提前返回，攻击者能靠响应耗时逐字节猜出令牌。
 *
 * 长度不同时直接返回 false —— timingSafeEqual 对不等长入参会抛错，且长度本身不是秘密。
 */
export function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	if (bufA.length !== bufB.length) return false;
	if (bufA.length === 0) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * 生成一次性启动令牌。
 *
 * 用 randomBytes 而不是 Math.random()：后者可预测，而这个字符串就是访问接口的凭证。
 * 去掉容易看错的字符（0/O、1/l/I），因为它要被人工从终端抄进网页。
 */
export function generateToken(bytes = 6): string {
	const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
	const raw = randomBytes(bytes * 2);
	let out = '';
	for (let i = 0; i < bytes; i++) {
		/* 取模会有极轻微的偏置，这里对「抄写用的一次性令牌」完全可接受 */
		out += alphabet[raw[i]! % alphabet.length];
	}
	return out;
}

/** 文件是否为「仅所有者可读写」（用于安全提示，不阻断运行） */
export function isRestrictive(path: string): boolean {
	try {
		/* 只看 group/other 位，忽略 rwx 差异 */
		return (statSync(resolve(path)).mode & 0o077) === 0;
	} catch {
		return false;
	}
}
