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
    }

    /**
     * 保存更新源配置：
     *  - `giteaUrl` / `giteaRepo`：本机手填（空串即清掉，改回「跟随同步中枢」）；
     *  - `useHub: true`：显式改回跟随中枢（清掉本机手填的地址）；
     *  - `authType`：私有库凭据方式（`token` / `password`，与桌面/服务端同一口径）；
     *  - `username`：用户名密码方式的用户名（非秘密，进设置表）；
     *  - `token` / `password`：空串即清除（分别存 Keystore 密封的 SecretStore，不进设置表）；
     *  - `autoUpdate`：自动检查 + 后台下载开关。
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
        if (
            body.has("giteaUrl") || body.has("giteaRepo") || body.has("authType") ||
            body.has("username") || body.optBoolean("useHub", false)
        ) {
            // 换源/换凭据后旧检查结果不再成立：清掉版本与包，避免拿旧仓库的包去装
            synchronized(lock) {
                latestVersion = null; releaseTag = ""; releaseNotes = ""; assetName = ""; assetUrl = ""
                totalBytes = 0; doneBytes = 0; percentValue = null; checkedAtMs = 0
                if (phase != PHASE_DOWNLOADING) phase = PHASE_IDLE
                errorText = ""
            }
            updatesDir().listFiles()?.forEach { it.delete() }
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
     * 距上次检查没超过 [AppUpdateConfig.CHECK_INTERVAL_MS] 就不重复问远端；上次下载被打断则接着下。
     */
    fun onForeground() {
        cleanupInstalledApks()
        val cfg = config()
        if (!cfg.configured || !cfg.autoUpdate) return
        if (phase == PHASE_CHECKING || phase == PHASE_DOWNLOADING) return
        val fresh = checkedAtMs > 0 && System.currentTimeMillis() - checkedAtMs < AppUpdateConfig.CHECK_INTERVAL_MS
        if (fresh) {
            if (assetUrl.isNotBlank() && readyApk() == null) requestDownload()
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
    fun requestDownload() {
        synchronized(lock) {
            if (phase == PHASE_DOWNLOADING) return
            if (assetUrl.isBlank()) {
                phase = PHASE_ERROR
                errorText = "还没有可下载的安装包，请先检查更新"
                return
            }
            phase = PHASE_DOWNLOADING
            errorText = ""
        }
        Thread({ runDownload() }, "engram-app-update-download").start()
    }

    /** 调起系统安装器；返回 ok/原因（权限缺失、包没下完、不在前台都走这里说清） */
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
        if (!canInstallPackages()) {
            throw IllegalArgumentException("系统还没允许 Engram 安装应用，请先点「去开启安装权限」")
        }
        val uiHost = host ?: throw IllegalArgumentException("请回到 Engram 应用内再点安装")
        if (!uiHost.launchInstaller(apk)) throw IllegalStateException("无法调起系统安装器")
        installLaunched = true
        return JSONObject().put("ok", true).put("apkName", apk.name)
    }

    /** 跳「安装未知应用」授权页（需要 Activity，走 Host） */
    fun openInstallSettings() {
        val uiHost = host ?: throw IllegalArgumentException("请回到 Engram 应用内再点这个按钮")
        uiHost.openInstallPermissionSettings()
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
            synchronized(lock) {
                if (AppUpdatePolicy.hasUpdate(currentVersion(), latestVersion)) {
                    phase = PHASE_IDLE
                } else {
                    phase = PHASE_IDLE
                    errorText = ""
                    latestVersion = null
                    releaseTag = ""
                    releaseNotes = ""
                }
            }
            // 发现新版：自动更新开着就直接后台下载（用户无需盯着，装的时候再点一次确认）
            if (AppUpdatePolicy.hasUpdate(currentVersion(), latestVersion) && config().autoUpdate) requestDownload()
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
            synchronized(lock) {
                phase = PHASE_ERROR
                errorText = describe(error)
            }
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
        }
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
