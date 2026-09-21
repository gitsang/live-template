# live-template · OBS 直播间模板服务

像素风直播间框体 + B 站弹幕 + 手柄操作显示。作为 OBS「浏览器」源载入，
1920×1080 固定画布，视频框预留为**透明洞**，由 OBS 下方的「显示器采集」透出。

```
┌──────────────────────────────────────┬─────────────────┐
│  VIDEO  视频框（透明洞）              │  CHAT  聊天框    │
│  画面来自 OBS 下方的显示器采集         │  B 站弹幕实时    │
│                                      │                 │
├──────────────────────────────────────┤                 │
│  NOTICE  公告框（本期留空）            ├─────────────────┤
│                                      │  GAMEPAD 手柄框  │
└──────────────────────────────────────┴─────────────────┘
```

---

## 快速开始

### 容器（推荐）

```bash
cp .env.compose.example .env      # 按需修改 ROOM_ID 等
docker compose up -d --build
# 浏览器打开 http://localhost:8080/
```

### 本地开发

```bash
npm install
npm run dev                       # http://localhost:5173
ROOM_ID=90932 npm run dev         # 指定房间
MOCK=1 npm run dev                # 无网络：本地造弹幕 + 造手柄输入
```

### 生产运行

```bash
npm run build
node server.mjs                   # 默认 :8080
```

### 测试

```bash
npm test                          # 协议/签名/落盘 等纯逻辑单测
npm run check                     # TypeScript + Svelte 类型检查
```

---

## OBS 配置

