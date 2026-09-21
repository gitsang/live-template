/**
 * 极简日志。级别可通过 LOG_LEVEL 控制，输出到 stdout/stderr。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: Level = (process.env.LOG_LEVEL as Level) || 'info';

export function setLogLevel(level: string): void {
	if (level in ORDER) current = level as Level;
}

function stamp(): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level: Level, scope: string, args: unknown[]): void {
	if (ORDER[level] < ORDER[current]) return;
	const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${scope}`;
	const sink = level === 'error' || level === 'warn' ? console.error : console.log;
	sink(line, ...args);
}

export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

/** 建一个带作用域前缀的 logger，例如 createLogger('bili') */
export function createLogger(scope: string): Logger {
	return {
		debug: (...a) => emit('debug', scope, a),
		info: (...a) => emit('info', scope, a),
		warn: (...a) => emit('warn', scope, a),
		error: (...a) => emit('error', scope, a)
	};
}
