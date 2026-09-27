package com.engram.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 「侧滑/返回键要当返回用」的守卫：旧实现只问 WebView.canGoBack()，
 * 抽屉、沉浸阅读、弹层都不占历史，于是侧滑直接把应用退到后台。
 */
public class BackPolicyTest {

    @Test
    public void webConsumedKeepsTheLayerInTheApp() {
        // 网页关掉了自己叠出来的那一层：原生什么都不用做
        assertEquals(BackPolicy.Action.WEB, BackPolicy.decide(true, true));
        assertEquals(BackPolicy.Action.WEB, BackPolicy.decide(true, false));
    }

    @Test
    public void fallsBackToHistoryBeforeLeavingTheApp() {
        // 网页没处理，但还有历史：应该是「返回上一页」而不是退到后台
        assertEquals(BackPolicy.Action.HISTORY, BackPolicy.decide(false, true));
    }

    @Test
    public void onlyGoesToBackgroundAtTheHistoryRoot() {
        assertEquals(BackPolicy.Action.BACKGROUND, BackPolicy.decide(false, false));
    }

    @Test
    public void webConsumptionWinsOverHistory() {
        // 回归守卫：抽屉开着又恰好有历史时，不能先去 goBack（那会连页面一起退掉）
        assertTrue(BackPolicy.decide(true, true) != BackPolicy.Action.HISTORY);
        assertFalse(BackPolicy.decide(true, true) == BackPolicy.Action.BACKGROUND);
    }
}
