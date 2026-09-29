package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 安卓端 OTA 的口径回归：版本比较、APK 附件挑选、进度与「调试包不覆盖安装」。
 *
 * 这些判定直接决定手机上会不会提示更新、提示的是哪个包——判错要么永远不提示、
 * 要么把调试包和正式包混着装成两个 App，所以每条都锁死。
 */
class AppUpdatePolicyTest {

    @Test fun normalizesTagAndVersionName() {
        assertEquals("1.3.2", AppUpdatePolicy.normalizeVersion("v1.3.2"))
        assertEquals("1.3.2", AppUpdatePolicy.normalizeVersion("1.3.2-local-first-debug"))
        assertEquals("1.3.2", AppUpdatePolicy.normalizeVersion("  1.3.2  "))
        assertEquals("1.0", AppUpdatePolicy.normalizeVersion("release-1.0"))
        assertNull(AppUpdatePolicy.normalizeVersion(""))
        assertNull(AppUpdatePolicy.normalizeVersion(null))
        assertNull(AppUpdatePolicy.normalizeVersion("latest"))
    }

    @Test fun comparesVersionSegmentsNumerically() {
        assertTrue(AppUpdatePolicy.compare("1.3.2", "1.3.10") < 0)
        assertTrue(AppUpdatePolicy.compare("1.10.0", "1.9.9") > 0)
        assertEquals(0, AppUpdatePolicy.compare("1.3", "1.3.0"))
        assertEquals(0, AppUpdatePolicy.compare("v1.3.2", "1.3.2"))
        assertEquals(0, AppUpdatePolicy.compare("1.3.2-local-first-debug", "1.3.2"))
    }

    @Test fun onlyOffersUpdateWhenRemoteIsNewer() {
        assertTrue(AppUpdatePolicy.hasUpdate("1.3.2", "1.3.3"))
        assertTrue(AppUpdatePolicy.hasUpdate("1.3.2-local-first-debug", "1.4.0"))
        // 调试包与正式包同版本号：不当成「有新版本」，否则正式包会与调试包并存安装
        assertFalse(AppUpdatePolicy.hasUpdate("1.3.2-local-first-debug", "1.3.2"))
        assertFalse(AppUpdatePolicy.hasUpdate("1.3.2", "1.3.2"))
        assertFalse(AppUpdatePolicy.hasUpdate("1.4.0", "1.3.9"))
        assertFalse(AppUpdatePolicy.hasUpdate("1.3.2", null))
    }

    @Test fun picksApkAssetAmongReleaseAssets() {
        assertEquals(
            "Engram 1.3.3.apk",
            AppUpdatePolicy.pickApkAsset(listOf("Engram Setup 1.3.3.exe", "Engram 1.3.3.apk")),
        )
        // 多个 apk 时优先带 Engram 字样的那个（调试包 app-release-unsigned.apk 不优先）
        assertEquals(
            "Engram 1.3.3.apk",
            AppUpdatePolicy.pickApkAsset(listOf("app-debug.apk", "Engram 1.3.3.apk")),
        )
        assertEquals("app-release.apk", AppUpdatePolicy.pickApkAsset(listOf("app-release.apk", "README.md")))
        assertNull(AppUpdatePolicy.pickApkAsset(listOf("Engram Setup 1.3.3.exe", "checksums.txt")))
    }

    @Test fun reportsDownloadPercentOnlyWhenTotalIsKnown() {
        assertEquals(0, AppUpdatePolicy.percent(0, 200))
        assertEquals(50, AppUpdatePolicy.percent(100, 200))
        assertEquals(100, AppUpdatePolicy.percent(200, 200))
        // 超出总长（服务端多给了字节）截到 100，不显示 103%
        assertEquals(100, AppUpdatePolicy.percent(206, 200))
        assertNull(AppUpdatePolicy.percent(1024, 0))
    }

    @Test fun requiresFullSizeWhenAssetSizeIsKnown() {
        assertTrue(AppUpdatePolicy.downloadComplete(200, 200))
        assertTrue(AppUpdatePolicy.downloadComplete(120, 0))
        assertFalse(AppUpdatePolicy.downloadComplete(199, 200))
    }

