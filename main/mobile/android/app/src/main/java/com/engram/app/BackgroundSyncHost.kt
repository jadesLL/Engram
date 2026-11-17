package com.engram.app

/**
 * 后台同步权限的宿主接口：只有 Activity 能弹系统权限界面，而本机服务与同步引擎跑在后台线程。
 *
 * MainActivity 实现它并通过 [EngramLocalServer.setBackgroundSyncHost] 挂进来（与 AppUpdater 的 Host
 * 同一套模式）；没有宿主时（服务未就绪 / Activity 已销毁）申请接口退化为 no-op，状态接口照旧告诉界面
 * 「还缺哪枚权限」，不会因此报错。
 */
interface BackgroundSyncHost {
    /** 已在 UI 线程发起申请时返回 true；Activity 不可用返回 false */
    fun requestBackgroundSyncPermissions(): Boolean
}
