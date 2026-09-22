# live-template · OBS 直播间模板服务

像素风直播间框体 + B 站弹幕 + 手柄操作显示。作为 OBS「浏览器」源载入，
1920×1080 固定画布，视频框预留为**透明洞**，由 OBS 下方的「显示器采集」透出。

```
┌──────────────────────────────────────┬─────────────────┐
│  VIDEO  视频框（透明洞）             │  CHAT  聊天框   │
│  画面来自 OBS 下方的显示器采集       │  B 站弹幕实时   │
│                                      │                 │
├──────────────────────────────────────┤                 │
│  NOTICE  公告框（本期留空）          ├─────────────────┤
│                                      │  GAMEPAD 手柄框 │
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

| 层级 | 源类型         | 参数                                                        |
| ---- | -------------- | ----------------------------------------------------------- |
| 下   | **显示器采集** | 全屏，缩放到 1920×1080                                      |
| 上   | **浏览器**     | URL `http://<host>:8080/?hole=1`，宽 **1920** × 高 **1080** |

视频框是一个**透明的洞**，游戏画面从这里透出来。因此**不需要裁切显示器采集**，
只需缩放对齐即可。对齐尺寸如下（`?guide=1` 会把这些数字直接标在标题栏上）：

| 区域   | 内容区   | OBS 该填的面板尺寸 | 位置 (x, y) |
| ------ | -------- | ------------------ | ----------- |
| 视频框 | 1360×765 | **1366×801**       | 28, 28      |
| 公告框 | 1360×169 | 1366×205           | 28, 847     |
| 聊天框 | 474×630  | **480×666**        | 1412, 28    |
| 手柄框 | 474×304  | **480×340**        | 1412, 712   |

### 单独控制某个框（可选）

想把聊天框 / 手柄框做成独立源（便于单独调整层级或位置），用单框页：

| 页面           | OBS 宽高   |
| -------------- | ---------- |
| `/only/chat`   | 480 × 666  |
| `/only/pad`    | 480 × 340  |
| `/only/video`  | 1366 × 801 |
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

| OBS 版本        | 浏览器源内手柄     |
| --------------- | ------------------ |
| ≤ 30.x          | ✅                 |
| 31.0.0 / 31.0.1 | ❌ 必须 OBS 在前台 |
| **≥ 31.0.2**    | ✅ **无需焦点**    |

---

## URL 参数

优先级：**URL 参数 > 环境变量 > `config.json` > 内置默认值**。

| 参数    | 默认    | 说明                                                          |
| ------- | ------- | ------------------------------------------------------------- |
| `room`  | `90932` | B 站直播间号，支持短号，服务端自动解析                        |
| `hole`  | `1`     | 视频框内容区透明（让下方显示器采集透出）                      |
| `hud`   | `0`     | 调试控制条。默认关，OBS 里保持关                              |
| `label` | `1`     | 框体标题文字                                                  |
| `guide` | `0`     | 参考线模式：四角括号 + 标题栏显示 OBS 尺寸                    |
| `bg`    | `0`     | 透明背景（画布与留白区全透明，`transparent`/`none`/`0` 均可） |
| `mock`  | `0`     | 本地造弹幕 + 造手柄输入                                       |

> `hole` 与 `bg` 的区别：`hole` 只让**视频框**透明，其他地方不透明，游戏不会从缝隙漏出；
> `bg` 让整块画布透明，一般只用于把框体叠在别的画面上。

---

## 配置

`config.json`（仓库内默认值）或环境变量：

