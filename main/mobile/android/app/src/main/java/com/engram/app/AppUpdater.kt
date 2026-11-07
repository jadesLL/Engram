package com.engram.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * 安卓端 OTA 更新引擎：检查 → 后台下载 APK → 交给系统安装器。
 *
 * 为什么单独一套（见 docs/ANDROID.md 的能力边界）：手机端只能靠安装包升级，不能像桌面端
 * 那样增量拉源码重建、也不能像 Docker 端那样换容器。信号源沿用服务端与桌面端同一份
 * Gitea Release（附件 `Engram <版本>.apk`），所以「有没有新版」三端口径一致。
 *
 * 分工：
 *  - 本类负责网络、文件与状态机（检查/下载/续传/就绪/失败），全部动作异步执行、只改内部状态，
 *    界面靠轮询 `/api/app-update/state` 取进度——本地服务不能为了一个几十 MB 的下载阻塞请求线程；
 *  - 需要 Activity 才能做的事（调起安装器、跳「安装未知应用」设置页、弹通知）走 [Host]，
 *    由 MainActivity 在 onCreate 时挂上；应用不在前台时安装会明确报错，而不是静默失败。
 *
 * 安装那一步 Android 强制用户点一次系统确认（侧载没有静默安装），本引擎只把包准备好并调起界面。
 *
 * 私有仓库凭据：与桌面/服务端「更新源配置」同一口径——访问令牌或用户名密码二选一，
 * 凭据只存本机（SecretStore，Android Keystore 密封），**不随多端同步下发**（中枢只给地址）。
 */
