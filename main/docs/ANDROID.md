# Android APP（远程客户端）

Engram 的安卓端是**纯远程客户端**：原生壳（Capacitor WebView）连接已部署的 Engram
服务器（NAS Docker 或任意可访问的部署），复用服务器的移动端 Web 界面。APP 内不内嵌
服务端——服务端依赖 better-sqlite3/sqlite-vec 原生模块与 Node 运行时，不适合跑在手机上。

## 功能与交互

- **首启/切换服务器**：内置启动页（`mobile/www/index.html`）填服务器地址（如
  `http://192.168.1.101:8080`），保存在本机后自动跳转登录。
- **IPv6 直连自动择优**：服务器配置 `DIRECT_ACCESS_URL`（如 `http://v6.example.com:18080`）
  后，`/health` 会通告直连地址；APP 启动时「发现直连 → 并发探测 → 可达即自动切直连」
  （延迟低、不绕 Cloudflare），不可达自动走原地址。记住上次可用通道（lastGood）优先复用，
  断连弹回启动页时自动重试并切换通道，无需手动干预。未配置直连时行为与旧版完全一致。
- **登录态**：服务器签发的 httpOnly JWT Cookie 持久保存在 WebView 中，长期免登录。
- **断连恢复**：服务器不可达时自动弹回启动页并提示（Capacitor `server.errorPath`），
  恢复后在启动页点「连接」即可，登录态不丢。
- **切换服务器**：长按桌面图标 → 快捷方式「切换服务器」。
- **返回键**：网页可后退则后退；顶层时退到后台（不退出，保留状态）。
- **附件下载**：原始资料/附件的「下载」走系统 DownloadManager，保存到公共
  Download 目录并显示通知，自动携带登录 Cookie 与 UTF-8 文件名。
- **HTTP 明文**：允许（家庭局域网自建服务场景）；`usesCleartextTraffic=true`。
- **版本号**：`versionName`/`versionCode` 构建时自动解析 `desktop/package.json`
  的 `version`，bump 无需单独维护安卓版本。

## 目录结构

```
main/mobile/
├── capacitor.config.json     # appId com.example.exampleproject / allowNavigation / errorPath
├── www/index.html            # 内置启动页（服务器地址选择，无构建步骤）
├── android/                  # 原生工程（cap add android 生成后定制并提交）
│   └── app/src/main/java/com/example/exampleproject/MainActivity.java
├── scripts/gen-icons.cjs     # 图标/启动屏生成（开发期一次性工具）
├── scripts/build-apk-ci.sh   # CI 容器内执行：cap sync + gradle assembleRelease
└── Dockerfile.ci             # CI 构建镜像（Node 22 + JDK 21 + Android SDK 35）
```

修改了 `www/` 或 `capacitor.config.json` 后必须执行 `pnpm exec cap sync android`
（产物不入库），CI 构建前也会自动执行。

## 本地开发环境搭建（宿主机，一次性）

1. **JDK 21**（Temurin，Capacitor 7.6 要求 Java 21 源级别）。
2. **Android SDK**：cmdline-tools → `%LOCALAPPDATA%\Android\Sdk`，安装
   `platform-tools`、`platforms;android-35`、`build-tools;35.0.0`；
   `mobile/android/local.properties` 写 `sdk.dir`（不入库）。
3. **依赖**：`cd main/mobile && pnpm install --ignore-workspace`。
4. **模拟器**：`avdmanager create avd -n <名字> -k "system-images;android-35;default;x86_64"`。

首次 gradle 构建会下载 Gradle 8.11.1 与 AGP 依赖（属环境安装，需用户批准下载）。

## 本地打包

```bash
cd main/mobile
pnpm install --ignore-workspace        # 依赖变化时
pnpm exec cap sync android             # 改过 www/ 或配置后
cd android && JAVA_HOME=<jdk21> ./gradlew assembleDebug    # 调试包
# 或 assembleRelease（需签名配置，见下）
```

产物：`android/app/build/outputs/apk/{debug,release}/`。

### 签名

- release 签名从 `mobile/android/key.properties`（不入库）读取：
  `storeFile` / `storePassword` / `keyAlias` / `keyPassword`。
- keystore 保存在本机用户目录（如 `~/.android/exampleproject-release.keystore`），
  **不进仓库**；丢失后无法对已安装用户增量升级（需卸载重装），务必备份。
- 生成：`keytool -genkeypair -keystore <路径> -alias exampleproject -keyalg RSA -keysize 2048 -validity 10950`。

## CI 发版（release.yml）

打 `v*` 标签时，release.yml 在 APK 步骤中：

1. `docker build -f mobile/Dockerfile.ci -t engram-android-builder main`（准备
   Node + JDK 21 + Android SDK + 源码镜像，依赖清单不变时命中层缓存）；
2. `docker run`（注入签名 secrets）执行 `mobile/scripts/build-apk-ci.sh`：
   `cap sync android` + `gradlew assembleRelease`；
3. `docker cp` 拷出 APK，命名为 `Engram <版本>.apk` 随 Release 发布，
   sha256 记入 `sha256-<版本>.txt`。

### 需要配置的 Gitea 仓库 secrets（一次性）

| Secret | 说明 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | release keystore 文件的 base64（`base64 -w0 exampleproject-release.keystore`） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | `exampleproject` |
| `ANDROID_KEY_PASSWORD` | key 密码（与 keystore 密码相同即可） |

未配置 secrets 时 CI 仍会构建，产出 `app-release-unsigned.apk`（无法直接安装升级）。

## 已知限制

- WebView 加载用户自建服务器，站外链接同样在应用内打开（`allowNavigation: ['*']`）。
- 自签名 HTTPS 证书的服务器会被 WebView 拒绝（不做证书豁免）；家庭局域网请用 http。
- ONLYOFFICE 协同编辑依赖 ONLYOFFICE 容器地址可达，移动端体验以网页为准。