| 配置        | 环境变量     | 默认      | 说明                      |
| ----------- | ------------ | --------- | ------------------------- |
| `port`      | `PORT`       | `8080`    | 监听端口                  |
| `host`      | `HOST`       | `0.0.0.0` | 监听地址                  |
| `room`      | `ROOM_ID`    | `90932`   | 直播间号                  |
| `mock`      | `MOCK`       | `false`   | 离线假数据                |
| `hud`       | `HUD`        | `false`   | 调试控制条                |
| `videoHole` | `VIDEO_HOLE` | `true`    | 视频框透明洞              |
| `labels`    | `LABELS`     | `true`    | 标题文字                  |
| `guides`    | `GUIDES`     | `false`   | 参考线                    |
| `dataDir`   | `DATA_DIR`   | `./data`  | 弹幕落盘目录              |
| `idleMs`    | `IDLE_MS`    | `60000`   | 无人观看后断开 B 站的延时 |
| `echoCount` | `ECHO_COUNT` | `10`      | 新页面回显条数            |
| `logLevel`  | `LOG_LEVEL`  | `info`    | debug/info/warn/error     |
| `biliCookie` | `BILI_COOKIE` / `BILI_COOKIE_FILE` | 空 | 见下方「登录态」 |

---

## 登录态（可选）

不带登录态时，B 站会把**部分**弹幕的昵称打码成 `赛***`（实测约 2/3），
并把对应的 `uid` 返回为 `0`。带上登录态 Cookie 能显著降低打码比例。

> 无法保证 100% 消除：实测**同一个用户、同一房间**，有的消息给真实昵称、
> 有的给打码昵称，这是 B 站在匿名连接上按消息隐藏的行为。
> 好消息是 `user_hash` 始终稳定，所以用户名着色不受影响（见设计文档 §20.2）。

### 扫码登录（推荐）

三种方式，按你的场景选：

| 场景 | 做法 |
| --- | --- |
| 本机/SSH 有 Node | `npm run login` |
| 只有 Docker | `docker compose run --rm login` |
| 想用浏览器 | 配 `LOGIN_TOKEN` → 打开 **`/admin`** → 输入口令 → 扫码 |

#### 终端扫码

```bash
npm run login
```

终端会打印二维码，用 **B 站手机 App** 扫码并确认。成功后：

- 凭据写入 `secrets/bili-cookie.txt`（权限自动设为 `600`）
- 立刻用 `nav` 接口校验并打印账号昵称 —— 「是否真登录上了」当场可见
- 只打印脱敏摘要，绝不回显凭据原值

> 终端里显示的是字符画二维码，SSH 会话里同样可用。
> 手机不方便扫时，命令会同时打印二维码链接，可在手机上直接打开。

**容器部署**（宿主机没有 Node 也能用，镜像里已打包好）：

```bash
docker compose run --rm login
```

#### 浏览器扫码（管理页）

在 `.env` 里设一个访问口令，然后重启：

```bash
LOGIN_TOKEN=随便一串足够长的口令
```

口令会打印在启动日志里（仅此一次）：

```
[live-template] 管理页已开启: /admin （访问口令: xxxxxxxx）
```

打开 **`/admin`**，输入口令进入，再点「生成二维码」用 B 站 App 扫码。
扫码成功后服务会**自动热重载**登录态，无需重启。

管理页只在**已授权**时才下发「B 站是否已登录」这类运行信息；
未授权时连这些都不返回。

> **为什么是独立页面，而不是 OBS 画布上的按钮：**
> 二维码绝不能出现在直播画面里。放在 HUD 上时，安全性依赖「OBS 不派发鼠标事件、
> 且 HUD 默认关闭」这个间接前提；移到独立页面后，画布上**根本不存在**这个东西 ——
> 这是结构性保证，不依赖 OBS 的行为。

> **为什么建议设口令：** 二维码图**就是** `qrcode_key` 的图形编码，而持有 key 的人
> 就能在扫码成功后领走凭据（实测：轮询接口不校验任何身份，且把 SVG 解码即可还原 key）。
> 也就是说图是**凭据等价物**。compose 默认把端口发布到 `0.0.0.0`，
> 所以不设口令时，同网段的人可以取走你正在扫的那张图并抢走凭据。
>
> 口令**防不住**二维码钓鱼（B 站的生成接口是公开的，谁都能自己造码）——
> 那是二维码登录固有的属性，别把两者搞混。详见设计文档。
>
> 口令只在登入时提交一次，服务端随即换成 **HttpOnly 会话 Cookie**，
> 口令本身不进浏览器存储。会话有效期 7 天；**轮换 `LOGIN_TOKEN` 即等于
> 吊销所有已下发的会话**。
>
> 不设 `LOGIN_TOKEN` 时管理页**默认关闭**，仍可用上面两条命令扫码。

