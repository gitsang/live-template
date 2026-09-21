/**
 * 前后端共用的弹幕事件类型。
 * 服务端产出 / 落盘 / 广播，客户端消费 —— 三处共用同一份定义。
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
	/** 发送者 uid */
	uid: number;
	/** 发送者昵称 */
	u: string;
	/** 正文 */
	m: string;
	/** B 站下发的正文颜色（十进制 RGB）。本期统一渲染白色，原色仅落盘。 */
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

/** 礼物。本期仅落盘不渲染，为 v2 预留。 */
export interface GiftEvent extends Base {
	t: 'gift';
	uid: number;
	u: string;
	/** 礼物名 */
	g: string;
	/** 数量 */
	n: number;
	/** 总价值（金瓜子） */
	price: number;
	/** 货币类型 gold / silver */
	coin: string;
}

export type DanmakuItem = DanmakuEvent | GiftEvent;

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
	/** 从当天 JSONL 读出的回显弹幕，旧 → 新 */
	echo: DanmakuEvent[];
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