class AppUpdater(
    private val context: Context,
    private val db: LocalDatabase,
    private val secrets: SecretStore,
) {

    /** 需要 Activity 的动作；由 MainActivity 挂载，未挂载（如纯后台进程）时对应动作会明确报错 */
    interface Host {
        /** 用 FileProvider 调起系统安装器；返回是否已调起 */
        fun launchInstaller(apk: File): Boolean

        /** 跳系统「安装未知应用」授权页 */
        fun openInstallPermissionSettings()

        /** 下载完成后的系统通知（应用在前台时宿主可选择不弹） */
        fun notifyReady(version: String, apk: File)

        /**
         * 自动下载失败、已暂停本版本自动更新的系统通知。
         * 失败发生在后台时用户看不到界面，必须有一条通知兜住；宿主没有通知权限时静默降级。
         */
        fun notifyAutoUpdateFailure(version: String, reason: String)

        /** 申请通知权限（Android 13+）；返回当前是否已授权 */
        fun requestNotificationPermission(): Boolean
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    private val lock = Any()

    @Volatile private var phase = PHASE_IDLE
    @Volatile private var percentValue: Int? = null
    @Volatile private var doneBytes = 0L
    @Volatile private var totalBytes = 0L
    @Volatile private var errorText = ""
    @Volatile private var latestVersion: String? = null
    @Volatile private var releaseTag = ""
    @Volatile private var releaseNotes = ""
    @Volatile private var assetName = ""
    @Volatile private var assetUrl = ""
    @Volatile private var checkedAtMs = 0L
    @Volatile private var installLaunched = false

    /** 用户点过安装但卡在系统「安装未知应用」授权页：回前台自动续装（见 resumePendingInstall） */
    @Volatile private var pendingInstallAfterPermission = false

    /** 当前这轮下载是不是自动触发的：只有自动失败才写暂停记录（手动失败由用户自己看着办） */
    @Volatile private var autoDownloadInFlight = false

    fun config(): AppUpdateConfig = AppUpdateConfig.fromSettings { key -> db.setting(key) }

    /**
     * 本机 APK 的 versionName（即 release / debug 包的实际版本号）。
     * 不用 BuildConfig：AGP 8 起默认不生成 BuildConfig（本模块也没开 buildFeatures.buildConfig）。
     */
    fun currentVersion(): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: "0.0.0"

    /** 界面读的状态快照：字段名与 web 侧 stores/appUpdate.ts 一一对应 */
    fun stateJson(): JSONObject {
        val cfg = config()
        val current = currentVersion()
        val ready = readyApk()
        val paused = autoPause()
        return JSONObject()
            .put("runtime", "android")
            .put("currentVersion", current)
            .put("debugBuild", AppUpdatePolicy.isDebugVersion(current))
            .put("latestVersion", latestVersion ?: JSONObject.NULL)
            .put("releaseTag", releaseTag)
            .put("releaseNotes", releaseNotes)
            .put("hasUpdate", AppUpdatePolicy.hasUpdate(current, latestVersion))
            .put("phase", phase)
            .put("percent", percentValue ?: JSONObject.NULL)
            .put("downloadedBytes", doneBytes)
            .put("totalBytes", totalBytes)
            .put("error", errorText)
            .put("configured", cfg.configured)
            .put("repoUrl", if (cfg.configured) "${cfg.giteaUrl}/${cfg.giteaRepo}" else cfg.giteaUrl)
            // 地址来源：true = 用的是多端同步时从枢纽学回的那份（本机没手填）
            .put("fromHub", cfg.fromHub)
            .put(
                "hasLocalSource",
                !db.setting(AppUpdateConfig.KEY_URL).isNullOrBlank() && !db.setting(AppUpdateConfig.KEY_REPO).isNullOrBlank(),
            )
            // 私有库凭据：界面按 authType 渲染「访问令牌 / 用户名密码」二选一；用户名不是秘密，
            // 令牌与密码都不回显，只给「已保存」标记（输入框留空 = 不修改）
            .put("authType", cfg.authType)
            .put("username", cfg.username)
            .put("tokenSaved", !secrets.get(TOKEN_KEY).isNullOrBlank())
            .put("passwordSaved", !secrets.get(PASSWORD_KEY).isNullOrBlank())
            .put("autoUpdate", cfg.autoUpdate)
            .put("checkedAt", if (checkedAtMs > 0) Instant.ofEpochMilli(checkedAtMs).toString() else "")
            .put("ready", ready != null)
            .put("apkName", ready?.name ?: assetName)
            .put("canInstall", canInstallPackages())
            .put("notificationsEnabled", notificationsEnabled())
            .put("installLaunched", installLaunched)
            // 正等着用户去系统授权页点「允许」：界面据此提示「返回后会自动继续安装」
            .put("awaitingInstallPermission", pendingInstallAfterPermission)
            // 自动更新暂停记录（本版本自动下载失败过）：界面据此显示「已暂停」与失败原因，
            // 字段固定存在、无记录时为空串，前端不用做 undefined 判断
            .put("autoPausedVersion", paused.version)
            .put("autoPausedReason", paused.reason)
            .put("autoPausedAt", paused.at)
    }

    /**
     * 保存更新源配置：
     *  - `giteaUrl` / `giteaRepo`：本机手填（空串即清掉，改回「跟随同步中枢」）；
     *  - `useHub: true`：显式改回跟随中枢（清掉本机手填的地址）；
     *  - `authType`：私有库凭据方式（`token` / `password`，与桌面/服务端同一口径）；
     *  - `username`：用户名密码方式的用户名（非秘密，进设置表）；
     *  - `token` / `password`：空串即清除（分别存 Keystore 密封的 SecretStore，不进设置表）；
     *  - `autoUpdate`：自动检查 + 后台下载开关；
     *  - `retryAutoUpdate: true`：用户显式点「重试自动更新」——清掉暂停记录，自动更新开着就立刻重新检查。
     */
    fun saveConfig(body: JSONObject) {
        if (body.has("giteaUrl")) db.setSetting(AppUpdateConfig.KEY_URL, body.optString("giteaUrl").trim().trimEnd('/'))
        if (body.has("giteaRepo")) db.setSetting(AppUpdateConfig.KEY_REPO, body.optString("giteaRepo").trim().trim('/'))
        if (body.optBoolean("useHub", false)) {
            db.setSetting(AppUpdateConfig.KEY_URL, "")
            db.setSetting(AppUpdateConfig.KEY_REPO, "")
        }
        if (body.has("autoUpdate")) {
            db.setSetting(AppUpdateConfig.KEY_AUTO, if (body.optBoolean("autoUpdate", true)) "1" else "0")
        }
        if (body.has("username")) db.setSetting(AppUpdateConfig.KEY_USERNAME, body.optString("username").trim())
        if (body.has("token")) secrets.put(TOKEN_KEY, body.optString("token").trim().ifBlank { null })
        if (body.has("password")) secrets.put(PASSWORD_KEY, body.optString("password").trim().ifBlank { null })
        if (body.has("authType")) {
            val mode = if (body.optString("authType").trim() == AppUpdateConfig.AUTH_PASSWORD) {
                AppUpdateConfig.AUTH_PASSWORD
            } else {
                AppUpdateConfig.AUTH_TOKEN
            }
            db.setSetting(AppUpdateConfig.KEY_AUTH_TYPE, mode)
            // 只保留当前方式的凭据（与桌面/服务端「更新源配置」同一口径）：换方式后另一种不再需要
            if (mode == AppUpdateConfig.AUTH_PASSWORD) secrets.put(TOKEN_KEY, null) else secrets.put(PASSWORD_KEY, null)
        }
        val sourceChanged = body.has("giteaUrl") || body.has("giteaRepo") || body.has("authType") ||
            body.has("username") || body.optBoolean("useHub", false)
        if (sourceChanged) {
            // 换源/换凭据方式后旧检查结果不再成立：清掉版本与包，避免拿旧仓库的包去装
            synchronized(lock) {
                latestVersion = null; releaseTag = ""; releaseNotes = ""; assetName = ""; assetUrl = ""
                totalBytes = 0; doneBytes = 0; percentValue = null; checkedAtMs = 0
                if (phase != PHASE_DOWNLOADING) phase = PHASE_IDLE
                pendingInstallAfterPermission = false
                errorText = ""
            }
            updatesDir().listFiles()?.forEach { it.delete() }
        }
        // 换源或换凭据（令牌/密码）后旧失败记录不再成立：失败可能正是凭据不对造成的，
        // 用户改完凭据就应允许自动下载重试；换源时同一版本号也代表另一份包
        if (sourceChanged || body.has("token") || body.has("password")) clearAutoUpdatePause()
        if (body.optBoolean("retryAutoUpdate", false)) {
            // 用户显式点「重试自动更新」：清掉暂停记录；自动更新开着就立刻重新检查一次
            clearAutoUpdatePause()
            if (config().autoUpdate) requestCheck()
        }
    }

    /**
     * 多端同步学回的更新源（中枢下发，见 SyncEngine.learnUpdateSource）：只覆盖「中枢那份地址」，
     * 不动本机手填的；检查更新时本机手填优先。
     */
    fun learnHubSource(url: String, repo: String) {
        val trimmedUrl = url.trim().trimEnd('/')
        val trimmedRepo = repo.trim().trim('/')
        if (trimmedUrl.isBlank() || trimmedRepo.isBlank()) return
        db.setSetting(AppUpdateConfig.KEY_HUB_URL, trimmedUrl)
        db.setSetting(AppUpdateConfig.KEY_HUB_REPO, trimmedRepo)
    }

    /**
     * 回前台、启动时自动跑一次（MainActivity.onStart 走 EngramLocalServer.onForeground）：
     * 先看有没有「用户点过安装、但卡在系统授权页」的续装要接着走；再距上次检查没超过
     * [AppUpdateConfig.CHECK_INTERVAL_MS] 就不重复问远端；上次下载被打断则接着下。
     */
    fun onForeground() {
        cleanupInstalledApks()
        resumePendingInstall()
        val cfg = config()
        if (!cfg.configured || !cfg.autoUpdate) return
        if (phase == PHASE_CHECKING || phase == PHASE_DOWNLOADING) return
        val fresh = checkedAtMs > 0 && System.currentTimeMillis() - checkedAtMs < AppUpdateConfig.CHECK_INTERVAL_MS
        if (fresh) {
            // 自动续下同样受暂停记录约束：本版本自动下载失败过就不再自动重试，检查本身不受影响
            if (assetUrl.isNotBlank() && readyApk() == null && autoDownloadAllowed()) requestAutoDownload()
            return
        }
        requestCheck()
    }

    /** 检查远端最新 Release（异步）：立即返回，界面轮询 state 看 phase 变化 */
    fun requestCheck() {
        synchronized(lock) {
            if (phase == PHASE_CHECKING || phase == PHASE_DOWNLOADING) return
            phase = PHASE_CHECKING
            errorText = ""
        }
        Thread({ runCheck() }, "engram-app-update-check").start()
    }

    /** 手动触发下载（检查结果里已有 assetUrl 才有意义；自动更新开启时检查完会自动下载） */
    fun requestDownload() = startDownload(automatic = false)

    /**
     * 自动路径（检查完自动下 / 回前台自动续下）：失败一次就记下暂停，本版本不再自动重试；
     * 用户手动点「下载」不走这里，所以暂停期间手动下载仍然可用。
     */
    private fun requestAutoDownload() = startDownload(automatic = true)

    private fun startDownload(automatic: Boolean) {
        synchronized(lock) {
            if (phase == PHASE_DOWNLOADING) return
            if (assetUrl.isBlank()) {
                phase = PHASE_ERROR
                errorText = "还没有可下载的安装包，请先检查更新"
                return
            }
            autoDownloadInFlight = automatic
            phase = PHASE_DOWNLOADING
            errorText = ""
        }
        Thread({ runDownload() }, "engram-app-update-download").start()
    }

    /**
     * 调起系统安装器；返回 ok/原因（权限缺失、包没下完、不在前台都走这里说清）。
     *
     * 「安装未知应用」权限缺失时不再让用户自己去找设置入口：直接拉起系统的授权页
     * （ACTION_MANAGE_UNKNOWN_APP_SOURCES，侧载没有别的授权途径），并记下待续装标记——
     * 用户允许后回到应用，[onForeground] 里的 [resumePendingInstall] 会自动接着调起安装器。
     * 这条路径返回 ok=false + needPermission=true，界面按「已打开授权页」提示，不当失败报错。
     */
    fun install(): JSONObject {
        val apk = readyApk()
        if (apk == null) {
            synchronized(lock) {
                phase = PHASE_ERROR
                errorText = "安装包还没下载完成"
            }
            throw IllegalStateException("安装包还没下载完成")
        }
        if (AppUpdatePolicy.isDebugVersion(currentVersion())) {
            throw IllegalArgumentException("当前是调试包，装正式包会与它并存成两个 App：请手动安装发布版 APK")
        }
        val uiHost = host ?: throw IllegalArgumentException("请回到 Engram 应用内再点安装")
        if (!canInstallPackages()) {
            synchronized(lock) { pendingInstallAfterPermission = true }
            uiHost.openInstallPermissionSettings()
            return JSONObject()
                .put("ok", false)
                .put("needPermission", true)
                .put("message", "系统还没允许 Engram 安装应用：已打开「安装未知应用」授权页，允许后返回会自动继续安装")
        }
        if (!uiHost.launchInstaller(apk)) throw IllegalStateException("无法调起系统安装器")
        installLaunched = true
        return JSONObject().put("ok", true).put("apkName", apk.name)
    }

    /** 跳「安装未知应用」授权页（需要 Activity，走 Host） */
    fun openInstallSettings() {
        val uiHost = host ?: throw IllegalArgumentException("请回到 Engram 应用内再点这个按钮")
        uiHost.openInstallPermissionSettings()
    }

    /**
     * 从「安装未知应用」授权页回来后的续装：用户此前点过安装、权限已开、包仍就绪才自动调起
     * 系统安装器（[AppUpdatePolicy.shouldResumeInstall] 是同一判定的纯函数版）。
     * 用户没授权（又退回来了）就清掉待续装标记——避免每次回前台都重放，等他下次点安装再引导。
     */
    private fun resumePendingInstall() {
        if (!pendingInstallAfterPermission) return
        val allowed = canInstallPackages()
        val apk = if (allowed) readyApk() else null
        if (!AppUpdatePolicy.shouldResumeInstall(pendingInstallAfterPermission, allowed, apk != null)) {
            synchronized(lock) { pendingInstallAfterPermission = false }
            return
        }
        val uiHost = host ?: return
        if (!uiHost.launchInstaller(apk!!)) return
        synchronized(lock) {
            installLaunched = true
            pendingInstallAfterPermission = false
        }
    }

    /** 申请通知权限（Android 13+）：下载完成的提醒要靠它，没授权也不影响应用内提示 */
    fun requestNotifications(): Boolean = host?.requestNotificationPermission() ?: notificationsEnabled()

    fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    fun notificationsEnabled(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    // ---------------------------------------------------------------- 内部实现

    private fun runCheck() {
        val cfg = config()
        if (!cfg.configured) {
            fail("还没可用的更新源：在「设置 → 版本与更新 → 安卓端更新」填仓库地址，或让同步中枢配好更新源（会随多端同步下发）")
            return
        }
        try {
            val builder = Request.Builder()
                .url("${cfg.giteaUrl}/api/v1/repos/${cfg.giteaRepo}/releases/latest")
                .header("Accept", "application/json")
            // 私有库凭据二选一（访问令牌 / 用户名密码），公开库没有凭据就不带 Authorization
            authHeader()?.let { builder.header("Authorization", it) }
            http.newCall(builder.get().build()).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (response.code == 404) throw IOException("远端仓库上还没有 Release")
                if (!response.isSuccessful) throw IOException("仓库 API HTTP ${response.code}")
                val data = JSONObject(body)
                val tag = data.optString("tag_name")
                val notes = data.optString("body")
                val version = AppUpdatePolicy.normalizeVersion(tag)
                val assets = data.optJSONArray("assets")
                val names = mutableListOf<String>()
                val urls = mutableListOf<String>()
                val sizes = mutableListOf<Long>()
                if (assets != null) {
                    for (index in 0 until assets.length()) {
                        val asset = assets.optJSONObject(index) ?: continue
                        names.add(asset.optString("name"))
                        urls.add(asset.optString("browser_download_url"))
                        sizes.add(asset.optLong("size"))
                    }
                }
                val picked = AppUpdatePolicy.pickApkAsset(names)
                if (picked == null) throw IOException("该 Release 里没有 APK 附件（发版时需勾选 binaries）")
                val pickedIndex = names.indexOf(picked)
                synchronized(lock) {
                    latestVersion = version
                    releaseTag = tag
                    releaseNotes = notes.take(12_000)
                    assetName = picked
                    assetUrl = urls.getOrElse(pickedIndex) { "" }
                    totalBytes = sizes.getOrElse(pickedIndex) { 0L }
                    doneBytes = 0
                    percentValue = 0
                    checkedAtMs = System.currentTimeMillis()
                    errorText = ""
                }
            }
            if (assetUrl.isBlank()) {
                fail("Release 里的 APK 附件没有下载地址")
                return
            }
            // 发布更新的新版本（版本号不同）后自动恢复：暂停记录只针对失败过的那个版本号
            if (AppUpdatePolicy.shouldClearAutoPause(autoPause().version, latestVersion)) clearAutoUpdatePause()
            val hasUpdate = AppUpdatePolicy.hasUpdate(currentVersion(), latestVersion)
            synchronized(lock) {
                phase = PHASE_IDLE
                if (!hasUpdate) {
                    errorText = ""
                    latestVersion = null
                    releaseTag = ""
                    releaseNotes = ""
                }
            }
            // 发现新版：自动更新开着就直接后台下载（用户无需盯着，装的时候再点一次确认）；
            // 本版本自动下载失败过就只把暂停状态留给界面提示，不再自动重试
            if (AppUpdatePolicy.shouldStartDownload(
                    manual = false,
                    autoUpdate = config().autoUpdate,
                    hasUpdate = hasUpdate,
                    pausedVersion = autoPause().version,
                    latestVersion = latestVersion,
                )
            ) {
                requestAutoDownload()
            }
        } catch (error: Exception) {
            fail(describe(error))
        }
    }

    private fun runDownload() {
        try {
            val dir = updatesDir()
            if (!dir.exists() && !dir.mkdirs()) throw IOException("无法创建更新目录")
            val name = assetName.ifBlank { "engram-update.apk" }
            val target = File(dir, name)
            var existing = if (target.exists()) target.length() else 0L
            if (totalBytes > 0 && existing >= totalBytes) {
                finishReady(target)
                return
            }
            val builder = Request.Builder()
                .url(assetUrl)
                .header("Accept", "application/octet-stream")
            authHeader()?.let { builder.header("Authorization", it) }
            // 断点续传：上次切后台/进程被杀留下的半截包从断点接着下（服务端支持 Range 才行）
            if (existing > 0) builder.header("Range", "bytes=$existing-")
            http.newCall(builder.get().build()).execute().use { response ->
                if (!response.isSuccessful) throw IOException("下载失败 HTTP ${response.code}")
                val append = existing > 0 && response.code == 206
                if (!append) existing = 0L
                val remaining = response.body?.contentLength() ?: -1L
                val total = if (totalBytes > 0) totalBytes else if (remaining > 0) existing + remaining else 0L
                synchronized(lock) {
                    totalBytes = total
                    doneBytes = existing
                    percentValue = AppUpdatePolicy.percent(existing, total)
                }
                val input = response.body?.byteStream() ?: throw IOException("下载响应为空")
                input.use { source ->
                    FileOutputStream(target, append).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var done = existing
                        var count = source.read(buffer)
                        while (count >= 0) {
                            output.write(buffer, 0, count)
                            done += count
                            synchronized(lock) {
                                doneBytes = done
                                percentValue = AppUpdatePolicy.percent(done, totalBytes)
                            }
                            count = source.read(buffer)
                        }
                        output.flush()
                    }
                }
            }
            val size = target.length()
            if (!AppUpdatePolicy.downloadComplete(size, totalBytes)) {
                throw IOException("安装包不完整（$size/$totalBytes 字节），已保留下载进度，下次继续")
            }
            finishReady(target)
        } catch (error: Exception) {
            val detail = describe(error)
            val automatic = synchronized(lock) {
                val flag = autoDownloadInFlight
                autoDownloadInFlight = false
                flag
            }
            synchronized(lock) {
                phase = PHASE_ERROR
                errorText = detail
            }
            // 只有自动触发的下载失败才写暂停记录：手动下载失败不拦用户，也不改自动更新策略
            if (automatic) recordAutoUpdateFailure(detail)
        }
    }

    private fun finishReady(apk: File) {
        val size = apk.length()
        synchronized(lock) {
            phase = PHASE_READY
            doneBytes = size
            if (totalBytes <= 0) totalBytes = size
            percentValue = 100
            errorText = ""
            installLaunched = false
            autoDownloadInFlight = false
        }
        // 包已经下全：不管这轮是自动还是手动，都说明该版本可用，暂停记录可以清掉了
        clearAutoUpdatePause()
        host?.notifyReady(latestVersion ?: "", apk)
    }

    /** 已下载且完整、版本对得上的安装包；版本已经装上或对不上就返回 null（并顺手删掉旧包） */
    private fun readyApk(): File? {
        val wanted = latestVersion ?: return null
        if (!AppUpdatePolicy.hasUpdate(currentVersion(), wanted)) {
            updatesDir().listFiles()?.forEach { file -> if (AppUpdatePolicy.compare(fileVersion(file), currentVersion()) <= 0) file.delete() }
            return null
        }
        val file = updatesDir().listFiles()?.firstOrNull { AppUpdatePolicy.compare(fileVersion(it), wanted) == 0 } ?: return null
        if (!file.isFile) return null
        if (totalBytes > 0 && file.length() != totalBytes) return null
        return file
    }

    /** 安装成功后清掉本版及更旧的包；比当前版本更新的包留着（下载中/待安装） */
    private fun cleanupInstalledApks() {
        val current = currentVersion()
        updatesDir().listFiles()?.forEach { file ->
            val fileVersion = fileVersion(file)
            if (fileVersion != null && AppUpdatePolicy.compare(fileVersion, current) <= 0) file.delete()
        }
    }

    /** 文件名 → 版本：`Engram 1.3.3.apk` / `engram-update.apk` 都走同一条归一化 */
    private fun fileVersion(file: File): String? = AppUpdatePolicy.normalizeVersion(file.name)

    private fun updatesDir(): File = File(context.getExternalFilesDir(null) ?: context.filesDir, "updates")

    /** 生效的私有库凭据头；无凭据返回 null（公开仓库匿名访问），口径见 AppUpdatePolicy.authHeader */
    private fun authHeader(): String? {
        val cfg = config()
        return AppUpdatePolicy.authHeader(
            authType = cfg.authType,
            token = secrets.get(TOKEN_KEY),
            username = cfg.username,
            password = secrets.get(PASSWORD_KEY),
        )
    }

    private fun fail(message: String) {
        synchronized(lock) {
            phase = PHASE_ERROR
            errorText = message
        }
    }

    private fun describe(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName

    // ---------------------------------------------------------------- 自动更新暂停

    /** 当前暂停记录（settings 表持久化；版本号空串 = 未暂停） */
    private fun autoPause(): AutoUpdatePause = AutoUpdatePause.fromSettings { key -> db.setting(key) }

    /** 自动下载是否放行：本版本自动下载失败过就不再自动下；手动下载与检查更新都不受影响 */
    private fun autoDownloadAllowed(): Boolean = AppUpdatePolicy.shouldStartDownload(
        manual = false,
        autoUpdate = config().autoUpdate,
        hasUpdate = AppUpdatePolicy.hasUpdate(currentVersion(), latestVersion),
        pausedVersion = autoPause().version,
        latestVersion = latestVersion,
    )

    /**
     * 自动下载失败一次 → 记下这个版本，本版本不再自动重试，并让宿主发一条系统通知。
     * 记在 settings 表而不是内存：失败常发生在后台，进程被杀后重启也不该再拿同一个坏包重试。
     */
    private fun recordAutoUpdateFailure(reason: String) {
        val version = latestVersion?.trim().orEmpty()
        if (version.isEmpty()) return
        val detail = reason.take(500)
        db.setSetting(AppUpdateConfig.KEY_AUTO_FAILED_VERSION, version)
        db.setSetting(AppUpdateConfig.KEY_AUTO_FAILED_REASON, detail)
        db.setSetting(AppUpdateConfig.KEY_AUTO_FAILED_AT, Instant.now().toString())
        // 应用不在前台 / 没有通知权限时宿主静默降级：发不出通知也不能影响暂停记录与状态接口
        runCatching { host?.notifyAutoUpdateFailure(version, detail) }
    }

    /** 清除暂停记录：发布新版本号、下载成功、用户点「重试自动更新」、换更新源时调用 */
    private fun clearAutoUpdatePause() {
        if (!autoPause().recorded) return
        db.setSetting(AppUpdateConfig.KEY_AUTO_FAILED_VERSION, "")
        db.setSetting(AppUpdateConfig.KEY_AUTO_FAILED_REASON, "")
        db.setSetting(AppUpdateConfig.KEY_AUTO_FAILED_AT, "")
    }

    companion object {
        /** 凭据存 SecretStore（Android Keystore 密封），与同步令牌同一套保管口径 */
        const val TOKEN_KEY = "app_update_gitea_token"

        /** 用户名密码方式的密码：同样只进 Keystore，不进设置表 */
        const val PASSWORD_KEY = "app_update_gitea_password"

        const val PHASE_IDLE = "idle"
        const val PHASE_CHECKING = "checking"
        const val PHASE_DOWNLOADING = "downloading"
        const val PHASE_READY = "ready"
        const val PHASE_ERROR = "error"

        /** 由 MainActivity 在 onCreate 挂上、onDestroy 摘掉（本地服务实例还没建好也能先挂） */
        @JvmStatic
        @Volatile
        var host: Host? = null
    }
}