> **OBS 版本要求：≥ 31.0.2**（Windows）
> 手柄能否在浏览器源里工作取决于此，原因见 [为什么需要 31.0.2](#为什么需要-obs-3102)。

### 两层源，从下往上

| 层级 | 源类型 | 参数 |
|---|---|---|
| 下 | **显示器采集** | 全屏，缩放到 1920×1080 |
| 上 | **浏览器** | URL `http://<host>:8080/?hole=1`，宽 **1920** × 高 **1080** |

视频框是一个**透明的洞**，游戏画面从这里透出来。因此**不需要裁切显示器采集**，
只需缩放对齐即可。对齐尺寸如下（`?guide=1` 会把这些数字直接标在标题栏上）：

| 区域 | 内容区 | OBS 该填的面板尺寸 | 位置 (x, y) |
|---|---|---|---|
| 视频框 | 1360×765 | **1366×801** | 28, 28 |
| 公告框 | 1360×169 | 1366×205 | 28, 847 |
| 聊天框 | 474×630 | **480×666** | 1412, 28 |
| 手柄框 | 474×304 | **480×340** | 1412, 712 |

### 单独控制某个框（可选）

想把聊天框 / 手柄框做成独立源（便于单独调整层级或位置），用单框页：

| 页面 | OBS 宽高 |
|---|---|
| `/only/chat` | 480 × 666 |
| `/only/pad` | 480 × 340 |
| `/only/video` | 1366 × 801 |
| `/only/notice` | 1366 × 205 |

单框页渲染的就是整个面板（含标题栏与边框），宽高照上表填即可与整页视图像素级对齐，
且默认无调试条。

### 手柄

手柄由**页面自己通过 Gamepad API 读取**，无需任何额外程序或中继。

- **必须按一次手柄上的任意键**，浏览器才会把设备暴露给页面 —— 这是 Chromium 的行为，
  不是本项目的限制。手柄框在检测不到设备时会显示「按任意键唤醒手柄」。
- 手柄插在**跑 OBS 的那台机器**上（不是跑本服务的服务器）。
- 如果手柄框没反应，先打开 `http://<host>:8080/debug/pad` 用普通浏览器排查：
  能亮 → 问题在 OBS；不亮 → 问题在手柄/驱动/系统。

#### 为什么需要 OBS ≥ 31.0.2

Chromium 117 起在 Windows 上改用 `Windows.Gaming.Input` 读取手柄，而该 API
**要求窗口拥有焦点**才返回输入。OBS 的浏览器源是无焦点的离屏窗口，于是
「OBS 不在前台时手柄失效」—— 这个回归影响所有基于 Gamepad API 的叠加层
（包括 gamepadviewer.com）。

OBS 官方已在 [obs-browser PR #471](https://github.com/obsproject/obs-browser/pull/471)
中通过禁用该特性、退回旧的 XInput 行为修复，并随 **31.0.2** 发布，release notes：

> Fixed an issue on Windows where browser sources would not recognize gamepad input
> if OBS Studio was not in focus

| OBS 版本 | 浏览器源内手柄 |
|---|---|
| ≤ 30.x | ✅ |
| 31.0.0 / 31.0.1 | ❌ 必须 OBS 在前台 |
| **≥ 31.0.2** | ✅ **无需焦点** |

---

## URL 参数

优先级：**URL 参数 > 环境变量 > `config.json` > 内置默认值**。

| 参数 | 默认 | 说明 |
|---|---|---|
| `room` | `90932` | B 站直播间号，支持短号，服务端自动解析 |
| `hole` | `1` | 视频框内容区透明（让下方显示器采集透出） |
| `hud` | `0` | 调试控制条。默认关，OBS 里保持关 |
| `label` | `1` | 框体标题文字 |
| `guide` | `0` | 参考线模式：四角括号 + 标题栏显示 OBS 尺寸 |
| `bg` | `0` | 透明背景（画布与留白区全透明，`transparent`/`none`/`0` 均可） |
| `mock` | `0` | 本地造弹幕 + 造手柄输入 |

> `hole` 与 `bg` 的区别：`hole` 只让**视频框**透明，其他地方不透明，游戏不会从缝隙漏出；
> `bg` 让整块画布透明，一般只用于把框体叠在别的画面上。

---

## 配置

`config.json`（仓库内默认值）或环境变量：

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `port` | `PORT` | `8080` | 监听端口 |
| `host` | `HOST` | `0.0.0.0` | 监听地址 |
| `room` | `ROOM_ID` | `90932` | 直播间号 |
| `mock` | `MOCK` | `false` | 离线假数据 |
| `hud` | `HUD` | `false` | 调试控制条 |
| `videoHole` | `VIDEO_HOLE` | `true` | 视频框透明洞 |
| `labels` | `LABELS` | `true` | 标题文字 |
| `guides` | `GUIDES` | `false` | 参考线 |
| `dataDir` | `DATA_DIR` | `./data` | 弹幕落盘目录 |
| `idleMs` | `IDLE_MS` | `60000` | 无人观看后断开 B 站的延时 |
| `echoCount` | `ECHO_COUNT` | `10` | 新页面回显条数 |
| `logLevel` | `LOG_LEVEL` | `info` | debug/info/warn/error |

---

## 弹幕归档

按天分文件、逐行 JSON：`data/room-<房间号>/YYYY-MM-DD.jsonl`

```jsonc
{"t":"danmaku","id":1,"ts":1789960092826,"uid":1557129,"u":"昵称","m":"弹幕内容",
 "color":16777215,"lv":42,"guard":3,"medal":["粉丝牌",12],"vip":false,"admin":false}
```

- **时区敏感**：按天分文件用的是本地时间，容器内已固定 `TZ=Asia/Shanghai`。
  自行部署时务必设置，否则北京时间 08:00 前的弹幕会被归到前一天。
- 礼物（`SEND_GIFT`）同样落盘，本期不渲染，为后续版本预留。
- 页面重连时会带上最后收到的事件 id，服务端补发断线期间遗漏的弹幕，**不丢弹幕**。

---

## 接口

| 路径 | 说明 |
|---|---|
| `GET /` | 整页模板（OBS 主源） |
| `GET /only/<box>` | 单框页：`chat` / `pad` / `video` / `notice` |
| `GET /debug/pad` | 手柄调试页（含原始轴值与按键数值） |
| `GET /api/health` | 运行状态：房间、连接状态、配置、对齐尺寸 |
| `GET /api/self-test` | 注入 3 条测试弹幕，验证「WS → 渲染」链路 |
| `WS /ws?room=&since=` | 弹幕推送（`hello` → `status`/`danmaku`/`ping`） |

排查「弹幕没上来」：

```bash
curl -s localhost:8080/api/health        # 看 rooms 里的 state 是否 connected
curl -s localhost:8080/api/self-test     # 能看到测试弹幕 → 渲染链路没问题
```

---

## 项目结构

```
├─ docs/design.md              设计与决策记录（含手柄问题的完整溯源）
├─ scripts/danmaku.py          参考实现（Python，不参与运行）
├─ statics/basic-framework.html  原始框体模板（视觉基准）
├─ src/
│  ├─ lib/
│  │  ├─ styles/theme.css      像素风样式（自模板抽出）
│  │  ├─ components/           Scene / Panel / Sprite / ChatBox / PadBox / …
│  │  ├─ client/               ws / gamepad / mock / feed
│  │  ├─ server/               config / logger / hub / store / eventbus / ws-server
│  │  │  └─ bili/              api / packet / client（B 站采集）
│  │  └─ shared/               types / geometry / pad / chat / view
│  └─ routes/                  +page / only/[box] / debug/pad / api/*
├─ server.mjs                  生产入口（HTTP + /ws）
├─ Containerfile / compose.yml
└─ tests/unit.test.ts          单测（无测试框架）
```

---

## 已实现 / 未实现

**已实现**：B 站弹幕实时采集与渲染、断线自动重连与补发、JSONL 归档与回显、
手柄全量键位显示（ABXY / 十字键 / 肩键 / 扳机模拟量 / 双摇杆 / View-Menu-Guide）、
视频透明洞、单框页、健康检查与自检、mock 模式、容器部署。

**未实现（考虑后续）**：礼物与 SC 渲染、用户名着色、等级与粉丝牌、公告框内容、
屏蔽词与限流、按键历史序列、多房间切换 UI。

设计取舍与原因见 [`docs/design.md`](docs/design.md)。
