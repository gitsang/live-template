# OBS 直播间模板服务 · 设计文档

> 状态：**已定稿，进入实现**
> 基线：`statics/basic-framework.html`（像素风 1920×1080 框体模板）

---

## 1. 目标

提供一个可被 OBS「浏览器」源直接载入的直播间背景服务：

1. **弹幕**：服务端连接 B 站直播间，实时抓取弹幕并推送到页面，渲染进「聊天框」。
2. **手柄**：在页面内通过浏览器 Gamepad API 捕获手柄操作，渲染进「手柄操作框」。
3. **视频框**：预留为**透明洞**，由 OBS 的「显示器采集」源从下方透出，无需裁切采集源。

非目标（本期明确不做）：上舰播报、进房欢迎、点赞、头像、屏蔽词、限流、公告框内容、
按键映射、按键历史序列。

> 已从「非目标」移入实现：礼物渲染、醒目留言（SC）、用户名着色、UL 等级、粉丝牌、舰长徽章。
> 见 §19 的渲染说明。

---

## 2. 关键结论：Gamepad API 在 OBS 浏览器源中可用

这是本方案中风险最高的一点，已完整溯源验证，**结论：可用，但要求 OBS ≥ 31.0.2**。

### 2.1 证据链

**（a）业界既有实现直接使用裸 Gamepad API**

`gamepadviewer.com`（被大量主播作为 OBS 浏览器源使用）的 `gamepad.js` 中：

```js
var rawGamepads =
    (navigator.getGamepads && navigator.getGamepads()) || ...;
window.addEventListener('gamepadconnected', ...);
window.addEventListener('gamepaddisconnected', ...);
gamepadSupport.startPolling();
```

全文没有 `window.focus()`、没有 `document.hasFocus()`、没有 visibility hack、
没有 `postMessage` 中继、没有 WebHID。其官方安装说明也只有「生成 URL → OBS 新建浏览器源 →
粘贴 → 完成」，未要求点击 `Interact`。

**（b）焦点问题曾经真实存在，源于 Chromium 117+ 的回归**