    @Test fun treatsSuffixedVersionNamesAsDebugBuilds() {
        assertTrue(AppUpdatePolicy.isDebugVersion("1.3.2-local-first-debug"))
        assertFalse(AppUpdatePolicy.isDebugVersion("1.3.2"))
        assertFalse(AppUpdatePolicy.isDebugVersion(null))
    }

    @Test fun readsConfigFromSettingsWithDefaults() {
        val empty = AppUpdateConfig.fromSettings { null }
        assertFalse(empty.configured)
        assertTrue("默认开启自动更新，与桌面端一致", empty.autoUpdate)

        val saved = AppUpdateConfig.fromSettings { key ->
            when (key) {
                AppUpdateConfig.KEY_URL -> "https://gitea.example.com/"
                AppUpdateConfig.KEY_REPO -> "/example/Engram/"
                AppUpdateConfig.KEY_AUTO -> "0"
                else -> null
            }
        }
        assertEquals("https://gitea.example.com", saved.giteaUrl)
        assertEquals("example/Engram", saved.giteaRepo)
        assertFalse(saved.autoUpdate)
        assertTrue(saved.configured)
    }

    @Test fun requiresBothUrlAndRepoToBeConfigured() {
        assertFalse(AppUpdateConfig(giteaUrl = "https://gitea.example.com").configured)
        assertFalse(AppUpdateConfig(giteaRepo = "example/Engram").configured)
        assertFalse(AppUpdateConfig(giteaUrl = "gitea.example.com", giteaRepo = "example/Engram").configured)
        assertTrue(AppUpdateConfig(giteaUrl = "https://gitea.example.com", giteaRepo = "example/Engram").configured)
    }

    /** 更新源地址跟着多端同步走：本机手填优先，没手填就用中枢下发的那份 */
    @Test fun usesHubUpdateSourceWhenLocalIsEmpty() {
        val hubOnly = AppUpdateConfig.fromSettings { key ->
            when (key) {
                AppUpdateConfig.KEY_HUB_URL -> "https://hub.example.com/"
                AppUpdateConfig.KEY_HUB_REPO -> "/example/Engram/"
                else -> null
            }
        }
        assertEquals("https://hub.example.com", hubOnly.giteaUrl)
        assertEquals("example/Engram", hubOnly.giteaRepo)
        assertTrue("地址来自身份是中枢下发", hubOnly.fromHub)
        assertTrue(hubOnly.configured)
    }

    @Test fun localUpdateSourceWinsOverHub() {
        val both = AppUpdateConfig.fromSettings { key ->
            when (key) {
                AppUpdateConfig.KEY_URL -> "https://local.example.com/"
                AppUpdateConfig.KEY_REPO -> "/me/Engram/"
                AppUpdateConfig.KEY_HUB_URL -> "https://hub.example.com"
                AppUpdateConfig.KEY_HUB_REPO -> "example/Engram"
                else -> null
            }
        }
        assertEquals("https://local.example.com", both.giteaUrl)
        assertEquals("me/Engram", both.giteaRepo)
        assertFalse("本机手填时不再算「来自中枢」", both.fromHub)
    }

    @Test fun halfFilledLocalSourceFallsBackToHubInsteadOfMixing() {
        val mixed = AppUpdateConfig.fromSettings { key ->
            when (key) {
                // 只填了地址没填仓库名：不做「本机地址 + 中枢仓库名」的拼装
                AppUpdateConfig.KEY_URL -> "https://local.example.com"
                AppUpdateConfig.KEY_HUB_URL -> "https://hub.example.com"
                AppUpdateConfig.KEY_HUB_REPO -> "example/Engram"
                else -> null
            }
        }
        assertEquals("https://hub.example.com", mixed.giteaUrl)
        assertEquals("example/Engram", mixed.giteaRepo)
        assertTrue(mixed.fromHub)

        // 中枢也没配时：半个本机配置不生效，界面按「未配置」引导用户填
        val halfOnly = AppUpdateConfig.fromSettings { key ->
            if (key == AppUpdateConfig.KEY_URL) "https://local.example.com" else null
        }
        assertFalse(halfOnly.configured)
        assertEquals("", halfOnly.giteaUrl)
    }
}
