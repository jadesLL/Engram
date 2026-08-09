# LLM Wiki Windows 桌面端（Electron）

连接 NAS 上 LLM Wiki 服务的桌面客户端。相比浏览器额外提供：
**远程文件「用系统程序打开」**（自动下载到临时目录后调起 Word/WPS 等）。

## 产物（已构建）

`dist/` 目录下：

| 文件 | 说明 |
|---|---|
| `LLM Wiki Setup 0.1.0.exe` | NSIS 安装包（可选安装目录，创建桌面快捷方式） |
| `LLM Wiki 0.1.0.exe` | 便携版，双击即用，免安装 |

## 使用

1. 首次启动输入 NAS 服务地址（如 `http://192.168.1.101:8080`），地址会记住
2. 登录（密码同 Web 端）
3. 预览文件时点击「↗ 用系统程序打开」即调起系统默认程序

## 重新构建

```bash
cd desktop
pnpm install        # 如网络受限先设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm dist           # 产出 NSIS 安装包 + 便携版到 dist/
```

## 技术说明

- `main.js`：主进程。启动页配置服务器 → 加载远程 Web 应用 → IPC 处理「系统打开文件」
- `preload.js`：通过 `window.wikiDesktop` 向页面暴露受控 API（contextIsolation 开启）
- 远程文件打开流程：页面 fetch 文件字节 → IPC 传主进程 → 写入临时目录 → `shell.openPath`
