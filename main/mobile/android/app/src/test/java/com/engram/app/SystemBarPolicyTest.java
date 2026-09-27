package com.engram.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 系统栏策略守卫：insets JSON 的字段名就是网页 `web/src/lib/systemInsets.ts` 的契约，
 * 改字段名必须在两边同时改，否则安卓端安全区会静默失效（内容又钻到状态栏/导航栏底下）。
 */
public class SystemBarPolicyTest {

    @Test
    public void insetsJsonKeepsTheContractWithTheWebLayer() {
        String json = SystemBarPolicy.insetsJson(24, 0, 48, 0, 300, true);
        assertEquals("{\"top\":24,\"right\":0,\"bottom\":48,\"left\":0,\"imeBottom\":300,\"dark\":true}", json);
        for (String key : new String[]{"\"top\"", "\"right\"", "\"bottom\"", "\"left\"", "\"imeBottom\"", "\"dark\""}) {
            assertTrue("缺少字段 " + key + "：网页读不到就会退回 0", json.contains(key));
        }
    }

    @Test
    public void negativeInsetsAreClampedToZero() {
        // 某些 ROM 会给负数 insets：负的 padding 会把内容推出屏幕
        String json = SystemBarPolicy.insetsJson(-5, -1, -100, 0, -2, false);
        assertEquals("{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0,\"imeBottom\":0,\"dark\":false}", json);
    }

    @Test
    public void physicalPixelsAreConvertedToCssPixels() {
        // 实测：折叠屏密度 2.4375 时导航栏是 137 物理 px（= 56 CSS px），状态栏 59 物理 px（= 24 CSS px）。
        // 不换算就会把 137 当成 CSS px，底部让位虚增近 200px（底部导航整条飘到屏幕中间）。
        assertEquals(56, SystemBarPolicy.toCssPx(137, 2.4375f));
        assertEquals(24, SystemBarPolicy.toCssPx(59, 2.4375f));
        // mdpi 密度 1：物理像素就是 CSS 像素
        assertEquals(48, SystemBarPolicy.toCssPx(48, 1f));
        // 密度缺失时不要崩、也不要算出负数
        assertEquals(48, SystemBarPolicy.toCssPx(48, 0f));
        assertEquals(0, SystemBarPolicy.toCssPx(-10, 2f));
    }

    @Test
    public void iconsFollowTheWebThemeNotTheSystem() {
        // 应用内浅色（dark=false）→ 深色图标（light=true）；系统深色而应用浅色时不能反色
        assertTrue(SystemBarPolicy.useLightIcons(false));
        assertFalse(SystemBarPolicy.useLightIcons(true));
    }

    @Test
    public void navigationBarNeedsScrimBelowApi26() {
        // API 23-25 不支持导航栏浅色图标：透明导航栏会变成「深底 + 黑图标」，必须留深色蒙层
        assertTrue(SystemBarPolicy.needsNavigationBarScrim(23));
        assertTrue(SystemBarPolicy.needsNavigationBarScrim(25));
        assertFalse(SystemBarPolicy.needsNavigationBarScrim(26));
        assertFalse(SystemBarPolicy.needsNavigationBarScrim(35));
    }
}
