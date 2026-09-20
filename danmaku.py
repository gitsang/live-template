#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站直播间弹幕 -> OBS 叠加层服务
================================================
零第三方依赖，只用 Python 标准库。

用法:
    python danmaku.py 21452505              # 指定房间号启动
    python danmaku.py                        # 用下面 ROOM_ID 的默认值
    python danmaku.py 21452505 --port 8080   # 换端口
    python danmaku.py --demo                 # 演示模式：不连B站，自动造弹幕预览样式

启动后浏览器打开 http://127.0.0.1:12450 预览，
OBS 里添加「浏览器源」，URL 填同一个地址即可。

停止: Ctrl+C
"""

import sys
import os
import json
import time
import zlib
import queue
import ssl
import socket
import struct
import base64
import random
import hashlib
import threading
import collections
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ============================================================
#  配置
# ============================================================
ROOM_ID = 90932           # 默认房间号：阿桑Sangria 的直播间
PORT = 12450              # 本地服务端口
RECONNECT_WAIT = 5        # 断线重连间隔（秒）

# 看门狗：B站约每 20~30 秒会回一个心跳确认包，
# 超过这个秒数连心跳回包都没有，就判定连接已死，强制重连。
DEAD_AFTER = 75

# ---- 协议细节（对齐 B站网页端 / laplace.live 的实现）----
# 认证包带上 web 端同款字段。scene + support_ack + queue_uuid 是关键：
# 不带 queue_uuid 时，同房间的多条连接可能被当成同一个消费组被轮询分流，
# 导致每条连接只拿到一部分弹幕。
AUTH_FULL = True          # 是否发完整认证字段（关键！实测差 8 倍投递量）
HB_FIRST_NOW = True       # 认证成功后立刻发一次心跳（B站网页端行为）
HB_INTERVAL = 25          # 心跳间隔（秒）
USE_API_PORT = False      # True=用 getDanmuInfo 返回的 wss_port；False=用通用的 443

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# WBI 签名用的重排表（B站固定算法）
MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
             33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
             26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
             20, 34, 44, 52]

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(HERE, "danmaku.log")

# 运行期统计：用来区分「房间真的没人说话」和「连接已经断了」
STATS = {
    "started": time.time(),
    "room": ROOM_ID,
    "connects": 0,        # 认证成功次数
    "reconnects": 0,      # 重连次数
    "frames": 0,          # 收到的 WebSocket 帧数
    "cmds": {},           # 各类指令计数
    "danmaku": 0,         # 弹幕条数
    "last_data": 0,       # 最后一次收到任何数据的时刻
    "last_error": "",
    "events": [],         # 最近若干条生命周期日志
}


def log(*args):
    """写运行日志（同时打屏）。排查问题时直接看 danmaku.log"""
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(a) for a in args)
    STATS["events"].append(line)
    del STATS["events"][:-30]
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


# ============================================================
#  HTTP 请求（B站接口）
# ============================================================
def api_get(url, cookie=None, timeout=12):
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://live.bilibili.com/",
    }
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wbi_mixin_key(img_key, sub_key):
    raw = img_key + sub_key
    return "".join(raw[i] for i in MIXIN_TAB)[:32]


# 匿名设备指纹（buvid3）。B站网页端的认证包里会带它，沿用同一套字段更接近真实客户端。
BUVID = ""


def get_real_room_id(short_id):
    """短号 -> 真实房间号"""
    d = api_get("https://api.live.bilibili.com/room/v1/Room/room_init?id=%d" % short_id)
    if d.get("code") != 0:
        raise RuntimeError("room_init 失败: %s %s" % (d.get("code"), d.get("msg")))
    info = d["data"]
    return info["room_id"], info.get("live_status", 0)


def get_danmu_token(room_id):
    """拿弹幕服务器 token 和地址列表。
    要点：必须带 buvid 指纹 + WBI 签名(w_rid/wts) + dm_img_* 风控参数，
    否则接口返回 -352。不需要登录账号。"""
    spi = api_get("https://api.bilibili.com/x/frontend/finger/spi")["data"]
    cookie = "buvid3=%s; buvid4=%s; b_nut=%d;" % (spi["b_3"], spi["b_4"], int(time.time()))
    global BUVID
    BUVID = spi.get("b_3") or ""

    nav = api_get("https://api.bilibili.com/x/web-interface/nav", cookie=cookie)
    wbi = nav.get("data", {}).get("wbi_img") or {}
    if not wbi.get("img_url"):
        raise RuntimeError("拿不到 WBI 密钥（nav 接口异常）")
    img_key = wbi["img_url"].rsplit("/", 1)[-1].split(".")[0]
    sub_key = wbi["sub_url"].rsplit("/", 1)[-1].split(".")[0]
    mixin = wbi_mixin_key(img_key, sub_key)

    params = {
        "id": room_id,
        "type": 0,
        "web_location": "444.8",
        "dm_img_list": "[]",
        "dm_img_str": "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
        "dm_cover_img_str": ("QU5HTEUgKE5WSURJQSxOVklESUEgR2VGb3JjZSBHVFggMTA1MCBXaXRo"
                             "IGRpcmVjdCAzZCAoMHgwMDAwMjY2MSkgRGlyZWN0M0QxMSB2c181XzAp"),
        "dm_img_inter": '{"ds":[],"wh":[],"of":[]}',
        "wts": int(time.time()),
    }
    query = urllib.parse.urlencode(
        [(k, "".join(c for c in str(v) if c not in "!'()*"))
         for k, v in sorted(params.items())])
    params["w_rid"] = hashlib.md5((query + mixin).encode()).hexdigest()

    url = ("https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?"
           + urllib.parse.urlencode(params))
    d = api_get(url, cookie=cookie)
    if d.get("code") != 0:
        raise RuntimeError("getDanmuInfo 失败: %s %s" % (d.get("code"), d.get("message")))
    data = d["data"]
    return data["token"], data["host_list"]


# ============================================================
#  WebSocket 客户端（标准库实现）
# ============================================================
def ws_send(sock, data):
    n = len(data)
    frame = bytearray([0x82])                     # FIN + binary
    if n < 126:
        frame.append(0x80 | n)
    elif n < 65536:
        frame.append(0x80 | 126)
        frame += struct.pack(">H", n)
    else:
        frame.append(0x80 | 127)
        frame += struct.pack(">Q", n)
    mask = os.urandom(4)
    frame += mask
    frame += bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(bytes(frame))


class WebSocket:
    """最小可用的 WebSocket 客户端，够用即可"""

    def __init__(self, sock):
        self.sock = sock
        self.buf = bytearray()

    def handshake(self, host, path="/sub"):
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\nOrigin: https://live.bilibili.com\r\n"
               "User-Agent: %s\r\n\r\n") % (path, host, key, UA)
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket 握手被断开")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        first = head.split(b"\r\n")[0].decode("latin1")
        if "101" not in first:
            raise RuntimeError("WebSocket 握手失败: " + first)
        self.buf += rest

    def send(self, data):
        ws_send(self.sock, data)

    def send_pong(self):
        self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))

    def recv(self, timeout=60):
        """返回 (opcode, payload)；超时/断开返回 (None, None)"""
        self.sock.settimeout(timeout)
        while True:
            b = self.buf
            if len(b) >= 2:
                opcode = b[0] & 0x0F
                masked = b[1] & 0x80
                ln = b[1] & 0x7F
                idx = 2
                ok = False
                if ln == 126:
                    if len(b) >= 4:
                        ln = struct.unpack(">H", bytes(b[2:4]))[0]
                        idx, ok = 4, True
                elif ln == 127:
                    if len(b) >= 10:
                        ln = struct.unpack(">Q", bytes(b[2:10]))[0]
                        idx, ok = 10, True
                else:
                    ok = True
                if ok:
                    if masked:
                        idx += 4
                    if len(b) >= idx + ln:
                        payload = bytes(b[idx:idx + ln])
                        del b[:idx + ln]
                        return opcode, payload
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                return None, None            # 空闲超时，连接正常
            except OSError:
                return "eof", None           # 连接被重置 / SSL 断开
            if not chunk:
                # 收到空数据 = 服务端已关闭连接（EOF）。
                # 以前这里也返回 None，被上层误当成「空闲」，导致在死连接上无限空转。
                return "eof", None
            self.buf += chunk


# ---- B站弹幕协议包 ----
def bili_pack(op, body=b""):
    return struct.pack(">IHHII", 16 + len(body), 16, 1, op, 1) + body


def bili_unpack(payload):
    """拆包并解压，返回 [(op, json_bytes), ...]"""
    out = []
    off = 0
    while off + 16 <= len(payload):
        total, hlen, ver, op, _seq = struct.unpack(">IHHII", payload[off:off + 16])
        if total < hlen or total <= 0:
            break
        body = payload[off + hlen: off + total]
        off += total
        if op == 5 and ver == 2:                    # zlib 压缩包
            try:
                out.extend(bili_unpack(zlib.decompress(body)))
                continue
            except Exception:
                pass
        out.append((op, body))
    return out


# ============================================================
#  事件总线（分发到所有 SSE 客户端）
# ============================================================
class EventBus:
    """事件总线 + 环形历史。

    环形历史用于「断线补发」：SSE 客户端（OBS 浏览器源）重连时会带上
    上次收到的编号，服务端把断线期间漏掉的事件补发过去。
    否则弹幕一旦在断线窗口里到达，就被永久吞掉 —— 房间越安静，越容易命中。
    """

    HISTORY = 1000          # 环形历史保留的事件条数
    REPLAY_MAX = 40         # 单次最多补发条数，避免页面刷新时刷屏
    REPLAY_WINDOW = 600     # 只补发这么久以内的（秒）

    def __init__(self):
        self._lock = threading.Lock()
        self._subs = []
        self._next_id = 1
        self._hist = collections.deque(maxlen=self.HISTORY)
        self.latest = {"t": "status", "s": "waiting"}

    def subscribe(self):
        q = queue.Queue(maxsize=500)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, event):
        if event.get("t") == "status":
            self.latest = event
        with self._lock:
            eid = self._next_id
            self._next_id += 1
            event["_id"] = eid
            self._hist.append((eid, event, time.time()))
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def replay(self, since):
        """返回 (需要补发的事件列表, 当前最大编号)"""
        now = time.time()
        with self._lock:
            top = self._next_id - 1
            items = [(eid, ev) for eid, ev, t in self._hist
                     if eid > since and now - t < self.REPLAY_WINDOW]
        if len(items) > self.REPLAY_MAX:
            items = items[-self.REPLAY_MAX:]
        return items, top

    def count(self):
        with self._lock:
            return len(self._subs)


BUS = EventBus()


# ============================================================
#  B站弹幕采集线程
# ============================================================
class BiliDanmakuThread(threading.Thread):
    def __init__(self, room_input):
        super().__init__(daemon=True)
        self.room_input = room_input
        self.stop_flag = False
        self.room_id = None
        self.live_status = None
        self.authed = False

    def run(self):
        while not self.stop_flag:
            try:
                self.session()
                log("连接已结束，准备重连")
            except Exception as exc:
                STATS["last_error"] = "%s: %s" % (type(exc).__name__, exc)
                log("连接异常:", STATS["last_error"])
                BUS.publish({"t": "status", "s": "error",
                             "msg": STATS["last_error"]})
            if self.stop_flag:
                break
            time.sleep(RECONNECT_WAIT)

    def session(self):
        STATS["reconnects"] += 1
        BUS.publish({"t": "status", "s": "connecting"})
        room_id, live_status = get_real_room_id(self.room_input)
        self.room_id = room_id
        self.live_status = live_status
        STATS["room"] = room_id
        BUS.publish({"t": "status", "s": "connecting", "room": room_id,
                     "live": live_status})
        token, hosts = get_danmu_token(room_id)
        picked = []
        for h in hosts[:5]:
            try:
                p = int(h.get("wss_port") or 443) if USE_API_PORT else 443
            except (TypeError, ValueError):
                p = 443
            picked.append((h["host"], p))
        log("连接中 房间=%s 开播=%s 服务器=%s:%s"
            % (room_id, live_status,
               picked[0][0] if picked else "-", picked[0][1] if picked else "-"))

        last_err = None
        for host, port in picked:
            try:
                self.connect_and_listen(host, room_id, token, port)
                return
            except Exception as exc:
                last_err = exc
                continue
        if last_err:
            raise last_err

    def connect_and_listen(self, host, room_id, token, port=443):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((host, port), timeout=10)
        sock = ctx.wrap_socket(raw, server_hostname=host)
        try:
            ws = WebSocket(sock)
            ws.handshake(host, "/sub")

            body = {"uid": 0, "roomid": room_id, "protover": 2,
                    "platform": "web", "type": 2, "key": token}
            if AUTH_FULL:
                # 与 B站网页端一致的字段。queue_uuid 让本连接独占一条投递队列，
                # 避免同房间多条连接被当成一个消费组而被轮询分流。
                body.update({
                    "buvid": BUVID,
                    "support_ack": True,
                    "queue_uuid": "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789")
                                          for _ in range(8)),
                    "scene": "room",
                })
            auth = json.dumps(body, separators=(",", ":")).encode("utf-8")
            ws.send(bili_pack(7, auth))

            self.authed = False
            announced = False
            last_hb = time.time()
            last_data = time.time()
            STATS["last_data"] = last_data

            while not self.stop_flag:
                # 认证一通过就立刻补一次心跳（网页端行为），之后按固定周期发
                if self.authed and HB_FIRST_NOW and not announced:
                    ws.send(bili_pack(2))
                    last_hb = time.time()
                elif time.time() - last_hb > HB_INTERVAL:
                    ws.send(bili_pack(2))              # 心跳，B站要求 30s 内至少一次
                    last_hb = time.time()

                # 收包超时设成 15s，保证循环能及时醒来发心跳
                opcode, payload = ws.recv(timeout=15)

                if opcode is None:
                    # 空闲，不是故障。但要防止「连接早断了却一直以为自己还活着」
                    silent = time.time() - last_data
                    if silent > DEAD_AFTER:
                        raise RuntimeError("已静默 %d 秒（含心跳回包），判定为死连接"
                                           % int(silent))
                    continue

                last_data = time.time()
                STATS["last_data"] = last_data
                STATS["frames"] += 1

                if opcode == "eof":
                    raise RuntimeError("连接已被服务端关闭")
                if opcode == 0x9:                       # ping
                    ws.send_pong()
                    continue
                if opcode == 0x8:                       # close
                    raise RuntimeError("服务端主动关闭连接")
                if opcode not in (0x1, 0x2):
                    continue

                self.handle_payload(payload, room_id)

                # 只有真正拿到 {"code":0} 才对外报「已连接」
                if self.authed and not announced:
                    announced = True
                    STATS["connects"] += 1
                    log("已连接 房间=%s 服务器=%s:%s 认证=%s"
                        % (room_id, host, port, "完整" if AUTH_FULL else "精简"))
                    BUS.publish({"t": "status", "s": "connected", "room": room_id,
                                 "live": self.live_status, "host": host})
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def handle_payload(self, payload, room_id):
        for op, body in bili_unpack(payload):
            if op == 8:
                try:
                    r = json.loads(body.decode("utf-8", "replace"))
                except Exception:
                    continue
                if r.get("code") != 0:
                    raise RuntimeError("弹幕服务器认证失败: %s" % r)
                self.authed = True
            elif op == 5:
                try:
                    msg = json.loads(body.decode("utf-8", "replace"))
                except Exception:
                    continue
                self.handle_message(msg, room_id)

    # ---- 各类消息 ----
    def handle_message(self, msg, room_id):
        cmd = msg.get("cmd", "")
        STATS["cmds"][cmd] = STATS["cmds"].get(cmd, 0) + 1

        if cmd.startswith("DANMU_MSG"):
            try:
                info = msg["info"]
                user = info[2]
                event = {
                    "t": "danmaku",
                    "u": user[1],
                    "uid": user[0],
                    "m": info[1],
                    "admin": bool(user[2]),
                    "vip": bool(user[3]),
                    "lv": info[4][0] if len(info) > 4 and info[4] else 0,
                    "guard": info[7] if len(info) > 7 else 0,
                    "medal": self._medal(info, 3),
                    "title": self._title(info, 5),
                    "ts": int(time.time() * 1000),
                }
                BUS.publish(event)
                STATS["danmaku"] += 1
                log("弹幕 %s: %s" % (event["u"], event["m"]))
            except Exception:
                pass

        elif cmd == "SEND_GIFT":
            d = msg.get("data", {})
            BUS.publish({
                "t": "gift", "u": d.get("uname", ""), "uid": d.get("uid", 0),
                "g": d.get("giftName", "礼物"), "n": d.get("num", 1),
                "price": d.get("price", 0) * d.get("num", 1),
                "coin": d.get("coin_type", "gold"),
                "ts": int(time.time() * 1000),
            })

        elif cmd == "SUPER_CHAT_MESSAGE":
            d = msg.get("data", {})
            BUS.publish({
                "t": "sc", "u": d.get("user_info", {}).get("uname", ""),
                "m": d.get("message", ""), "price": d.get("price", 0),
                "ts": int(time.time() * 1000),
            })

        elif cmd.startswith("INTERACT_WORD"):
            d = msg.get("data", {})
            BUS.publish({"t": "enter", "u": d.get("uname", ""),
                         "ts": int(time.time() * 1000)})

        elif cmd.startswith("LIKE_INFO_V3"):
            d = msg.get("data", {})
            BUS.publish({"t": "like", "u": d.get("uname", ""),
                         "ts": int(time.time() * 1000)})

        elif cmd == "WATCHED_CHANGE":
            d = msg.get("data", {})
            BUS.publish({"t": "watched", "n": d.get("num", 0),
                         "ts": int(time.time() * 1000)})

    @staticmethod
    def _medal(info, i):
        try:
            m = info[i]
            if m and m[1]:
                return [m[1], m[0]]
        except Exception:
            pass
        return None

    @staticmethod
    def _title(info, i):
        try:
            t = info[i]
            if t and t[0]:
                return t[0]
        except Exception:
            pass
        return None


# ============================================================
#  演示模式（不连B站，用来预览样式）
# ============================================================
DEMO_USERS = ["夜航船", "一勺糖", "北岛", "橘子汽水", "林深见鹿", "阿哲", "Kiko",
              "山鬼", "夏天不热", "老陈", "木木", "晴天", "子墨", "阿May",
              "风起时", "小鹿", "柚子", "陈圆圆", "泡沫", "钢铁侠"]
DEMO_TEXT = ["这个操作太秀了", "主播666", "哈哈哈哈笑死", "666666", "来晚了",
             "这波稳了", "求个好友位", "已关注", "打卡第一天", "打得不错啊",
             "这枪法可以的", "666", "主播声音好听", "蹲一个连麦", "前方高能",
             "我裂开了", "这也能赢？", "太强了吧", "泪目", "再来一把"]
DEMO_GIFTS = ["小心心", "辣条", "小花花", "牛哇牛哇", "亿圆"]


class DemoThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)

    def run(self):
        BUS.publish({"t": "status", "s": "connected", "room": 0, "host": "DEMO"})
        i = 0
        while True:
            time.sleep(random.uniform(0.5, 1.8))
            i += 1
            r = random.random()
            if r < 0.08:
                BUS.publish({"t": "gift", "u": random.choice(DEMO_USERS),
                             "g": random.choice(DEMO_GIFTS),
                             "n": random.choice([1, 1, 1, 5, 10, 30]),
                             "price": 0, "ts": int(time.time() * 1000)})
            elif r < 0.12:
                BUS.publish({"t": "sc", "u": random.choice(DEMO_USERS),
                             "m": "主播加油！这把我压你赢",
                             "price": random.choice([30, 50, 100]),
                             "ts": int(time.time() * 1000)})
            elif r < 0.16:
                BUS.publish({"t": "enter", "u": random.choice(DEMO_USERS),
                             "ts": int(time.time() * 1000)})
            else:
                BUS.publish({
                    "t": "danmaku", "u": random.choice(DEMO_USERS),
                    "m": random.choice(DEMO_TEXT),
                    "uid": random.randint(1000, 99999),
                    "lv": random.randint(1, 60),
                    "guard": random.choice([0, 0, 0, 0, 3, 3, 2, 1]),
                    "medal": random.choice([None, None, ["七海", 12], ["航海", 21]]),
                    "admin": random.random() < 0.05,
                    "ts": int(time.time() * 1000),
                })


# ============================================================
#  本地 HTTP 服务
# ============================================================
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BiliDanmaku/1.0"

    def log_message(self, fmt, *args):
        pass                                    # 静音，避免刷屏

    def _send(self, code, ctype, body, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path in ("/", "/index.html", "/overlay.html"):
            return self.serve_file(os.path.join(HERE, "overlay.html"),
                                   "缺少 overlay.html（请和 danmaku.py 放在同一目录）")

        # 框体模板：弹幕已内嵌在里面，OBS 只填这一个地址即可
        if path in ("/frame", "/frame.html", "/stream-frame.html"):
            return self.serve_file(os.path.join(HERE, os.pardir, "stream-frame.html"),
                                   "找不到 stream-frame.html（应在 danmaku.py 的上一级目录）")

        if path == "/events":
            return self.serve_sse()

        # 自检：往事件总线注入几条假消息，用来确认「SSE → 渲染」这条显示链路是通的。
        # 打开 http://127.0.0.1:12450/test 就能在 OBS 预览里看到这三条。
        if path == "/test":
            now = int(time.time() * 1000)
            demo = [
                {"t": "danmaku", "u": "自检机器人", "uid": 1, "m": "显示链路测试 ①",
                 "admin": False, "vip": False, "lv": 60, "guard": 0,
                 "medal": None, "title": None, "ts": now},
                {"t": "danmaku", "u": "自检机器人", "uid": 1,
                 "m": "能看到这两条 → 显示正常，看不见就是渲染/中继问题",
                 "admin": False, "vip": False, "lv": 60, "guard": 0,
                 "medal": None, "title": None, "ts": now + 1},
                {"t": "enter", "u": "自检观众", "ts": now + 2},
            ]
            for ev in demo:
                BUS.publish(ev)
            log("自检：已注入 %d 条测试消息" % len(demo))
            body = json.dumps({"ok": True, "sent": len(demo),
                               "hint": "看 OBS 预览里的聊天框"},
                              ensure_ascii=False).encode("utf-8")
            return self._send(200, "application/json; charset=utf-8", body)

        if path == "/health":
            now = time.time()
            body = json.dumps({
                "clients": BUS.count(),
                "state": BUS.latest,
                "room": STATS["room"],
                "stats": {
                    "uptime": int(now - STATS["started"]),
                    "connects": STATS["connects"],
                    "reconnects": STATS["reconnects"],
                    "frames": STATS["frames"],
                    "danmaku": STATS["danmaku"],
                    "last_data_ago": int(now - STATS["last_data"]) if STATS["last_data"] else None,
                    "last_error": STATS["last_error"],
                    "cmds": STATS["cmds"],
                },
                "log": STATS["events"],
            }, ensure_ascii=False).encode("utf-8")
            return self._send(200, "application/json; charset=utf-8", body)

        self._send(404, "text/plain; charset=utf-8", "404".encode("utf-8"))

    def serve_file(self, fp, missing_msg):
        if not os.path.exists(fp):
            return self._send(404, "text/plain; charset=utf-8",
                              missing_msg.encode("utf-8"))
        with open(fp, "rb") as f:
            body = f.read()
        self._send(200, "text/html; charset=utf-8", body,
                   {"Cache-Control": "no-store"})

    def serve_sse(self):
        # 断点位置：浏览器自动重连带 Last-Event-ID，页面重载则带 ?since=
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            since = int((query.get("since") or ["0"])[0])
        except ValueError:
            since = 0
        try:
            since = max(since, int(self.headers.get("Last-Event-ID") or 0))
        except ValueError:
            pass

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        # 先订阅再补发，中间不留空档；已补发的用编号去重
        q = BUS.subscribe()
        try:
            self.wfile.write(b"retry: 1500\n\n")     # 断线后 1.5 秒就重连，缩短空窗
            self.wfile.flush()

            missed, top = BUS.replay(since)
            for eid, ev in missed:
                self._sse_write(ev, eid)
            sent = top

            self._sse_write({"t": "status", "s": "subscribed"})
            self._sse_write(BUS.latest)

            while True:
                try:
                    event = q.get(timeout=5)
                except queue.Empty:
                    # 5 秒一次心跳注释，避免长时间空闲被中间层掐断
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                eid = event.get("_id")
                if eid is not None and eid <= sent:
                    continue                            # 补发阶段已经发过
                self._sse_write(event, eid)
                if eid is not None:
                    sent = eid
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            BUS.unsubscribe(q)

    def _sse_write(self, obj, eid=None):
        parts = []
        if eid is not None:
            parts.append("id: %d" % eid)
        parts.append("data: " + json.dumps(obj, ensure_ascii=False))
        self.wfile.write(("\n".join(parts) + "\n\n").encode("utf-8"))
        self.wfile.flush()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ============================================================
#  入口
# ============================================================
def main():
    args = sys.argv[1:]
    demo = "--demo" in args
    port = PORT
    room = ROOM_ID

    args = [a for a in args if a != "--demo"]
    if "--port" in args:
        i = args.index("--port")
        try:
            port = int(args[i + 1])
        except (IndexError, ValueError):
            pass
        del args[i:i + 2]
    for a in args:
        if a.isdigit():
            room = int(a)

    print("=" * 56)
    print("  B站弹幕 -> OBS 叠加层")
    print("=" * 56)
    STATS["room"] = room
    log("启动 模式=%s 房间=%s 端口=%s" % ("演示" if demo else "直播", room, port))
    if demo:
        print("  模式: 演示（不连B站，自动造弹幕）")
        DemoThread().start()
    else:
        print("  模式: 直播弹幕")
        print("  房间: %s" % room)
        BiliDanmakuThread(room).start()

    httpd = Server(("127.0.0.1", port), Handler)
    print("  地址: http://127.0.0.1:%d" % port)
    print()
    print("  OBS 只加一个「浏览器」源即可，URL 用下面这条：")
    print("      http://127.0.0.1:%d/frame   （像素风框体 + 弹幕内嵌）" % port)
    print("  只想看弹幕层: http://127.0.0.1:%d" % port)
    print("  宽高都填 1920 × 1080。Ctrl+C 停止")
    print("=" * 56)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
