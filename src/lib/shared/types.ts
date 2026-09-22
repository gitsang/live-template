/**
 * 前后端共用的弹幕事件类型：服务端产出 / 落盘 / 广播，客户端消费。
 *
 * 三类事件共有的字段：uid（B 站已对未登录观众隐藏，实测恒为 0）、
 * uh（user_hash，实测唯一能区分用户的标识）、u（昵称，可能被打码）、
 * lv（UL 等级）、guard（0 无 / 1 总督 / 2 提督 / 3 舰长）、medal（粉丝牌 [名称, 等级]）。
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
	uid: number;
	uh: string;
	u: string;
	/** 正文 */
	m: string;
	/** 正文颜色（十进制 RGB）。渲染统一用白色，原色仅落盘。 */
	color: number;
	lv: number;
	guard: number;
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
	uh: string;
	u: string;
	/** 礼物名 */
	g: string;
	/** 数量 */
	n: number;
	/** 总价值 */
	price: number;
	/** gold（金瓜子）/ silver（银瓜子） */
	coin: string;
	lv: number;
	guard: number;
	medal: [string, number] | null;
}

/**
 * 醒目留言（Super Chat）。三个 color* 都是面向 B 站浅色主题的浅色，直接当背景会与本
 * 项目的深色像素风冲突，因此渲染时只取其中较深的一个作强调色，背景仍用深色底。
 */
export interface SuperChatEvent extends Base {
	t: 'sc';
	uid: number;
	uh: string;
	u: string;
	/** 留言正文 */
	m: string;
	/** 金额（人民币元） */
	price: number;
	/** 持续时间（秒） */
	duration: number;
	lv: number;
	guard: number;
	medal: [string, number] | null;
	/** 以下四个都是 #RRGGBB */
	colorStart: string;
	colorEnd: string;
	colorBottom: string;
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

/* WebSocket 报文：服务端 → 客户端 */

/** 连接建立后第一个包 */
export interface HelloMessage {
	t: 'hello';
	/** 请求的房间号（原样回显，可能是短号） */
	room: string;
	/** 当前状态，避免新连接等待下一次变更 */
	latest: StatusEvent;
	/** 当天 JSONL 回显，旧 → 新 */
	echo: DanmakuItem[];
}

/** 弹幕推送 */
export type EventMessage = DanmakuItem;

export interface PingMessage {
	t: 'ping';
}

export type ServerMessage = HelloMessage | EventMessage | StatusEvent | PingMessage;

/* WebSocket 报文：客户端 → 服务端。手柄等前端状态不需要上报，服务端对手柄零感知 */

export interface SubscribeMessage {
	t: 'subscribe';
	/** 房间号，缺省则用连接时的房间 */
	room?: string;
	/** 最后收到的事件 id，服务端据此补发遗漏的事件 */
	since?: number;
}

export interface PongMessage {
	t: 'pong';
}

export type ClientMessage = SubscribeMessage | PongMessage;

/* 扫码登录 */

/**
 * 扫码状态。timeout 与 expired 是**两个不同状态**：expired 指 B 站判定二维码失效
 * （86038），timeout 指本地等待超时（通常仍是 86101 未扫码）。混为一谈会输出
 * 「二维码已过期（状态码 86101）」这种自相矛盾的提示。
 */
export type QrStatus = 'pending' | 'scanned' | 'success' | 'expired' | 'timeout' | 'unknown';

/** 登录接口响应 */
export interface LoginStatusResponse {
	ok: boolean;
	status: QrStatus;
	text: string;
	/** 仅在开起挑战时下发 */
	svg?: string;
	account?: { uid: number; uname: string };
	error?: string;
	remainingMs: number;
}
