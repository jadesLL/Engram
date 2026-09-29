package com.engram.app

import okhttp3.Credentials

/**
 * 安卓端 OTA 更新（APK 在线升级）的纯逻辑与配置——不碰 Android API，可直接 JVM 单测。
 *
 * 为什么安卓端要自己做一套：桌面端能「增量拉源码重建」、Docker 端能「拉镜像换容器」，
 * 唯独手机端只能靠安装包升级（见 docs/ANDROID.md）。信号源沿用服务端与桌面端同一份
 * Gitea Release（附件 `Engram <版本>.apk`），本文件只负责「要不要更新、下载哪个文件、
 * 进度怎么算、私有库凭据头怎么拼」这类可判定的部分；真正的网络、文件与安装动作在 AppUpdater 里。
 */

/**
 * 更新源配置：远端仓库地址 + 私有库凭据方式 + 自动更新开关
 * （非秘密项存本地 settings 表；访问令牌与密码另走 SecretStore 密封保管）。
 *
 * 地址有两个来源，**本机手填优先，其次同步中枢**：
 *  - 本机手填（KEY_URL / KEY_REPO）：用户在这一页自己填的地址；
 *  - 同步中枢下发（KEY_HUB_URL / KEY_HUB_REPO）：多端同步时从中枢学回的「更新源配置」
 *    （服务器/桌面端已经填过的那一份），手机不填也能用，不必每台设备各填一遍。
 * 代码里不预置任何仓库地址：没有手填也没有中枢下发时就是「未配置」，界面引导用户去填。
 *
 * 凭据**不随同步下发**（中枢只给地址）：私有仓库的凭据由各设备自己保管；手机端可在这一页
 * 「访问令牌」或「用户名密码」二选一，与服务器/桌面端「更新源配置」同一套口径。
 */
data class AppUpdateConfig(
    val giteaUrl: String = "",
    val giteaRepo: String = "",
    /** 私有仓库凭据方式：AUTH_TOKEN / AUTH_PASSWORD（与 server 的 RepoAuth.type 同口径） */
    val authType: String = AUTH_TOKEN,
    /** 用户名密码方式的用户名：不是秘密，随设置表明文存；密码仍走 SecretStore */
    val username: String = "",
    /** 回前台自动检查 + 发现新版后台下载（安装那一步始终要用户点系统安装器确认） */
    val autoUpdate: Boolean = true,
    /** 生效的地址来自同步中枢（本机没手填）——界面据此说明「这份地址是哪来的」 */
    val fromHub: Boolean = false,
) {
    /** 公开仓库也能用：地址与 owner/repo 齐了就认为已配置 */
    val configured: Boolean get() = giteaUrl.startsWith("http") && giteaRepo.contains('/')

    companion object {
        /** 本机手填的更新源（优先级最高） */
        const val KEY_URL = "app_update_gitea_url"
        const val KEY_REPO = "app_update_gitea_repo"
        /** 多端同步时从中枢学回的更新源（本机没手填时才生效） */
        const val KEY_HUB_URL = "app_update_hub_url"
        const val KEY_HUB_REPO = "app_update_hub_repo"
        const val KEY_AUTO = "app_update_auto"
        /** 凭据方式与用户名：本机私有库配置，不随同步下发 */
        const val KEY_AUTH_TYPE = "app_update_gitea_auth_type"
        const val KEY_USERNAME = "app_update_gitea_username"
        const val AUTH_TOKEN = "token"
        const val AUTH_PASSWORD = "password"

        /** 回前台自动检查的最小间隔：更勤的检查交给网页侧的退避调度，这里只兜「冷启动 + 回前台」 */
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L

        fun fromSettings(read: (String) -> String?): AppUpdateConfig {
            val localUrl = (read(KEY_URL) ?: "").trim().trimEnd('/')
            val localRepo = (read(KEY_REPO) ?: "").trim().trim('/')
            val hubUrl = (read(KEY_HUB_URL) ?: "").trim().trimEnd('/')
            val hubRepo = (read(KEY_HUB_REPO) ?: "").trim().trim('/')
            // 本机手填要么整份有效要么不生效：只填一半时不做「本机地址 + 中枢仓库名」的拼装
            val hasLocal = localUrl.isNotBlank() && localRepo.isNotBlank()
            val hasHub = hubUrl.isNotBlank() && hubRepo.isNotBlank()
            return AppUpdateConfig(
                giteaUrl = if (hasLocal) localUrl else hubUrl,
                giteaRepo = if (hasLocal) localRepo else hubRepo,
                // 只认这两种取值，其余（含老库没有这个键）一律按访问令牌
                authType = if ((read(KEY_AUTH_TYPE) ?: "").trim() == AUTH_PASSWORD) AUTH_PASSWORD else AUTH_TOKEN,
                username = (read(KEY_USERNAME) ?: "").trim(),
                // 只有显式存过 "0" 才算关闭：老库没有这个键，默认开启（与桌面端自动更新默认一致）
                autoUpdate = read(KEY_AUTO) != "0",
                fromHub = !hasLocal && hasHub,
            )
        }
    }
}