#### 让凭据生效

无论用哪种方式，服务都要知道去读哪个文件：

```bash
# 本机
BILI_COOKIE_FILE=./secrets/bili-cookie.txt

# 容器：注意这里写的是**容器内**路径（compose.yml 已默认设好）
# 宿主机上的 ./secrets 挂载到 /run/secrets
BILI_COOKIE_FILE=/run/secrets/bili-cookie.txt
```

### 手动配置（备选）

```bash
# 从文件读取：可 chmod 600 且不进版本库
BILI_COOKIE_FILE=./secrets/bili-cookie.txt npm run dev

# 环境变量：方便，但会出现在 docker inspect / 进程 environ / 日志采集里
BILI_COOKIE='SESSDATA=...; bili_jct=...; DedeUserID=...' npm run dev
```

Cookie 从浏览器开发者工具里复制（需含 `DedeUserID` 字段）。

### 有效性校验

两种方式都会在启动时用 `nav` 接口**校验有效性**：

- 校验通过 → 用真实 uid 连接，日志显示 `登录态有效 uid=...`
- 校验不通过 → **降级为匿名连接**（不会让直播间连不上），并在日志与
  `/api/health` 中告警，避免「以为自己登录了」

容器的做法见 `compose.yml`：把 `./secrets` **只读**挂进 `/run/secrets`
（运行中的服务不需要写凭据，权限按最小化给；只有 `login` 那个一次性容器是可写的）。

### 关于凭据安全

- **管理会话**：口令只在校验时出现一次，服务端随即下发 `HttpOnly` + 签名 的
  Cookie（`SameSite=Strict` 防 CSRF）。前端 JS 拿不到口令，也不存口令。
  会话有效期 7 天，**轮换 `LOGIN_TOKEN` 即立刻吊销全部会话**。
- `Secure` 属性按实际协议决定，**不写死**：本项目 compose 默认发布到 `0.0.0.0`，
  从局域网 `http://` 访问时若带上 `Secure`，浏览器会直接丢弃 Cookie，
  表现为「登入成功但依旧未授权」。这是实测踩到的坑。
- 唯一的日志出口是 `redactCookie()`：`SESSDATA` / `bili_jct` 等一律显示为 `***`，
  `buvid` 只留前 8 位；`DedeUserID` 原样显示（公开 uid，便于排查登错号）。
- 技术细节：弹幕服务器的认证包**只靠 `uid` 字段声称身份**，Cookie 并不会发给它
  （只用于 HTTP API）。因此「已登录」是通过认证包里的真实 uid 表达的 ——
  但也**不能只填 uid**：实测不带 Cookie 时填真实 uid 会被服务端直接断开。

---

## 弹幕归档

按天分文件、逐行 JSON：`data/room-<房间号>/YYYY-MM-DD.jsonl`

```jsonc
// 弹幕
{
  "t": "danmaku",
  "id": 1,
  "ts": 1789960092826,
  "uid": 0,
  "uh": "3768840604",
  "u": "赛***",
  "m": "弹幕内容",
  "color": 16777215,
  "lv": 42,
  "guard": 3,
  "medal": ["粉丝牌", 12],
  "vip": false,
  "admin": false,
}

// 礼物
{ "t": "gift", "id": 2, "uid": 0, "uh": "3768840604", "u": "赛***", "g": "小心心",
  "n": 10, "price": 0, "coin": "gold", "lv": 42, "guard": 3, "medal": ["粉丝牌", 12] }

// 醒目留言
{ "t": "sc", "id": 3, "uid": 0, "uh": "3768840604", "u": "赛***", "m": "留言正文",
  "price": 30, "duration": 60, "lv": 42, "guard": 3, "medal": null,
  "colorStart": "#b39ddb", "colorEnd": "#7e57c2",
  "colorBottom": "#5e35b1", "fontColor": "#ffffff" }
```

