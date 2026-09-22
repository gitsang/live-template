#!/usr/bin/env tsx
/**
 * 扫码登录 B 站，把凭据写进本地文件。
 *
 *   npm run login                    # 写到默认路径 ./secrets/bili-cookie.txt
 *   npm run login -- --out /tmp/ck   # 指定输出路径
 *   npm run login -- --print         # 顺带把 Cookie 打到标准输出（谨慎）
 *
 * 做成扫码而非手抄：手抄既容易抄漏字段（少了 DedeUserID 就无法解析 uid），
 * 又容易在粘贴时把 SESSDATA 泄漏到聊天记录或工单里。
 * 成功后立刻用 nav 校验并打印昵称，使「是否真的登录上了」当场可见。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import qrcode from 'qrcode-terminal';

import { getNavInfo } from '../src/lib/server/bili/api.ts';
import { writeCookieFile } from '../src/lib/server/credential.ts';
import { redactCookie, userIdFromCookie } from '../src/lib/server/bili/session.ts';
import {
	QR_STATUS_TEXT,
	generateQrChallenge,
	waitForQrLogin,
	type QrStatus
} from '../src/lib/server/bili/qrlogin.ts';

const DEFAULT_OUT = 'secrets/bili-cookie.txt';

function parseArgs(argv: string[]): { out: string; print: boolean; timeoutMs: number } {
	let out = DEFAULT_OUT;
	let print = false;
	let timeoutMs = 180_000;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--out' || a === '-o') {
			out = argv[++i] ?? out;
		} else if (a === '--print') {
			print = true;
		} else if (a === '--timeout') {
			timeoutMs = Number(argv[++i]) * 1000 || timeoutMs;
		} else if (a === '--help' || a === '-h') {
			console.log(`用法: npm run login [-- --out <路径>] [--print] [--timeout <秒>]`);
			process.exit(0);
		}
	}
	return { out, print, timeoutMs };
}

/** 终端彩色输出；非 TTY（被重定向）时自动降级为无色，避免日志里出现转义序列 */
const useColor = process.stdout.isTTY === true;
const c = {
	dim: (s: string) => (useColor ? `\u001b[2m${s}\u001b[0m` : s),
	bold: (s: string) => (useColor ? `\u001b[1m${s}\u001b[0m` : s),
	green: (s: string) => (useColor ? `\u001b[32m${s}\u001b[0m` : s),
	yellow: (s: string) => (useColor ? `\u001b[33m${s}\u001b[0m` : s),
	red: (s: string) => (useColor ? `\u001b[31m${s}\u001b[0m` : s)
};

async function main(): Promise<number> {
	const { out, print, timeoutMs } = parseArgs(process.argv.slice(2));
	const outPath = resolve(out);

	console.log(c.bold('\nB 站扫码登录'));
	console.log(c.dim('─'.repeat(46)));

	const challenge = await generateQrChallenge();

	/*
	 * small: true 用半高字符块，二维码在终端里只占一半行数，
	 * 手机上更容易一次扫中（行数太多时截图会糊）。
	 */
	qrcode.generate(challenge.url, { small: true }, (qr: string) => {
		console.log(qr);
	});

	console.log(`用 ${c.bold('B 站手机 App')} 扫描上面的二维码`);
	console.log(c.dim(`二维码地址: ${challenge.url}`));
	console.log(c.dim('（无法扫码时，可把上面这行地址发到手机上打开）\n'));

	let lastShown: QrStatus | null = null;
	const result = await waitForQrLogin(challenge.key, {
		timeoutMs,
		onStatus: (status) => {
			if (status === lastShown) return;
			lastShown = status;
			const text = QR_STATUS_TEXT[status];
			if (status === 'scanned') console.log(c.yellow(`  · ${text}`));
			else if (status === 'expired' || status === 'timeout') console.log(c.red(`  · ${text}`));
			else if (status === 'success') console.log(c.green(`  · ${text}`));
			else console.log(c.dim(`  · ${text}`));
		}
	});

	if (result.status !== 'success' || !result.cookie) {
		console.error(
			c.red(
				`\n登录未完成：${QR_STATUS_TEXT[result.status]}` +
					(result.rawCode !== undefined ? `（状态码 ${result.rawCode}）` : '')
			)
		);
		console.error(c.dim('请重新运行 npm run login 再试一次。'));
		return 1;
	}

	/* 立刻校验：能拿到昵称才算真的登录上了 */
	let accountLine = '（nav 校验未通过，Cookie 可能未生效）';
	let verified = false;
	try {
		const nav = await getNavInfo(result.cookie);
		if (nav.isLogin) {
			verified = true;
			accountLine = `${nav.uname}（uid ${nav.uid}）`;
		}
	} catch (err) {
		accountLine = `（校验请求失败：${(err as Error).message}）`;
	}

	const uid = userIdFromCookie(result.cookie);
	if (uid === 0) {
		console.error(
			c.red(
				'\n拿到的 Cookie 里没有可用的 DedeUserID，' +
					'无法在认证包里表达登录身份。请重试或改用手动方式配置。'
			)
		);
		return 1;
	}

	/*
	 * 写入。只有在「真的拿到凭据」之后才创建目录 ——
	 * 失败路径下留一个空的 secrets/ 会让人误以为已经配置过。
	 * 权限与去重逻辑统一走 writeCookieFile（与配置读取共用一份实现）。
	 */
	const existed = existsSync(outPath);
	writeCookieFile(outPath, result.cookie);

	console.log('');
	console.log(c.green(`✓ 凭据已写入 ${outPath}`) + (existed ? c.dim('（已覆盖）') : ''));
	console.log(`  账号：${verified ? c.green(accountLine) : c.yellow(accountLine)}`);
	/* 只打印脱敏摘要，绝不打印原值 */
	console.log(c.dim(`  内容：${redactCookie(result.cookie)}`));
	console.log(c.dim(`  权限：600（仅本人可读写）`));

	if (print) {
		console.log('');
		console.log(c.yellow('⚠ 即将输出完整 Cookie，注意不要留在终端回滚缓冲或日志里：'));
		console.log(result.cookie);
	}

	console.log('');
	console.log('接下来在 .env 里设置：');
	console.log(c.bold(`  BILI_COOKIE_FILE=${out}`));
	console.log(c.dim('  （容器部署时 compose.yml 会把 ./secrets 只读挂进 /run/secrets）'));
	console.log('');

	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((err: unknown) => {
		console.error(c.red(`\n出错：${(err as Error).message}`));
		process.exit(1);
	});
