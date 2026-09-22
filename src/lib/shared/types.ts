/**
 * 前后端共用的弹幕事件类型：服务端产出 / 落盘 / 广播，客户端消费。
 */

/** 事件基类：id 由事件总线统一分配，用于断线补发 */
interface Base {
	/** 全局自增事件 id */
	id: number;
	/** 毫秒时间戳 */
	ts: number;
}

/** 弹幕 */
export interface DanmakuEvent extends Base {
	t: 'danmaku';
	/** 发送者 uid。B 站现已对未登录观众隐藏，实测恒为 0。 */
	uid: number;
	/**
	 * 发送者稳定标识（B 站下发的 user_hash）。
	 * uid 恒为 0、昵称可能被打码，只有它能区分用户，故用户名着色以它为首选种子。
	 */
	uh: string;
	/** 发送者昵称，未登录时可能被打码 */
	u: string;
	/** 正文 */
	m: string;
	/** B 站下发的正文颜色（十进制 RGB）。渲染统一用白色，原色仅落盘。 */
	color: number;
	/** 用户等级 UL */
	lv: number;
	/** 舰长等级：0 无 / 1 总督 / 2 提督 / 3 舰长 */
	guard: number;
	/** 粉丝牌 [名称, 等级] */
	medal: [string, number] | null;
	/** 大会员 */
	vip: boolean;
	/** 房管 */
	admin: boolean;
}

/** 礼物 */
export interface GiftEvent extends Base {
	t: 'gift';
	uid: number;
	/** 见 DanmakuEvent.uh 的说明 */
	uh: string;
	u: string;
	/** 礼物名 */
	g: string;
	/** 数量 */
	n: number;
	/** 总价值（金瓜子） */
	price: number;
	/** 货币类型 gold（金瓜子）/ silver（银瓜子） */
	coin: string;
	/** 用户等级 UL */
	lv: number;
	/** 舰长等级：0 无 / 1 总督 / 2 提督 / 3 舰长 */
	guard: number;
	/** 粉丝牌 [名称, 等级] */
	medal: [string, number] | null;
}

/**
 * 醒目留言（Super Chat）。
 *
 * colorStart/colorEnd/colorBottom 都是面向 B 站浅色主题的浅色，直接当背景会与本项目
 * 的深色像素风冲突，因此渲染时只取其中较深的一个作强调色，背景仍用深色底。
 */
export interface SuperChatEvent extends Base {
	t: 'sc';
	uid: number;
	/** 见 DanmakuEvent.uh 的说明 */
	uh: string;
	u: string;
	/** 留言正文 */
	m: string;
	/** 金额（人民币元） */
	price: number;
	/** 持续时间（秒） */
	duration: number;
	/** 用户等级 UL */
	lv: number;
	/** 舰长等级：0 无 / 1 总督 / 2 提督 / 3 舰长 */
	guard: number;
	/** 粉丝牌 [名称, 等级] */
	medal: [string, number] | null;
	/** 渐变起始色（#RRGGBB） */
	colorStart: string;
	/** 渐变结束色（#RRGGBB） */
	colorEnd: string;
	/** 底栏色（#RRGGBB） */
	colorBottom: string;
	/** 正文字体色（#RRGGBB） */
	fontColor: string;
}

export type DanmakuItem = DanmakuEvent | GiftEvent | SuperChatEvent;

/** 聊天框可渲染的条目类型 */
export type DanmakuKind = DanmakuItem['t'];

/** 从联合类型里按 t 取出具体成员 */
export type ItemOf<T extends DanmakuKind> = Extract<DanmakuItem, { t: T }>;

/**
 * 尚未分配事件 id 的条目。
 *
 * 必须写成两个 Omit 的联合而不是 Omit<DanmakuItem, 'id'>：后者作用在联合类型上会
 * 坍缩成各成员的**公共键**，弹幕独有的 m/lv 等会被丢掉，publish() 会拒绝正确输入。
 */
export type DanmakuInput =
	| Omit<DanmakuEvent, 'id'>
	| Omit<GiftEvent, 'id'>
	| Omit<SuperChatEvent, 'id'>;

/** 房间连接状态 */
export type RoomState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** 状态事件（不入环形历史补发队列之外，另单独保存最新一条） */
export interface StatusEvent {
	t: 'status';
	s: RoomState;
	/** 真实房间号（短号解析后） */
	room?: number;
	/** 开播状态：0 未开播 / 1 直播中 / 2 轮播 */
	live?: number;
	/** 当前使用的弹幕服务器 */
	host?: string;
	/** 错误信息 */
	msg?: string;
}

/* ---------------- WebSocket 报文（服务端 → 客户端） ---------------- */

/** 连接建立后第一个包 */
export interface HelloMessage {
	t: 'hello';
	/** 请求的房间号（原样回显，可能是短号） */
	room: string;
	/** 当前状态，避免新连接等待下一次变更 */
	latest: StatusEvent;
	/** 从当天 JSONL 读出的回显条目（含弹幕/礼物/SC），旧 → 新 */
	echo: DanmakuItem[];
}

/** 弹幕推送 */
export type EventMessage = DanmakuItem;

/** 心跳 */
export interface PingMessage {
	t: 'ping';
}

export type ServerMessage = HelloMessage | EventMessage | StatusEvent | PingMessage;

/* ---------------- WebSocket 报文（客户端 → 服务端） ---------------- */

export interface SubscribeMessage {
	t: 'subscribe';
	/** 房间号，缺省则用连接时的房间 */
	room?: string;
	/** 最后收到的事件 id，服务端据此补发断线期间遗漏的事件 */
	since?: number;
}

export interface PongMessage {
	t: 'pong';
}

/** 手柄等前端状态不需要上报，服务端对手柄零感知 */
export type ClientMessage = SubscribeMessage | PongMessage;

/* ---------------- 扫码登录（服务端 → 客户端） ---------------- */

/**
 * 扫码状态。放在 shared 而非服务端模块：它是 HTTP 接口的契约，前端组件要引用。
 *
 * timeout 与 expired 是**两个不同状态**：expired 指 B 站判定二维码失效（86038），
 * timeout 指本地等待超时（通常仍是 86101 未扫码）。混为一谈会输出
 * 「二维码已过期（状态码 86101）」这种自相矛盾的提示。
 */
export type QrStatus = 'pending' | 'scanned' | 'success' | 'expired' | 'timeout' | 'unknown';

/** 登录接口响应 */
export interface LoginStatusResponse {
	ok: boolean;
	status: QrStatus;
	text: string;
	/** 二维码 SVG（仅在开起挑战时下发） */
	svg?: string;
	account?: { uid: number; uname: string };
	error?: string;
	remainingMs: number;
}