- **时区敏感**：按天分文件用的是本地时间，容器内已固定 `TZ=Asia/Shanghai`。
  自行部署时务必设置，否则北京时间 08:00 前的弹幕会被归到前一天。
- 三类条目（弹幕 / 礼物 / SC）都会落盘并参与回显。
- 页面重连时会带上最后收到的事件 id，服务端补发断线期间遗漏的弹幕，**不丢弹幕**。
- **`uid` 实测恒为 `0`、`u` 是被打码的昵称**（如 `赛***`）——B 站对未登录观众隐藏了
  这些字段。`uh`（B 站的 `user_hash`）才是能区分观众的稳定标识，
  用户名着色也以它为首选种子。详见 [`docs/design.md`](docs/design.md) §20.2。

---

## 接口

| 路径                  | 说明                                            |
| --------------------- | ----------------------------------------------- |
| `GET /`               | 整页模板（OBS 主源）                            |
| `GET /only/<box>`     | 单框页：`chat` / `pad` / `video` / `notice`     |
| `GET /debug/pad`      | 手柄调试页（含原始轴值与按键数值）              |
| `GET /api/health`     | 运行状态：房间、连接状态、配置、对齐尺寸        |
| `GET /api/self-test`  | 注入 3 条测试弹幕，验证「WS → 渲染」链路        |
| `WS /ws?room=&since=` | 弹幕推送（`hello` → `status`/`danmaku`/`ping`） |
| `GET /admin`          | 管理页：扫码登录 B 站（需 `LOGIN_TOKEN`，见上） |
| `POST /api/admin/login`  | 用口令换取管理会话 Cookie（HttpOnly）        |
| `POST /api/admin/logout` | 清除管理会话                                 |
| `POST /api/login/qr`     | 开起扫码挑战（需管理会话）                   |
| `GET /api/login/status`  | 轮询扫码状态（需管理会话；**不回传二维码图**）|
| `POST /api/login/cancel` | 取消当前扫码流程（需管理会话）               |

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
│  │  │  ├─ bili/              api / packet / client / qrlogin（B 站采集与扫码）
│  │  │  ├─ admin-session.ts   管理会话签名（HMAC，无状态）
│  │  │  ├─ login.ts           扫码登录状态机
│  │  │  └─ credential.ts      凭据落盘（权限 600）
│  │  └─ shared/               types / geometry / pad / chat / view / qr
│  └─ routes/                  +page / only/[box] / debug/pad / admin / api/*
├─ server.mjs                  生产入口（HTTP + /ws）
├─ Containerfile / compose.yml
└─ tests/unit.test.ts          单测（无测试框架）
```

---

## 已实现 / 未实现

**已实现**：

- B 站弹幕实时采集、断线自动重连与补发、JSONL 归档与回显
- 可选登录态连接（减少昵称打码）
- 聊天框渲染：**弹幕 / 礼物 / 醒目留言（SC）** 三类，像素风皮肤
- 用户名着色、粉丝牌、UL 等级、舰长徽章（房管 / 大会员标记）
- 手柄全量键位显示（ABXY / 十字键 / 肩键 / 扳机模拟量 / 双摇杆 / View-Menu-Guide）
- 视频透明洞、单框页、健康检查与自检、mock 模式、容器部署

**未实现（考虑后续）**：上舰播报、进房欢迎、点赞、头像、公告框内容、
屏蔽词与限流、按键历史序列、多房间切换 UI。

> 聊天框的配色与像素风取舍见 [`docs/design.md`](docs/design.md) §19。

设计取舍与原因见 [`docs/design.md`](docs/design.md)。