- OBS issue [#11694 Gamepad Viewer not working](https://github.com/obsproject/obs-studio/issues/11694)：
  > it only registers my button inputs **when i am clicked directly on the obs window**,
  > as soon as i click off of it the buttons no longer show being pressed

- 根因：Chromium 117 起在 Windows 上改用 `Windows.Gaming.Input`（WGI），其文档明确：
  > A Windows application must have focus to receive input from a controller.

  而 OBS 浏览器源正是**无焦点的离屏窗口**。

- OBS 维护者 WizardCM 提交了修复 [obs-browser PR #471](https://github.com/obsproject/obs-browser/pull/471)
  （2025-02-04 合入），通过命令行开关禁用 WGI，退回不要求焦点的旧 XInput 行为：

  ```cpp
  #ifdef _WIN32
      disableFeatures += ",EnableWindowsGamingInputDataFetcher";
  #endif
  ```

- 修复随 **OBS 31.0.2（2025-03-07）** 发布，release notes 原文：
  > Fixed an issue on Windows where browser sources would not recognize gamepad input
  > **if OBS Studio was not in focus** [WizardCM]

### 2.2 版本矩阵（Windows）

| OBS 版本 | 浏览器源内手柄 |
|---|---|
| ≤ 30.x | ✅ 可用（XInput，无需焦点） |
| 31.0.0 / 31.0.1 | ❌ 必须 OBS 窗口在前台 |
| **≥ 31.0.2** | ✅ **可用，无需焦点** |

### 2.3 设计后果

**因此不采用「浏览器桥接 + WS 中继」方案**，改为：

- 手柄数据**完全在前端读取与渲染**，不出浏览器；
- 删除 `/bridge` 页与手柄回传通道；
- WebSocket 仅用于**弹幕单向推送**（服务端 → 页面），服务端对「手柄」零感知；
- 手柄 mock 也在前端完成，Linux 开发环境即可验证手柄框。

### 2.4 已知 API 限制

- **必须按键唤醒**：Chromium 只会在收到一次按键输入后才把设备暴露给
  `navigator.getGamepads()`（`gamepadconnected` 也在此刻触发）。因此实现**无条件持续轮询**，
  不依赖 `gamepadconnected` 事件，并在无设备时显示呼吸提示。
- **Guide/Home 键（PS/Xbox 键）通常不可读**：受 Gamepad API 约束，浏览器普遍不暴露该键。
  手柄框中保留该位置但不作点亮承诺。
- 非标准映射手柄：按 `gamepad.mapping === 'standard'` 判定；非 standard 时仍按索引尽力渲染。

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│  B 站                                                          │
│   api: room_init / finger/spi / nav(wbi) / getDanmuInfo        │
│   wss: <host>:443/sub  (brotli, protover=3)                    │
└───────────────▲──────────────────────────────────────────────────────┘
                │ 服务端出网（Node，无第三方依赖）
┌───────────────┴──────────────────────────────────────────────────────┐
│  Node 服务（SvelteKit + adapter-node，:8080）                   │
│                                                                      │
│   src/lib/server/bili/     认证与协议：spi / wbi / room_init /        │
│                            getDanmuInfo / ws 客户端 / 解包           │
│   src/lib/server/hub.ts    房间注册表：懒加载 + 引用计数 + 空闲断开    │
│   src/lib/server/store.ts  JSONL 落盘 + 当天回显                     │
│   src/lib/server/eventbus.ts  事件总线 + 环形历史 + 断点补发          │
│                                                                      │
│   静态托管：/  /only/[box]  /debug/pad                                │
│   WebSocket：/ws?room=&since=                                        │
└───────────────▲──────────────────────────────────────────────────────┘
                │ ws://host:8080/ws  （仅弹幕，单向为主）
┌───────────────┴──────────────────────────────────────────────────────┐
│  OBS 浏览器源（CEF）                                            │
│   渲染框体 + 弹幕 + 手柄框                                            │
│   Gamepad API → 本地 rAF 轮询 → 本地渲染（不经网络）                   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. 技术栈与依赖

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | SvelteKit + `@sveltejs/adapter-node` | 需要真实 Node 进程挂 WebSocket |
| 语言 | TypeScript（`strict`） | — |
| 运行时 | Node ≥ 22 | 内置 `WebSocket` 客户端、`brotliDecompressSync`、`fetch` |
| WS 服务端 | `ws` | 唯一必要的运行时依赖 |
| 弹幕协议 | **自实现**，不用第三方库 | 需要精确控制 `AUTH_FULL` 认证字段与看门狗 |
| 容器 | `node:22-alpine` | 无 native 依赖 |
| 前端依赖 | 无（不引 UI 库） | 视觉全部来自抽出的 CSS |

> `scripts/danmaku.py` 作为**参考实现**保留，不参与运行。所有逻辑以 Node/TS 重新实现。

---

## 5. 目录结构

```
live-template/
├─ docs/
│  └─ design.md                       # 本文档
├─ scripts/
│  └─ danmaku.py                      # 参考实现（Python，保留不运行）
├─ statics/
│  └─ basic-framework.html            # 原始模板（保留做视觉参照）
├─ src/
│  ├─ app.html
│  ├─ lib/
│  │  ├─ styles/
│  │  │  └─ theme.css                 # 从 basic-framework.html 抽出的共享 CSS
│  │  ├─ components/
│  │  │  ├─ Scene.svelte              # 1920×1080 画布 + 缩放
│  │  │  ├─ Panel.svelte              # 通用「框」（标题栏 + body 插槽）
│  │  │  ├─ Sprite.svelte             # ASCII 点阵 → SVG 像素精灵
│  │  │  ├─ ChatBox.svelte            # 聊天框
│  │  │  ├─ PadBox.svelte             # 手柄操作框
│  │  │  ├─ VideoBox.svelte           # 视频框（透明洞）
│  │  │  ├─ NoticeBox.svelte          # 公告框（占位，本期空）
│  │  │  └─ Hud.svelte                # 调试控制条
│  │  ├─ client/
│  │  │  ├─ ws.ts                     # 弹幕 WS 客户端（重连 + 补发）
│  │  │  ├─ gamepad.ts                # Gamepad 轮询 → 归一化状态
│  │  │  └─ mock.ts                   # 前端 mock：弹幕 / 手柄
│  │  ├─ server/
│  │  │  ├─ config.ts                 # 配置加载与合并
│  │  │  ├─ logger.ts
│  │  │  ├─ eventbus.ts               # 事件总线 + 环形历史 + 补发
│  │  │  ├─ store.ts                  # JSONL 落盘 / 回显
│  │  │  ├─ hub.ts                    # 房间注册表（引用计数 / 空闲断开）
│  │  │  ├─ ws-server.ts              # /ws 升级与连接管理
│  │  │  └─ bili/
│  │  │     ├─ room.ts                # room_init：短号 → 真实房间号
│  │  │     ├─ wbi.ts                 # buvid(spi) + wbi 签名
│  │  │     ├─ danmu-info.ts          # getDanmuInfo（token + host_list）
│  │  │     ├─ packet.ts              # B 站协议封包/解包（含 brotli）
│  │  │     ├─ client.ts              # WS 客户端：认证 / 心跳 / 看门狗 / 重连
│  │  │     └─ types.ts
│  │  └─ shared/
│  │     ├─ types.ts                  # 前后端共用事件类型
│  │     └─ geometry.ts               # 版面几何常量（唯一事实来源）
│  └─ routes/
│     ├─ +layout.svelte
│     ├─ +page.svelte                 # 整页模板
│     ├─ only/[box]/+page.svelte      # 独立单框页（精确像素盒子）
│     ├─ debug/pad/+page.svelte       # 手柄调试页（普通浏览器打开）
│     └─ api/health/+server.ts        # 健康检查
├─ data/                              # JSONL 落盘（容器挂载卷，git 忽略）
├─ config.json                        # 默认配置
├─ server.mjs                         # adapter-node 入口 + /ws 挂载
├─ Containerfile
├─ compose.yml
├─ .env.example
└─ README.md
```

---

## 6. OBS 分层与版面几何

### 6.1 三层源结构

```
┌─ 第 3 层（最上）？不需要
├─ 第 2 层：浏览器源  /?hole=1   （1920×1080，带 alpha）
│            └─ 视频框 body 为「透明洞」，其余区域不透明
└─ 第 1 层：显示器采集（全屏，铺满 1920×1080）
```

游戏画面**只从视频框的洞里透出**。因此**不需要裁切显示器采集源**，只需缩放对齐即可。

- `hole=1` 只把**视频框 body** 置为透明，画布底纹、留白区、其他三框保持不透明。
- 这与全局 `bg=transparent` 不同：后者会让画布与留白也透明，游戏会从缝隙漏出。

### 6.2 精确几何（由 `:root` 变量推导，画布坐标系 = 1080p 真实像素）

```
--pad:28  --gap:18  --right:480  --pad-h:340  --hd:30  --bw:3
```

**两套尺寸，别混用：**

- **内容区（body）**：纯黑/透明预留区，用于对齐显示器采集
- **面板外框**：含标题栏（30px）与上下边框（3px×2），即 `/only/<box>` 页的尺寸，
  也是 OBS 浏览器源里要填的宽高

关系：`外框宽 = 内容区宽 + 6`；`外框高 = 内容区高 + 36`

| 区域 | 内容区 x,y | 内容区 宽×高 | 外框 宽×高（OBS 填这个） |
|---|---|---|---|
| **视频框** | 31, 61 | **1360 × 765** | **1366 × 801** |
| 公告框 | 31, 880 | 1360 × 169 | 1366 × 205 |
| **聊天框** | 1415, 61 | **474 × 630** | **480 × 666** |
| **手柄框** | 1415, 745 | **474 × 304** | **480 × 340** |

> 实现中这组数值由 `src/lib/shared/geometry.ts` 的 `BOXES`（内容区）与
> `PANELS`（外框）分别给出，并有单测锁定两者关系，避免文档、CSS、OBS 三处对不上。

推导：

```
scene   = 1920-2*28 = 1864 宽，1080-2*28 = 1024 高
col-left  = 1864 - 18 - 480 = 1366
视频 body = 1366-2*3 = 1360 → 高 1360*9/16 = 765  → 面板高 765+30+6 = 801
公告 面板 = 1024 - 18 - 801 = 205 → body 高 169
聊天 面板 = 1024 - 18 - 340 = 666 → body 高 630
手柄 body = 340-30-6 = 304
```
> 这些数值在实现时由 `src/lib/shared/geometry.ts` 统一给出，`theme.css` 与页面共用，
> 避免文档、CSS、OBS 三处对不上。

### 6.3 聊天框容量

内容区 `474×630`，上下 padding 各 6px → 可视高 `618px`。

单行实测 **33px** = 正文 16px × 行高 1.6（25.6）+ 行内 padding 上下各 3px + 分隔线 1px
（浏览器取整）。→ **纯弹幕可见约 18 行**。

礼物行为同样高度；SC 行约 61px（金额/用户名一行 + 正文一行），混合出现时可见条数更少。

> 这个数字改过两次，都记在这里避免再算错：先按 25.6px 估成 23 行（漏了行内
> padding 与分隔线），又用含 padding 的 `clientHeight` 估成 19 行。
> 现在由 `tests/unit.test.ts` 锁定为 18。

---

## 7. 弹幕链路设计

### 7.1 获取过程

```
1. GET https://api.live.bilibili.com/room/v1/Room/room_init?id=<短号或真实号>
      → { room_id, live_status }            # 短号 → 真实房间号
2. GET https://api.bilibili.com/x/frontend/finger/spi
      → { b_3, b_4 }                        # buvid3 / buvid4 设备指纹
      cookie = buvid3=..; buvid4=..; b_nut=<now>
3. GET https://api.bilibili.com/x/web-interface/nav   (带 cookie)
      → wbi_img.img_url / sub_url → img_key, sub_key → mixin_key
4. GET getDanmuInfo?id=<room_id>&type=0&...&wts=&w_rid=<md5>   (带 cookie)
      → { token, host_list }
5. wss://<host>:443/sub    (TLS，Origin: https://live.bilibili.com)
6. 发认证包(op=7) → 收 op=8 {"code":0} 视为认证成功
7. 每 25s 发心跳(op=2)；认证成功立即补一次
```

### 7.2 认证包必须使用完整字段（关键）

参考实现 `scripts/danmaku.py` 的注释指出：**不带 `queue_uuid` 时，同房间的多条连接
可能被当作同一个消费组被轮询分流，导致每条连接只拿到一部分弹幕（实测差约 8 倍）**。
因此认证包照抄网页端全套字段：

```json
{
  "uid": 0,
  "roomid": 90932,
  "protover": 3,
  "platform": "web",
  "type": 2,
  "key": "<token>",
  "buvid": "<b_3>",
  "support_ack": true,
  "queue_uuid": "<8 位随机小写字母数字>",
  "scene": "room"
}
```

### 7.3 传输细节

| 项 | 值 | 说明 |
|---|---|---|
| `protover` | **3** | Node 内置 brotli，比 zlib(2) 更快 |
| 端口 | **443** | 不用 `host_list` 返回的 `wss_port`，绕开对 2245/2244 的封锁 |
| host | `host_list[0..4]` 依次尝试 | 失败换下一个 |
| 心跳间隔 | 25s | B 站要求 30s 内至少一次 |
| 首次心跳 | 认证成功后立即 | 与网页端行为一致 |
| 收包超时 | 15s | 保证循环能及时醒来发心跳 |
| **看门狗** | **静默 > 75s 判定死连接** | 覆盖「连接还活着但一条不给」的场景，强制重连 |
| 重连间隔 | 5s，指数退避至 30s | token 过期会重新走 7.1 全流程 |
| Ping/Pong | 收 op=0x9 回 pong | — |

### 7.4 事件解析

| cmd | 处理 |
|---|---|
| `DANMU_MSG` | **渲染**。取 `info[1]` 文本、`info[2]` 用户、`info[0][3]` 颜色、`info[4][0]` 等级、`info[3]` 粉丝牌、`info[7]` 舰长 |
| `SEND_GIFT` | **仅落盘，不渲染**（v2 再展示） |
| `SUPER_CHAT_MESSAGE` / `INTERACT_WORD` / `LIKE_INFO_V3` / `WATCHED_CHANGE` | 本期忽略（不落盘） |

### 7.5 掉线重连与补发

- 每个客户端连接携带 `since`（最后收到的事件 id）；
- 服务端环形历史保留 **1000** 条，补发窗口 **600s**，单次最多补发 **40** 条；
- 客户端断线重连时带上 `since`，服务端补发窗口内遗漏的弹幕，**避免 OBS 重连几秒内永久丢弹幕**。

---

## 8. 服务端 Hub

### 8.1 房间注册表

```
RoomHub
  rooms: Map<roomId, RoomSession>
  acquire(roomId, client)   # 客户端订阅 → 引用计数 +1，无会话则懒加载创建
  release(roomId, client)   # 引用计数 -1，归零后启动 60s 空闲定时器
  # 60s 内无人再订阅则断开 B 站连接并回收会话（回到 8.2 磁盘状态）
```

- 支持多房间并存（不同 `?room=` 各自一条 B 站连接）；
- 空闲断开 **60s**，避免 OBS 切场景时频繁重连。

### 8.2 事件总线

- 全局自增 `id`，事件结构化后广播给该房间所有订阅者；
- 环形历史用于补发；
- 最新 `status` 事件单独保存，新连接立即收到，标题栏立刻显示正确状态。

### 8.3 落盘与回显

**JSONL，按天分文件，逐行 append（崩溃安全，无需重写整个文件）**：

```
data/room-90932/2026-09-20.jsonl
```

字段（**全存**，即使本期不渲染，未来 v2 无需改动采集层）：

```jsonc
{ "id": 1234, "ts": 1758387600123, "t": "danmaku",
  "uid": 1557129, "u": "用户名", "m": "弹幕正文",
  "color": 16777215, "lv": 42, "guard": 3,
  "medal": ["粉丝牌名", 12], "vip": false, "admin": false }

{ "id": 1235, "ts": 1758387600456, "t": "gift",
  "uid": 1557129, "u": "用户名", "g": "小心心", "n": 10, "price": 0, "coin": "gold" }
```

- **按天分文件依赖本地时区**，容器内设 `TZ=Asia/Shanghai`，否则北京时间 08:00 前会归到前一天。
- **回显**：新客户端连接时，**从当天文件读取最近 10 条弹幕**，随 `hello` 事件下发。
  （不是内存历史，是磁盘，因此**重启服务后依然回显**。）

---

## 9. WebSocket 协议

**端点**：`GET /ws?room=<roomId>&since=<lastEventId>`

### 9.1 服务端 → 客户端

```jsonc
// 连接建立后第一个包
{ "t": "hello", "room": 90932, "latest": { /* 当前 status */ },
  "echo": [ /* 最近 10 条 danmaku，来自磁盘 */ ] }

// 状态变更（含房间号、开播状态、连接状态）
{ "t": "status", "s": "connecting" | "connected" | "reconnecting" | "error",
  "room": 90932, "live": 1, "host": "zj-cn-...:443", "msg": "错误信息" }

// 弹幕
{ "t": "danmaku", "id": 1234, "ts": 1758387600123,
  "uid": 1557129, "u": "用户名", "m": "正文", "color": 16777215,
  "lv": 42, "guard": 3, "medal": ["粉丝牌", 12], "vip": false, "admin": false }

// 礼物（仅透传，前端忽略）
{ "t": "gift", "id": 1235, "uid": 1, "u": "用户名", "g": "小心心", "n": 10 }
```

### 9.2 客户端 → 服务端

```jsonc
{ "t": "subscribe", "room": 90932, "since": 1230 }   // 可选，切换房间用
{ "t": "ping" }
```

### 9.3 连接管理

- 客户端指数退避重连（0.5s → 1s → 2s → … → 上限 10s，带抖动）；
- 服务端每 20s 发 `ping`，客户端回 `pong`，30s 无响应断开；
- 心跳保活同时防止中间层（反代）掐断空闲连接。

---

## 10. 前端：聊天框

| 项 | 决定 |
|---|---|
| 排序 | 数组渲染，**上旧下新**，最新在底部 |
| 滚动 | 内容**超出高度才开始滚动**（自动吸底）；未超出不出现滚动条 |
| 长文 | **换行**（`overflow-wrap: anywhere`），不截断 |
| 动画 | **淡入**（`opacity 0 → 1`，约 200ms，`steps()` 保像素感） |
| 颜色 | 正文**统一白色**；B 站下发原色只存 JSONL，不渲染 |
| 用户名 | 不着色；不做等级、粉丝牌、头像 |
| DOM 上限 | 只保留最近 **300** 条，超出移除最旧 |
| 回显 | 连接时先渲染 10 条历史，再追加实时 |
| 标题栏 | `.dim` 位置显示 `90932 · ●已连接` / `●重连中` / `○未开播` |

滚动实现要点：不使用 `{#each}` 的顺序反转 hack；用**数组整体替换 + FLIP 位移动画**
（记录每行 `offsetTop`，更新后计算位移并用 `transform` 过渡回 0），保证新旧条目
在插入/裁剪时平滑移动，且不阻塞滚动。

---

## 11. 前端：手柄操作框

### 11.1 读取

```ts
// rAF 轮询；不依赖 gamepadconnected 事件
const pads = navigator.getGamepads();
const pad = pads.find(p => p && p.connected) ?? null;
```

- 归一化：按键 `0/1`；扳机 `button.value`（0–1）；摇杆 `axes`（-1–1，应用死区 0.08）；
- 只在**状态变化**时更新 Svelte store，避免每帧重渲染。

### 11.2 渲染（全量）

| 元素 | 内容 |
|---|---|
| ABXY | 四键点亮（按 `mapping==='standard'` 索引） |
| 十字键 | 上下左右四向点亮 |
| 肩键 | LB / RB |
| 扳机 | LT / RT，**同时显示模拟量进度**（0–100%） |
| 摇杆 | 左右摇杆**偏移圆点**（可视化推动方向与幅度） |
| 中键 | View / Menu（Back / Start） |
| Guide | 保留位置，不点亮（API 普遍不暴露，见 §2.4） |

- 严格「**只显示当前按下**」：松开即熄灭，无历史序列、无连击计数、无按键映射；
- **无手柄或全部松开时，整框 `opacity: 0.55`**；一旦有输入恢复 `1`；
- 无设备时显示像素风呼吸提示：**「按任意键唤醒手柄」**；
- 无输入时保留键位底图水印（沿用模板中的 `.padhint` SVG）。

### 11.3 Mock

`?mock=1`（或 `mock: true`）时，前端本地按脚本生成假输入序列（依次按 A、B、X、Y、
推动左右摇杆、拉满扳机、按方向键），用于在无手柄的 Linux 开发环境验证渲染。

---

## 12. 配置系统

### 12.1 优先级

```
URL 查询参数  >  环境变量  >  config.json  >  内置默认值
```

### 12.2 配置项

| 配置 | config.json | 环境变量 | URL 参数 | 默认 | 说明 |
|---|---|---|---|---|---|
| 端口 | `port` | `PORT` | — | `8080` | 监听端口 |
| 主机 | `host` | `HOST` | — | `0.0.0.0` | 监听地址 |
| 房间号 | `room` | `ROOM_ID` | `?room=` | `90932` | 支持短号，服务端自动换真实号 |
| mock | `mock` | `MOCK` | `?mock=1` | `false` | 造弹幕 + 造手柄输入 |
| HUD | `hud` | `HUD` | `?hud=1` | **`false`** | 调试控制条，**默认关** |
| 视频洞 | `videoHole` | `VIDEO_HOLE` | `?hole=1` | **`true`** | 视频框 body 透明 |
| 标签 | `labels` | `LABELS` | `?label=0` | `true` | 框体标题文字 |
| 参考线 | `guides` | `GUIDES` | `?guide=1` | `false` | 四角括号，并在标题栏标出 OBS 应填尺寸 |
| 数据目录 | `dataDir` | `DATA_DIR` | — | `./data` | JSONL 落盘位置 |
| 空闲断开 | `idleMs` | `IDLE_MS` | — | `60000` | 引用计数归零后断开延时 |
| 回显条数 | `echoCount` | `ECHO_COUNT` | — | `10` | 启动回放条数 |
| 日志级别 | `logLevel` | `LOG_LEVEL` | — | `info` | debug/info/warn/error |
| 登录态 | `biliCookie` | `BILI_COOKIE` / `BILI_COOKIE_FILE` | — | 空（匿名） | B 站 Cookie，减少昵称打码；⚠️ 凭据，勿入库 |

> `config.json` 为仓库内可提交的默认值；本地覆盖用 `.env`（见 `.env.example`，git 忽略）。

---

## 13. 页面路由

| 路径 | 用途 | 说明 |
|---|---|---|
| `/` | **整页模板** | 1920×1080 画布 + 四框，OBS 主源用这个 |
| `/only/chat` | 独立聊天框 | 面板 **480×666**，无画布无缩放，OBS 里直接填宽高 |
| `/only/pad` | 独立手柄框 | 面板 **480×340** |
| `/only/video` | 独立视频框 | 面板 **1366×801**，纯透明洞 + 标题栏 |
| `/only/notice` | 独立公告框 | 面板 **1366×205**（本期空） |
| `/debug/pad` | 手柄调试 | 普通浏览器打开，显示设备名/映射/原始轴值，便于排查 |
| `/api/health` | 健康检查 | 客户端数、连接次数、重连次数、收包数、弹幕数、最近错误、事件日志 |

**独立页规则**：渲染成恰好该尺寸的盒子，填充 100%，**无 HUD、无缩放逻辑**，
在 OBS 中宽高填上表数值即可零误差对齐。HUD 是否出现由配置决定，整页默认关。

---

## 14. Mock 与自检

| 通道 | 触发 | 作用 |
|---|---|---|
| 弹幕 mock | `MOCK=1` / `config.mock=true` / `?mock=1` | 服务端不连 B 站，本地造弹幕（含随机中文用户名与文本） |
| 手柄 mock | 同上的 `?mock=1` | 前端本地造手柄输入序列 |
| 链路自检 | `GET /api/self-test` | 注入 2 条弹幕 + 1 条进入提示，确认「WS → 渲染」链路通 |

---

## 15. 部署

### 15.1 Containerfile（多阶段）

```dockerfile
# 构建阶段：装依赖 + svelte-kit build + 弹幕服务端 lib build
FROM node:22-alpine AS build
# 运行阶段：只拷 build/ + node_modules(prod) + server.mjs + config.json
FROM node:22-alpine
RUN apk add --no-cache tini tzdata   # tzdata：让 shell 与 Node 时区认知一致
ENTRYPOINT ["/sbin/tini", "--"]      # 转发信号，保证优雅落盘
CMD ["node", "server.mjs"]
```

### 15.2 compose.yml

```yaml
services:
  live-template:
    build: .
    ports: ["8080:8080"]
    volumes: ["./data:/app/data"]
    environment:
      TZ: Asia/Shanghai      # 关键：JSONL 按天分文件依赖本地时区
      ROOM_ID: "90932"
    restart: unless-stopped
```

> **tzdata 的坑**：Node 自带 ICU 时区数据，所以即使镜像里没有
> `/usr/share/zoneinfo`，Node 也会正确按 `TZ` 计算日期（JSONL 分文件是对的）。
> 但 shell 的 `date` 会显示 UTC，排查跨零点问题时极易误判，因此镜像里补装了 tzdata。

### 15.3 OBS 配置步骤（写入 README）

1. **第 1 层**：`显示器采集` 源 → 全屏铺满 1920×1080；
2. **第 2 层**：`浏览器` 源 → URL `http://<host>:8080/?hole=1`，宽高 **1920 × 1080**，
   勾选「关闭源时关闭浏览器」可选；
3. 视频框即透明洞，缩放显示器采集使其对齐洞内 1360×765 区域；
4. 需单独控制手柄框/聊天框时，另加 `/only/pad`（480×340）与 `/only/chat`（480×666）。

**OBS 版本要求**：≥ **31.0.2**（手柄在无焦点浏览器源中可用，见 §2）。

---

## 16. 开发工作流

```bash
npm install
npm run dev                       # Vite dev（含 /ws 中间件），默认 :5173
ROOM_ID=90932 npm run dev
npm run dev -- --mock             # 无网开发
npm run build && node server.mjs  # 生产模式，:8080
docker compose up -d --build
```

---

## 17. 验收标准

- [ ] `npm run build` 与 `tsc --noEmit` 零错误；
- [ ] `/api/health` 能反映真实连接与收包统计；
- [ ] 真实房间能收到弹幕，且**标题栏状态正确**（连接中断线能显示「重连中」）；
- [ ] 拔网 5s 再恢复，弹幕不丢（补发生效）且状态自愈；
- [ ] 长静默房间 > 75s 后看门狗重启连接，日志有记录；
- [ ] 重启服务后，新开页面仍能看到当天最近 10 条回显；
- [ ] `data/room-*/YYYY-MM-DD.jsonl` 逐行合法 JSON，时区正确；
- [ ] 聊天框：超 18 行才滚动、自动吸底、长文换行、像素风进场动画、DOM 不超 300 条；
- [ ] 聊天框三类条目都能渲染：弹幕（用户名着色 + 粉丝牌 + 舰长 + UL 等级）、
      礼物（像素图标 + 名称 + ×N，金/银瓜子区分配色）、SC（整块高亮 + 金额徽章 + 正文）；
- [ ] 用户名着色以 user_hash 为种子：同一观众跨消息颜色一致、不同观众分散
      （真实环境 uid 恒为 0、昵称被打码，用 uid 着色会全场同色）；
- [ ] SC 的强调色取主题色中最深的一端，深色底上不刺眼；
- [ ] mock 模式下三类条目都会出现（节奏可预测，不依赖随机）；
- [ ] 手柄框：OBS 浏览器源内**不失焦状态下**能实时点亮，松开熄灰、无输入整框 0.55；
- [ ] `?hole=1` 时游戏画面只从视频框透出，画布底纹不穿透；
- [ ] `/only/*` 页在 OBS 中按表格尺寸摆放零误差；
- [ ] 页面视觉与 `statics/basic-framework.html` 逐像素一致（除新增内容外）；
- [ ] 容器内 `TZ` 正确，跨零点文件切换正确。

---

## 18. 风险与后续

| 风险 | 缓解 |
|---|---|
| OBS < 31.0.2 时手柄失焦失效 | README 明确版本要求；`/debug/pad` 可快速定位 |
| B 站风控变更（`-352`） | `AUTH_FULL` 字段 + 完整 `dm_img_*` 风控参数；失败自动重试并记录日志 |
| `queue_uuid` 缺失导致弹幕丢 8 倍 | 已固化在认证包中，并有注释防止回归 |
| `protover=3` 解压异常 | 解包兼容 ver 2(zlib) 与 3(brotli) 两条分支 |
| 长直播内存增长 | 环形历史 1000 条 + DOM 上限 300 条 + 事件总线不无限累积 |

**v2 候选**：礼物/SC/上舰渲染、用户名与等级着色、粉丝牌、公告框、屏蔽词与限流、
按键历史序列、多房间切换 UI。

---

## 19. 聊天框渲染（弹幕 / 礼物 / SC）

### 20.1 三类条目

| 类型 | 数据来源 | 视觉 |
|---|---|---|
| 弹幕 `danmaku` | `DANMU_MSG` | 用户名着色 + 粉丝牌 + 舰长徽章 + UL 等级 |
| 礼物 `gift` | `SEND_GIFT` | 像素礼物盒图标 + 「赠送 礼物名 ×N」；金瓜子金色、银瓜子品红 |
| 醒目留言 `sc` | `SUPER_CHAT_MESSAGE` | 整块高亮 + `￥金额` 徽章 + 元信息行 + 正文行 |

### 20.2 用户名着色的种子：user_hash，不是 uid

**实测结论（真实直播间抓包，共 22 条弹幕）**：

| 字段 | 实测结果 |
|---|---|
| `info[2][0]`（uid） | 打码消息为 **0**，未打码消息为真实 uid |
| `info[2][1]`（昵称） | 部分被打码，形如 `赛***`、`x***`（本次 15/22） |
| `info[0][15].extra.user_hash` | **每条都有**，同一用户跨消息稳定 |

关键发现：**同一个 `user_hash`（同一用户）、同一房间、`mode` 与 `dm_type` 都相同，
却同时出现两种形态** —— 有的是「真实 uid + 真实昵称」，有的是「uid=0 + 打码」。
说明打码是**匿名连接被服务端按消息隐藏**，既不按用户、也不按消息类型。

这条结论同时决定了两件事：

1. 若按直觉以 `uid` 为先着色，不但整场可能塌成同色，**同一个用户**还会在
   两种形态间跳色 —— 因此必须优先用 `user_hash`。
2. `uid=0` 时不能靠别的途径「猜」出用户，`user_hash` 是唯一稳定标识。
因此 `nameColor()` 的种子优先级是 **`uh`（user_hash）> `uid` > 昵称**：

- `uh` 是数字串，可能超出安全整数范围，用逐字符 FNV-1a 而不是 `Number()`
- 退到 `uid` 时用乘法散列（`imul(uid, 2654435761)`）而不是取模，避免相邻 uid 撞色
- 昵称只是最后兜底 —— 打码后大量观众会重名

> `extra` 是**被序列化过的字符串**，需要二次 `JSON.parse`，见
> `packet.ts` 的 `parseUserHash()`；解析失败一律返回空串，绝不因此丢弹幕。

配色本身用 8 色亮色板，**不用** B 站下发的颜色：那套颜色面向浅色主题，
深底上常看不清。
- **SC 强调色**取 `colorBottom/colorEnd/colorStart` 中**亮度最低**的一个
  （`pickAccent()`）：B 站 SC 渐变整体偏浅，直接当深色主题的描边会刺眼。
- 弹幕正文**保持白色**，不跟随 B 站下发色，理由同上。

### 20.3 像素风做法

- 全部使用直角、1px 线、硬阴影（`box-shadow: Npx Npx 0`），不用圆角与模糊；
  仅图标用 `drop-shadow` 做硬边投影。
- 行间分隔是 1px **点线**（`border-bottom: 1px dotted`），模仿老式终端。
- 徽章（UL / 房管 / 大会员 / 舰长）都是 2px 描边 + 1px 硬阴影的小方块。
- 粉丝牌拆成「深色名称段 + 亮色等级段」，与 B 站观感一致但配色更贴深色底。
- 进场动画用 `steps()` 做阶梯式淡入（`chat-in`），SC 额外加一次 `brightness`
  闪动（`sc-in`）以示强调。
- 图标（礼物盒 / 四角星）复用 `Sprite` 的 ASCII 点阵 → SVG 机制，随主题色着色。

### 20.4 登录态连接（可选）

配置 `BILI_COOKIE` / `BILI_COOKIE_FILE` 可以带登录态连接，
**能减少昵称被打码的比例**（不能保证 100% 消除，原因见 §20.2）。

机制上有一个容易踩错的地方：**弹幕服务器的认证包只靠 `uid` 字段声称身份，
没有签名校验，Cookie 本身并不发给弹幕服务器**（Cookie 只用于 HTTP API）。
所以「已登录」这件事是通过在认证包里填真实 `uid` 表达的。

但**不能只填 uid 就完事**。实测：在不带 Cookie 的情况下填一个真实 uid
（官方账号 `2`），服务端会直接以 **1006 关闭连接且不回认证回应** ——
比匿名连接还糟。因此流程必须是：

```
匿名 SPI 取 buvid
      ↓
Cookie 里解析 DedeUserID
      ↓
nav 接口校验 isLogin 且 mid == 解析出的 uid   ← 缺这步会被服务端断开
      ↓ 通过                     ↓ 不通过
认证包填真实 uid            退回 uid=0 并告警
```

校验失败**降级为匿名而不是报错**：一个可选凭据不该让直播间完全连不上，
但必须给出明确告警（写日志 + 随 `status` 事件上报），
否则使用者会「以为自己登录了」。

#### 凭据的处理约定

- **绝不打印原始 Cookie**。唯一允许输出 Cookie 信息的通道是
  `session.ts` 的 `redactCookie()`：凭据字段（`SESSDATA` / `bili_jct` / …）
  一律变成 `***`，`buvid` 只留前 8 位，`DedeUserID` 原样显示
  —— 它是公开 uid，且是排查「登错号」的关键线索。
- 脱敏时会剔除控制字符：Cookie 值里的换行会把一行日志劈成两行，
  等于让凭据持有者伪造日志内容。
- `config.json` 里的 `biliCookie` 留空；生产用 `BILI_COOKIE_FILE`
  指向一个 `chmod 600` 的文件。环境变量会出现在 `docker inspect`、
  `/proc/<pid>/environ` 与日志采集系统里，凭据不宜放那里。
- `secrets/`、`*.cookie` 已加入 `.gitignore`。

### 20.5 容量与性能

- 单行实测 **33px**（正文 25.6 + 行内 padding 6 + 分隔线 1），
  可视高 618px → **完整可见约 18 行**；SC 行约 61px，混合时更少。
- DOM 上限 300 条；渲染上限与可见行数的关系由单测锁定。
- 逐条 `{#each (item.id)}` 键控，追加/裁剪时用 FLIP 位移补偿，
  既有条目平滑上移而不跳变。

### 20.6 mock 的两份实现曾发散（已修）

服务端 mock 与前端 mock 最初各写一份，结果**前端那份只造弹幕**。
于是 `MOCK=1` 时页面走前端 mock、根本不连 WS，礼物与 SC 永远不出现 ——
表现为「功能没生效」，实际是数据源问题。

现在两边共用 `$lib/shared/demo-events.ts` 的 `createDemoEvent()`，
且节奏改为**按 index 取模**（每 7 条礼物、每 11 条 SC、每 12 条超长弹幕），
而不是随机阈值 —— 纯随机会让「验证某种渲染」变成碰运气。

---
