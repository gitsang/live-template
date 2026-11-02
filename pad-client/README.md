# pad-client · Windows 手柄采集端

把「读手柄」从浏览器搬到进程外，让 OBS 在后台、切场景、最小化时手柄框照样动。

## 为什么需要它

浏览器读手柄有两个硬限制：

1. Chromium 只对**拥有焦点**的窗口轮询 Gamepad API；
2. 浏览器源不可见时页面 rAF 会被节流 —— 读到了也不会重绘。

OBS ≥ 31.0.2 修掉了第 1 条里 `Windows.Gaming.Input` 那部分，但第 2 条管不到。
采集端在进程内直接读设备（XInput / HIDAPI / RawInput，都不要求焦点），把状态推给服务端，
页面订阅即可 —— 与 OBS 是否在前台完全无关。

设计说明见 [`../docs/design.md`](../docs/design.md) §21。

## 环境要求

- Windows 10 / 11
- Node.js ≥ 20（开发用 22 验证）
- 服务端已设置 `PAD_TOKEN`

## 安装

```bash
cd pad-client
npm install
```

`@kmamal/sdl` 在安装阶段会下载预编译的 `dist/sdl.node` 与 `SDL2.dll`（来自 GitHub Releases）。
如果这一步被网络拦掉，运行时会报 `Cannot find module '../../dist/sdl.node'`，手动补一次：

```bash
cd node_modules/@kmamal/sdl && node scripts/install.mjs && cd ../../..
```

## 运行

```bash
# 先确认能看见手柄（不会连服务端）
npm run list

# 正式上报
npm start -- --server http://192.168.1.10:8080 --token 你的PAD_TOKEN
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--server` | `http://127.0.0.1:8080`（或 `PAD_SERVER`） | 直播模板服务地址，`http(s)://` / `ws(s)://` 都行 |
| `--token` | `PAD_TOKEN` | 与服务端 `PAD_TOKEN` 相同 |
| `--slot` | `p1`（或 `PAD_SLOT`） | 玩家位；页面目前渲染 `p1` |
| `--rate` | `60` | 采样率（10–240）。页面按 60fps 渲染，再高只是白烧 CPU |
| `--index` | `0` | 用第几个手柄设备（`npm run list` 的顺序） |
| `--list` | — | 只列设备后退出 |
| `--verbose` | — | 打印每帧按键变化，排障用 |

启动后的正常输出：

```
[21:30:02] SDL 已就绪，检测到 1 个手柄设备
[21:30:02] 服务端 http://192.168.1.10:8080 · 玩家位 p1 · 采样 60Hz
[21:30:02] 手柄：Xbox Wireless Controller
[21:30:02] 已连上服务端
```

## 开机自启

按 `Win+R` 输入 `shell:startup`，在打开的目录里放一个快捷方式：

- 目标：`cmd /c "cd /d D:\path\to\live-template\pad-client && npm start -- --server http://… --token …"`
- 运行方式：**最小化**（`cmd /c start /min ...` 也行，但会多留一个窗口）

更稳妥的是「任务计划程序」：触发器「登录时」，操作填上面的命令，勾「不管用户是否登录都运行」以外的默认项即可。

> 采集端是常驻进程，建议只跑一份：重复实例会往同一个 `slot` 互相覆盖。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `Cannot find module '../../dist/sdl.node'` | 预编译二进制没下下来，见上面「安装」里的手动补一条 |
| `没有检测到手柄` | USB/蓝牙没连上、驱动异常、或被别的程序独占；`npm run list` 是唯一判据 |
| `服务端拒绝连接（口令错误或未开启 PAD_TOKEN）` | 两端口令不一致，或服务端没设 `PAD_TOKEN`（留空 = 关闭上报） |
| 连上但页面不动 | 打开 `/debug/pad` 看「来源」是否为 `采集端上报（/ws/pad）`；再看 `/api/health` 的 `pads` |
| 报 `SDL silent error: Unexpected controller element crc` | SDL 解析映射表时的无害提示，不影响读取 |
| 手柄拔了再插要等 1 秒 | 设备表是每秒重扫一次（不依赖事件回调），属预期 |

## 已知限制

- **Guide/Home 键**取决于后端：XInput 后端没有这一位，读到 `false` 是正常的。
- **DS4/DS5** 走 SDL 自带的 HIDAPI 驱动，通常不需要 DS4Windows；
  只以 DirectInput 暴露的手柄不会被识别，用 `npm run list` 确认。
- 只上报**一个**设备（`--index` 选）。多玩家请起多份并配不同 `--slot`。