object AppUpdatePolicy {

    /** tag / versionName → 纯数字版本：`v1.3.2` / `1.3.2-local-first-debug` 都得到 `1.3.2` */
    fun normalizeVersion(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        val match = Regex("(\\d+(?:\\.\\d+)*)").find(text) ?: return null
        return match.groupValues[1]
    }

    /**
     * 版本比较：逐段按数值比，缺位补 0（`1.3` == `1.3.0`），返回 <0 表示 a 比 b 旧。
     * 只比数字段——调试包的 `-local-first-debug` 后缀不参与，避免调试包反复被提示「有新版本」。
     */
    fun compare(a: String?, b: String?): Int {
        val left = normalizeVersion(a)?.split('.') ?: return 0
        val right = normalizeVersion(b)?.split('.') ?: return 0
        val size = maxOf(left.size, right.size)
        for (index in 0 until size) {
            val l = left.getOrNull(index)?.toLongOrNull() ?: 0L
            val r = right.getOrNull(index)?.toLongOrNull() ?: 0L
            if (l != r) return if (l < r) -1 else 1
        }
        return 0
    }

    /** 远端版本比本机新才提示更新（相同版本号不提示：调试包与正式包版本号相同属正常） */
    fun hasUpdate(current: String?, latest: String?): Boolean = compare(current, latest) < 0

    /**
     * 从 Release 附件名里挑 APK：只认 `.apk`；同时有多个时优先带 Engram 字样的那个
     * （Release 里还会挂 exe，未签名/调试包也不该被选中）。
     */
    fun pickApkAsset(names: List<String>): String? {
        val apks = names.filter { it.endsWith(".apk", ignoreCase = true) }
        return apks.firstOrNull { it.contains("engram", ignoreCase = true) } ?: apks.firstOrNull()
    }

    /** 下载进度（0-100）；总长未知（无 Content-Length）时返回 null，界面按「已下载多少」显示 */
    fun percent(done: Long, total: Long): Int? {
        if (total <= 0) return null
        if (done <= 0) return 0
        return ((done * 100) / total).toInt().coerceIn(0, 100)
    }

    /** 下载完成校验：远端给了大小就必须一致，否则当作半截包删掉重下 */
    fun downloadComplete(done: Long, total: Long): Boolean = total <= 0 || done == total

    /** 调试包（applicationIdSuffix=.debug）不参与覆盖安装：装了正式包会变成两个 App 并存 */
    fun isDebugVersion(versionName: String?): Boolean = versionName?.contains('-') == true

    /**
     * 私有仓库的 Authorization 头，与 server/src/lib/giteaRelease.ts 的 `repoAuthHeaders` 同一口径：
     *  - 用户名密码方式且用户名、密码都齐 → `Basic base64(用户名:密码)`（UTF-8，与 Node 端一致）；
     *  - 否则有访问令牌 → `token <令牌>`；
     *  - 都没有 → null（公开仓库匿名访问）。
     * 用户名密码方式缺一项时不发半个 Basic 头、退回令牌，避免私有库静默变成匿名访问。
     */
    fun authHeader(authType: String, token: String?, username: String?, password: String?): String? {
        val user = username?.trim().orEmpty()
        val secret = password.orEmpty()
        if (authType == AppUpdateConfig.AUTH_PASSWORD && user.isNotEmpty() && secret.isNotEmpty()) {
            return Credentials.basic(user, secret, Charsets.UTF_8)
        }
        val trimmedToken = token?.trim().orEmpty()
        return if (trimmedToken.isNotEmpty()) "token $trimmedToken" else null
    }

    /**
     * 保存前的凭据校验（界面用）：用户名密码方式必须凑齐用户名与密码——缺一项就发不出 Basic 头，
     * 私有库会退化成匿名访问（表现为 401/404，而不是「凭据没填全」）；访问令牌方式允许留空，
     * 公开仓库不需要凭据。返回 null 表示没问题，否则是给用户看的一句话。
     */
    fun credentialProblem(
        authType: String,
        username: String?,
        passwordInput: String?,
        hasSavedPassword: Boolean,
    ): String? {
        if (authType != AppUpdateConfig.AUTH_PASSWORD) return null
        if (username.isNullOrBlank()) return "选了「用户名密码」就得填用户名"
        if (passwordInput.orEmpty().isEmpty() && !hasSavedPassword) return "选了「用户名密码」还得填密码"
        return null
    }
}
