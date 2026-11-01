package com.engram.app

import android.util.JsonReader
import android.util.JsonToken
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.InetAddress
import java.net.URLEncoder
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android 成员端一次性同步器。无 SSE、无后台调度：前台事件触发一轮收敛，完成后线程空闲。
 * 退到后台时若还有在途/排队的工作，会走一个最多 5 分钟的宽限（[BackgroundSyncPolicy]），
 * 把这一轮跑完再停，不在后台常驻、不排失败重试。
 * 本地写入先落 SQLite outbox，网络失败或进程退出均可在下次前台继续。
 * 连中枢走 OkHttp + 双栈策略（见 DualStack.kt）：域名同时有 A/AAAA 时先 IPv6，连不上改 IPv4，
 * IPv4 用稳后定期回探一次 IPv6——协议族只在建连时选定，传输途中不换。
 */
class SyncEngine(
    private val db: LocalDatabase,
    private val secrets: SecretStore,
    /** 本机网络状态：判断有没有 IPv6 出口 + 网络切换时通知重探（纯逻辑，JVM 单测可注入假实现） */
    private val network: Ipv6Outlet? = null,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val fetchExecutor = Executors.newFixedThreadPool(MAX_PARALLEL_FETCHES)
    private val activeCalls = ConcurrentHashMap.newKeySet<Call>()
    /**
     * 客户端按「设置里的连接超时」懒构建（见 clientsFor）：三个客户端共用一套超时，只有 DNS 解析不同，
     * v6/v4 各自只解析出选定协议族的地址，切族不打断在途传输；plain 用于策略关闭 / 解析不出地址的场景，
     * 保持历史行为（系统默认排序）。
     */
    private val running = AtomicBoolean(false)
    private val requestWhileRunning = AtomicBoolean(false)
    private val fullRequestWhileRunning = AtomicBoolean(false)
    /**
     * 失败后的自动重试表：前台拿着手机时网络瞬断，原来要等用户下一次编辑/切前后台才会再同步，
     * 「改了不同步」且界面只会停在「同步中断」。这里按指数退避重试（15s 起、10 分钟封顶）。
     * 守护线程——只有正在重试时才存在，不会拖住进程退出。
     */
    private val retryScheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "engram-sync-retry").apply { isDaemon = true }
    }
    @Volatile private var retryFuture: ScheduledFuture<*>? = null
    @Volatile private var retryAttempt = 0
    /**
     * 退到后台后继续完成同步的宽限截止时刻（0 = 没有宽限）：从 onBackground 起算，最多
     * [BackgroundSyncPolicy.GRACE_MS]（5 分钟）。宽限只用来把已经在跑 / 已排队的工作跑完，
     * 不接受前台 UI 的新触发；到期立即取消在途请求，回到「待回前台继续」。
     */
    @Volatile private var backgroundGraceDeadline = 0L
    /** 宽限到期收尾任务：挂在 retryScheduler 上，与失败退避互不影响 */
    @Volatile private var backgroundGraceFuture: ScheduledFuture<*>? = null
    @Volatile private var foreground = false
    @Volatile private var cancelled = false
    @Volatile var connected = false; private set
    @Volatile var lastError: String? = null; private set
    @Volatile var lastSyncAt: String? = db.setting("sync_last_at"); private set
    @Volatile var pendingPulls: Int = 0; private set
    @Volatile var syncProgress: String = ""; private set
    /** 本轮同步真正落地/送出的改动条数（推 + 拉），只用于结尾那条汇总 */
    private var roundChanges = 0
    /**
     * 上次成功全量对账的时刻（周期自愈节流用）。
     *
     * 桌面 / Docker 成员端有 15 分钟一次的周期自愈对账（server/src/sync/client.ts 的
     * HEAL_INTERVAL_MS），手机端原来只有前台事件触发的一轮同步、没有自愈——改名 / 移动 /
     * 删除这类「没有内容 op」的缺口就永远补不上（用户现象：电脑上改过名的原始资料，
     * 手机上一直停在旧路径；日志里反复出现「中枢已无此内容」）。
     */
    private val healAtSetting = "sync_heal_at"
    /** 本轮已因「中枢已无此内容」记过日志的路径：改名后旧 op 会连片回放，同一路径只记一条 */
    private val missingLogged = mutableSetOf<String>()
    /** 本轮因「中枢已无此内容」跳过的条数：结尾汇总一条，别逐条刷屏 */
    private var missingSkipped = 0
    /** 本轮有推送项失败（逐项容错后的标记）：结束时走退避重试，不因它空转重开整轮 */
    @Volatile private var pushDeferred = false

    /**
     * ── 连接通道择优：局域网 → IPv6 → IPv4（都不通即「已断开」）────────────────────
     *
     * 与 desktop / Docker 端 server/src/sync/client.ts 同一套口径：中枢在 /api/sync/announce 里
     * 通告自己的内网地址，成员端把「内网地址 + 中枢主地址」排成候选逐个探测，第一个通的作为当前
     * 通道。家里/公司同网段自动走内网直连（低延迟、不占公网），出门自动回到主地址再按双栈选族；
     * **探不到局域网时行为与历史版本完全一致**。通道现状经 /api/sync/status 的 link 字段给界面，
     * 侧栏状态胶囊与设置页「局域网优先」都读它。
     */
    private val linkProbeMinIntervalMs = 20_000L
    /** 健康期间的定期复探：从公司回到家、或局域网恢复后要能自动升回局域网 */
    private val linkReprobeIntervalMs = 10 * 60_000L
    /** 局域网候选是 IP 字面量，不可路由地址通常毫秒级失败，1.5 秒硬超时足够 */
    private val linkProbeLanTimeoutMs = 1500L
    private val linkLanUrlsSetting = "sync_lan_urls"
    private val linkPreferLanSetting = "sync_prefer_lan"
    private val deviceLabelSetting = "sync_device_label"
    /** 上次核对「已提炼」标记的时刻（节流用；与内容同步的 lastSyncAt 分开记） */
    private val ledgerMarksAtSetting = "sync_ledger_marks_at"
    /** 中枢的灵感提炼队列状态（`/api/sync/distilled` 的 pending/failed），供 `/api/jobs` 桩按 job 形状发出 */
    private val ideaDistillPendingSetting = "sync_idea_distill_pending"
    private val ideaDistillFailedSetting = "sync_idea_distill_failed"
    /** 前台同步很频繁，标记核对默认每 5 分钟一次（手动全量对账不受此限） */
    private val ledgerMarksIntervalMs = 5 * 60_000L

    /** 当前实际在用的基地址；null = 还没择优过，按配置的中枢地址走 */
    @Volatile private var activeBase: String? = null
    @Volatile private var linkCandidates: List<SyncLink.Candidate> = emptyList()
    @Volatile private var linkChannel: String = SyncLink.CHANNEL_OFFLINE
    @Volatile private var linkLatencyMs: Long? = null
    @Volatile private var linkSince: String? = null
    @Volatile private var linkProbedAt: String? = null
    private var lastProbeRoundAt = 0L
    private var forceProbe = false
    /** 网络切换重置的节流：系统回调常连发（available + capabilities + linkProperties） */
    private var lastNetworkResetAt = 0L
    /** 上一轮探测绑定的中枢地址：改绑定后不能拿旧中枢的内网地址去连新中枢 */
    private var probeBoundHub: String? = null
    private var announcedLanCache: List<String>? = null
    /** 本端不认识的同步类型（每种只记一条，避免刷屏） */
    private val unknownKinds = mutableSetOf<String>()
    /** 中枢还没有连接通告端点时只提醒一条，别每轮刷屏 */
    private var announceMissingLogged = false
    /** 中枢还没有「已提炼标记」端点（旧中枢）时只记一条 */
    private val marksEndpointMissing = AtomicBoolean(false)

    fun onForeground() {
        // 回前台优先于后台宽限：清掉宽限计时器；在途请求不用打断，本轮结束后按前台规则继续。
        clearBackgroundGrace()
        foreground = true
        cancelled = false
        request(false)
    }

    /**
     * 进入后台：以前是立刻取消在途请求；现在若还有没跑完的同步（正在跑 / 待推队列 / 已排队的
     * 下一轮），给它一个最多 5 分钟的宽限把成果落完再停，避免「刚改完切到别的 App 就断」。
     * 宽限内不新增失败重试；窗口到期（或这一轮收敛完 / 失败）立即收尾，待推队列留在 SQLite。
     */
    fun onBackground() {
        foreground = false
        connected = false
        val syncReady = db.setting("sync_role") == "member" && db.setting("sync_enabled") == "1"
        val hasWork = BackgroundSyncPolicy.shouldStartGrace(
            foreground = false,
            memberEnabled = syncReady,
            running = running.get(),
            pendingOutbox = db.outboxCount(),
            rerunQueued = requestWhileRunning.get(),
        )
        if (hasWork) startBackgroundGrace() else cancelActiveWork()
    }

    /** 没有可继续的工作（或同步未启用）：与旧行为一致，立刻停 */
    private fun cancelActiveWork() {
        cancelled = true
        clearBackgroundGrace()
        cancelPendingRetry() // 后台不排重试：省电，回到前台由事件触发
        activeCalls.forEach { it.cancel() }
    }

    private fun startBackgroundGrace() {
        cancelled = false
        backgroundGraceDeadline = BackgroundSyncPolicy.deadlineFrom(System.currentTimeMillis())
        db.log("info", "bg-sync-grace", "应用已进入后台：继续完成本轮同步（最多 5 分钟）")
        scheduleBackgroundGraceEnd(backgroundGraceDeadline)
        // 刚写完就切走（请求已排队但还没开跑）：后台把它推完；已经在跑就等这一轮自己收敛
        if (!running.get()) request(false)
    }

    private fun scheduleBackgroundGraceEnd(deadline: Long) {
        backgroundGraceFuture?.cancel(false)
        val delay = (deadline - System.currentTimeMillis()).coerceAtLeast(0L)
        backgroundGraceFuture = try {
            retryScheduler.schedule({ expireBackgroundGrace() }, delay, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            null // 调度器已关闭（进程收尾）：等下次前台事件
        }
    }

    /** 宽限到期：取消在途请求与排队重试，状态回到「已暂停，待下次继续」 */
    private fun expireBackgroundGrace() {
        if (foreground) return
        clearBackgroundGrace()
        cancelled = true
        connected = false
        cancelPendingRetry()
        activeCalls.forEach { it.cancel() }
        syncProgress = "已暂停，待下次继续"
        db.log("info", "sync-paused", "后台同步宽限结束（最多 5 分钟）：已暂停，回前台继续")
    }

    /** 宽限内这一轮已收敛且没有待推工作：提前收尾，不空等到期 */
    private fun finishBackgroundGrace() {
        if (foreground) return
        clearBackgroundGrace()
        db.log("info", "bg-sync-grace-done", "后台同步已完成：宽限提前结束")
    }

    /** 后台宽限内失败：不排退避重试（省电），保留 lastError / 同步中断状态供回前台查看 */
    private fun failBackgroundGrace() {
        if (foreground) return
        clearBackgroundGrace()
        cancelled = true
        connected = false
        cancelPendingRetry()
        activeCalls.forEach { it.cancel() }
    }

    private fun clearBackgroundGrace() {
        backgroundGraceDeadline = 0L
        backgroundGraceFuture?.cancel(false)
        backgroundGraceFuture = null
    }

    /** 是否处在退到后台后的宽限窗口内 */
    private fun inBackgroundGrace(): Boolean =
        BackgroundSyncPolicy.inGrace(System.currentTimeMillis(), backgroundGraceDeadline)

    /** 允许同步工作继续：前台，或退到后台后的有限宽限窗口内 */
    private fun workAllowed(): Boolean = foreground || inBackgroundGrace()

    fun request(full: Boolean) {
        if (!workAllowed() || db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return
        // 已经要开跑了：撤掉排队中的重试，免得这一轮刚成功又被上一次的退避再拉起来一轮
        cancelPendingRetry()
        if (!running.compareAndSet(false, true)) {
            requestWhileRunning.set(true)
            if (full) fullRequestWhileRunning.set(true)
            return
        }
        executor.execute {
            var completed = false
            roundChanges = 0
            missingLogged.clear()
            missingSkipped = 0
            pushDeferred = false
            try {
                db.log("info", "start", if (full) "手动全量对账" else "事件触发同步")
                syncProgress = "正在连接中枢"
                // 先择优一条路（局域网优先），再开始同步：否则首轮会先绕一次公网才发现内网可直连
                maybeProbeLink()
                val cursor = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
                if (cursor <= 0L) {
                    // 首次绑定直接按轻量清单逐项对账，避免从游标 0 一次解析数百条内嵌正文的历史 op。
                    // 对账完成后推进到快照水位，再由 converge 补拉其后发生的少量变化。
                    reconcile(preferHub = true, advanceCursor = true)
                    markReconciled()
                } else if (full) {
                    reconcile()
                    markReconciled()
                } else if (SyncHealPolicy.due(System.currentTimeMillis(), lastHealAt(), cursor)) {
                    // 周期自愈：与桌面 / Docker 成员端 15 分钟一轮同一口径，只是挂在「前台有同步」
                    // 这个时机上，不额外起后台定时器。补的正是增量 op 表达不了的那部分：
                    // 改名 / 移动 / 删除后本机残留的旧路径、以及旧 op 回放时 404 被跳过的内容。
                    syncProgress = "正在核对中枢目录"
                    reconcile()
                    markReconciled()
                }
                syncPreferences()
                converge()
                try {
                    refreshLedgerMarks(force = full)
                } catch (e: Cancelled) {
                    throw e
                } catch (e: Exception) {
                    // 标记没对齐不该把整轮同步判失败：内容已经落地，下一轮再试
                    db.log("warn", "ledger-marks-failed", "已提炼标记没能对齐：${e.message ?: e.javaClass.simpleName}（下一轮再试）")
                }
                if (missingSkipped > 1) {
                    // 逐条已经按路径去重并写明原因，这里再收一条总数，让用户知道「不是卡住」而是旧路径被跳过
                    db.log("info", "pull-missing-summary", "本轮跳过 $missingSkipped 项中枢已不存在的内容（多为改名 / 删除后的旧路径），已安排下一次全量对账补齐")
                }
                connected = true
                lastError = null
                retryAttempt = 0
                lastSyncAt = Instant.now().toString().also { db.setSetting("sync_last_at", it) }
                syncProgress = "同步完成"
                // 结尾这条要说清「这轮到底动了什么」：没改动也明说，别让用户对着空白记录猜
                db.log("info", "sync-done", if (roundChanges > 0) "同步已收敛（本轮落地 $roundChanges 项改动）" else "同步已收敛（本轮无改动）")
                completed = true
            } catch (e: Cancelled) {
                syncProgress = "已暂停，待下次继续"
                db.log("info", "sync-paused", "应用已进入后台，待下次继续")
            } catch (e: Exception) {
                connected = false
                lastError = e.message ?: e.javaClass.simpleName
                syncProgress = "同步中断"
                db.log("warn", "sync-failed", lastError ?: "同步失败")
            } finally {
                pendingPulls = 0
                running.set(false)
                val rerun = requestWhileRunning.getAndSet(false)
                val rerunFull = fullRequestWhileRunning.getAndSet(false)
                // 失败后保留持久化 outbox，等退避重试或下次前台事件。
                // 不因队列仍非空就立即递归重试：离线时那会形成无限请求与日志风暴。
                val active = workAllowed() && !cancelled
                val remaining = db.outboxCount() > 0
                if (completed && active && pushDeferred && remaining) {
                    // 逐项容错后仍有项没推上去：其余项已经推完，这一项按退避重试，
                    // 别立刻重开整轮空转（也避免把「有改动」队列烧成日志风暴）。
                    lastError = "有改动暂未推送成功（详见同步详情）"
                    if (foreground) scheduleRetry("有改动暂未推送成功") else failBackgroundGrace()
                } else if (completed && active && (rerun || remaining)) {
                    request(rerunFull)
                } else if (!completed && active) {
                    // 失败后的自动退避重试（见 retryScheduler 注释）：只有前台、未取消才排期，
                    // 后台/离线的重试没有意义——省电，也让「同步中断」保持诚实。
                    // 具体原因已在 catch 里记进 lastError 与同步日志，这里不重复传。
                    if (foreground) scheduleRetry() else failBackgroundGrace()
                } else if (completed && !foreground && !cancelled && inBackgroundGrace() &&
                    !rerun && !remaining
                ) {
                    // 宽限内这一轮已收敛且没有待推工作：提前结束宽限，别空等满 5 分钟
                    finishBackgroundGrace()
                }
            }
        }
    }

    /** 失败后的指数退避重试：15s、30s、60s…最多 10 分钟一次，成功后由 request() 归零 */
    private fun scheduleRetry(prefix: String? = null) {
        val attempt = retryAttempt.coerceAtMost(6)
        retryAttempt = attempt + 1
        val delayMs = (15_000L shl attempt).coerceAtMost(10 * 60_000L)
        val reason = prefix ?: "同步中断"
        syncProgress = "$reason，${delayMs / 1000} 秒后自动重试"
        retryFuture?.cancel(false)
        retryFuture = try {
            retryScheduler.schedule({ request(false) }, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            null // 调度器已关闭（进程收尾）：不排期，等下次前台事件
        }
    }

    private fun cancelPendingRetry() {
        retryFuture?.cancel(false)
        retryFuture = null
    }

    fun isRunning() = running.get()

    /**
     * 换中枢 / 重新配对 / 恢复备份后必须把增量游标归零。
     *
     * 游标是本端对「某个中枢的事件序号」的记忆，序号只在同一个中枢内可比。绑到别处（或备份把本地库
     * 换掉）后仍拿旧游标去问 `changes?since=`，新中枢只会回 0 条；而本端推送又因 base_revision 高于
     * 新中枢当前值走「直接覆盖」分支——结果是旧中枢的内容显示着、新中枢的内容被顶掉，且没有任何
     * 报错。归零后下一轮按轻量清单做一次全量对账，内容与账本都能重新对齐。
     */
    fun resetCursor(reason: String) {
        val previous = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
        if (previous <= 0L) return
        db.setSetting("sync_cursor", "0")
        // 标记核对的节流时刻一起归零：换中枢后要立刻重新核对「已提炼」标记，不能等 5 分钟窗口
        db.setSetting(ledgerMarksAtSetting, "0")
        // 自愈对账也归零：新中枢的目录必须马上核一遍，不能等 15 分钟周期
        db.setSetting(healAtSetting, "0")
        db.log("info", "sync-cursor-reset", "$reason：增量游标已归零（$previous → 0），下次同步按全量对账重新对齐")
    }

    /** 上次成功全量对账的时刻（0 = 从未跑过 → 下一次前台同步立即自愈一轮） */
    private fun lastHealAt(): Long = db.setting(healAtSetting)?.toLongOrNull() ?: 0L

    /** 记下「刚刚成功做过全量对账」：周期自愈从这里重新计时 */
    private fun markReconciled() = db.setSetting(healAtSetting, System.currentTimeMillis().toString())

    private fun checkActive() { if (cancelled || !workAllowed()) throw Cancelled() }

    private fun converge() {
        repeat(4) {
            checkActive()
            syncProgress = "正在补齐改动"
            pushOutbox()
            val changed = pullChanges()
            if (db.outboxCount() == 0 && !changed) return
            // 有推送项失败：已经拉过一轮，剩下的交给本轮结束时的退避重试，
            // 别在同一轮里反复重撞同一个坏项（会刷日志也拖慢整轮）
            if (pushDeferred) return
        }
    }

    /**
     * 把中枢的「已提炼」标记对齐到本机。
     *
     * 标记只存在于账本（source_versions / page_contributions）里，**没有对应的同步 op**：
     * 不走一次全量对账就永远学不到。桌面 / Docker 成员端有周期自愈对账兜底，手机端只有前台
     * 事件触发的一轮同步——首轮绑定时的全量对账只覆盖「那一刻」的标记，中枢之后新提炼的资料
     * 在手机上就一直不带「已提炼」（用户看到：电脑上标了，手机没标）。
     *
     * 这里按中枢的轻量标记清单（`/api/sync/distilled`，只回路径）比一次差集，只对差异项拉
     * `/api/sync/evidence`：既不必为几个标记把整份清单（每条路径 + hash）拉下来，也能把标记
     * 取消（中枢那边来源版本不再是 active）照样收回来。
     *
     * 节流：前台同步很频繁，默认每 5 分钟最多查一次；手动全量对账（force）强制查。
     */
    private fun refreshLedgerMarks(force: Boolean) {
        val now = System.currentTimeMillis()
        val last = db.setting(ledgerMarksAtSetting)?.toLongOrNull() ?: 0L
        if (!force && now - last < ledgerMarksIntervalMs) return
        checkActive()
        syncProgress = "正在核对已提炼标记"
        val response = try {
            getJson("/api/sync/distilled")
        } catch (error: Exception) {
            // 中枢比本端旧（没有这个端点）：不必每轮重试，记一条并说明兜底路径
            if (error.message?.contains("404") == true) {
                if (marksEndpointMissing.compareAndSet(false, true)) {
                    db.log(
                        "info",
                        "ledger-marks-unsupported",
                        "中枢还没有「已提炼标记」接口，标记要等下一次全量对账才能补齐",
                    )
                }
                db.setSetting(ledgerMarksAtSetting, now.toString())
                return
            }
            throw error
        }
        db.setSetting(ledgerMarksAtSetting, now.toString())
        // 顺带收下中枢的灵感提炼队列状态（pending/failed 路径）：手机的 /api/jobs 是空桩，
        // 侧栏「提炼中 / 提炼失败」徽标就靠这份清单（与标记清单同一个成员可访问端点，不多打一次请求）
        saveIdeaDistillStatus(response)
        val raw = response.optJSONArray("paths") ?: return
        val hub = LinkedHashSet<String>()
        for (i in 0 until raw.length()) raw.optString(i).takeIf { it.isNotBlank() }?.let(hub::add)
        val plan = LedgerMarks.plan(hub, db.distilledPaths())
        if (!plan.changed) return
        for (path in plan.add) {
            if (!SyncPreferences(db).allowed("file", path)) continue
            checkActive()
            // 账本能就近补上就一起补（证据抽屉要能复核）；取不回来时只打标记，不假装有账本
            val snapshot = try {
                getJson("/api/sync/evidence?path=${encode(path)}").optJSONObject("snapshot")
            } catch (error: Cancelled) {
                throw error
            } catch (_: Exception) {
                null
            }
            if (snapshot != null) db.saveEvidence(path, snapshot) else db.markDistilled(path, true)
        }
        for (path in plan.clear) if (SyncPreferences(db).allowed("file", path)) db.markDistilled(path, false)
        roundChanges += plan.add.size + plan.clear.size
        db.bumpContentRevision()
        db.log(
            "info",
            "ledger-marks",
            "已提炼标记已对齐：新增 ${plan.add.size} 项、取消 ${plan.clear.size} 项",
            toJson(mapOf("paths" to (plan.add + plan.clear).take(20), "added" to plan.add.size, "cleared" to plan.clear.size)),
        )
    }

    private fun syncPreferences() {
        val prefs = SyncPreferences(db)
        if (!prefs.allowed("preference", "home_layout") && !prefs.allowed("preference", "search_synonyms")) return
        val remote = tolerateMissing { getJson("/api/sync/preferences").optJSONObject("preferences") } ?: return
        for (key in SyncPreferences.keys) {
            if (!prefs.allowed("preference", key)) continue
            val local = prefs.value(key)
            val incoming = remote.optJSONObject(key)
            prefs.merge(key, incoming)
            if (local != null && prefs.wins(local, incoming)) db.enqueue("preference", key)
        }
    }

    private fun pushOutbox() {
        for (item in db.outbox()) {
            checkActive()
            try {
                pushItem(item)
            } catch (e: Cancelled) {
                throw e
            } catch (error: Exception) {
                // 逐项容错：一条推不上去的改动不能把后面所有本机改动堵在队首（否则整轮永远卡在
                // 同一项，用户看到的就是「部分内容一直没上去」且同步中断）。本项留在 outbox 等
                // 退避重试，其余项继续推。
                pushDeferred = true
                val path = item.optString("target")
                db.log(
                    "warn",
                    "push-failed",
                    "「$path」没能推送：${error.message ?: error.javaClass.simpleName}（其余改动继续，稍后自动重试）",
                    toJson(mapOf("kind" to item.optString("kind"), "path" to path)),
                )
            }
        }
    }

    /** 推送 outbox 里的单项；异常交给 [pushOutbox] 逐项兜住（不拖累后面的项） */
    private fun pushItem(item: JSONObject) {
        val kind = item.getString("kind")
        val target = item.getString("target")
        if (!SyncPreferences(db).allowed(kind, target, item.optString("old_path"))) {
            db.ackOutbox(item.getLong("id")); return
        }
        when (kind) {
            "preference" -> {
                val prefs = SyncPreferences(db)
                prefs.value(target)?.let { value ->
                    val ack = postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", kind).put("target", target).put("preference", value))
                    prefs.merge(target, ack.optJSONObject("preference"))
                }
            }
            "page" -> {
                val raw = db.rawPage(target)
                if (raw == null) { db.ackOutbox(item.getLong("id")); return }
                val payload = JSONObject()
                    .put("node_id", nodeId()).put("kind", "page").put("target", target)
                    .put("base_revision", db.pageRevision(target)).put("content", raw)
                    .put("mtime", db.file(target).lastModified())
                db.evidence(target)?.let { payload.put("evidence", it) }
                val ack = postJson("/api/sync/push", payload)
                if (pushSkipped(ack)) { recordPushSkipped(item, kind, target); return }
                val revision = ack.optInt("revision")
                val authoritative = ack.optString("content", raw)
                db.writeSyncedPage(target, authoritative, revision)
                recordPush("push-page", SyncOpText.KIND_PAGE, target, null, authoritative.toByteArray(Charsets.UTF_8).size.toLong(), revision)
                // 本端内容与中枢回执不同 = 中枢做过合并：本端已被写回，日志里必须有一句解释
                if (authoritative != raw) recordPushMerged(target, ack, raw, authoritative, revision)
            }
            "file" -> {
                val file = db.file(target)
                if (!file.exists()) { db.ackOutbox(item.getLong("id")); return }
                val ack = postFile(target, file)
                if (pushSkipped(ack)) { recordPushSkipped(item, kind, target); return }
                recordPush("push-file", SyncOpText.KIND_FILE, target, null, file.length(), ack.optInt("revision"))
            }
            "delete" -> {
                val ack = postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", "delete").put("target", target))
                if (pushSkipped(ack)) { recordPushSkipped(item, kind, target); return }
                if (ack.optLong("seq") <= 0L) {
                    // 中枢本来就没有这个路径（成员删的是本机独有的副本）：删除目的已经达到，
                    // 记 info 而不是失败——旧逻辑会把它记成「失败 · 该同步分类可能已关闭」。
                    db.log("info", "push-delete-noop", "「$target」中枢本就没有，删除已视为完成", toJson(mapOf("kind" to kind, "path" to target)))
                } else {
                    recordPush("push-delete", SyncOpText.KIND_DELETE, target, null, 0L, ack.optInt("revision"))
                }
            }
            "move" -> {
                val oldPath = item.optString("old_path")
                val ack = postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", "move").put("target", target).put("old_path", oldPath))
                if (pushSkipped(ack)) { recordPushSkipped(item, kind, target); return }
                recordPush("push-move", SyncOpText.KIND_MOVE, target, oldPath, 0L, ack.optInt("revision"))
            }
        }
        db.ackOutbox(item.getLong("id"))
    }

    /**
     * 中枢按同步分类拒收：HTTP 200 但 seq/revision 都是 0（server 端 applyPush 的 syncAllowed 分支，
     * 新版还会带 skipped:true）。这类回执**不能**当成成功把 revision 写回本地——写 0 会把 base_revision
     * 抹掉，下次推送找不到共同祖先，退化成按 mtime 裁决并生成「xxx-时间戳.md」冲突副本。
     *
     * 例外：「中枢本来就没有这个路径」的 delete 回执（hub applyPush 的 delete 分支）同样是 seq 0，
     * 但带 merge 字段、没有 skipped——那是「没东西可删，删除目的已达」，不能算失败，否则界面会
     * 把一次正常删除记成「失败 · 该同步分类可能已关闭」（实测误导用户）。
     */
    private fun pushSkipped(ack: JSONObject): Boolean =
        ack.optBoolean("skipped", false) ||
            (ack.optLong("seq") <= 0L && ack.optInt("revision") <= 0 && !ack.has("merge"))

    /** 中枢不收这一项：本机内容保留、outbox 出队（留着会被 finally 判成「还有改动」而无限重跑），加一条 warn 可查 */
    private fun recordPushSkipped(item: JSONObject, kind: String, target: String) {
        db.ackOutbox(item.getLong("id"))
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(target)}」" else "「$target」"
        db.log(
            "warn",
            "push-skipped",
            "$subject 中枢未接收（该同步分类可能已在中枢关闭），本机改动已保留、未写入同步基线",
            toJson(mapOf("kind" to kind, "path" to target)),
        )
    }

    /** 返回本轮是否应用了远端 op。 */
    private fun pullChanges(): Boolean {
        var any = false
        var gap = false
        while (true) {
            checkActive()
            val cursor = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
            val response = try {
                getJson("/api/sync/changes?since=$cursor&limit=$CHANGE_BATCH&compact=1")
            } catch (_: JsonResponseTooLarge) {
                // 旧中枢会忽略 limit/compact，历史正文可能远超手机堆。改走逐项全量对账，
                // 完成后推进快照水位；本地已同步后的修改仍按既有冲突规则保留。
                db.log("warn", "changes-too-large", "增量批次过大，已切换全量对账")
                reconcile(advanceCursor = true)
                return true
            }
            gap = gap || response.optBoolean("resync")
            val ops = response.optJSONArray("ops") ?: JSONArray()
            val compact = response.optBoolean("compact")
            val batch = (0 until ops.length()).map { ops.getJSONObject(it) }
            for (chunk in batch.chunked(MAX_PARALLEL_FETCHES)) {
                val work = chunk.map { op ->
                    val kind = op.optString("kind")
                    val target = op.optString("target")
                    when {
                        !SyncPreferences(db).allowed(kind, target, op.optString("old_path")) -> ChangeWork(op = op)
                        // 中枢在 compact 回放里标了 missing：这份路径已经不存在（改名 / 删除后的旧 op），
                        // 不必再打一次注定 404 的请求（补积压时可能有几百条）
                        kind == "page" && compact && op.optBoolean("missing") -> ChangeWork(op = op, missing = true)
                        kind == "page" && compact -> ChangeWork(
                            op = op,
                            page = fetchExecutor.submit<PagePayload?> {
                                // 中枢已经没有这份（oplog 里的旧 op 滞后于改名/删除）：null，绝不拖死整轮
                                tolerateMissing {
                                    val content = getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                                    val evidence = getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                                    PagePayload(content, evidence)
                                }
                            },
                        )
                        kind == "file" -> ChangeWork(op = op, file = fetchExecutor.submit<File?> { tolerateMissing { stageFile(target) } })
                        else -> ChangeWork(op = op)
                    }
                }
                try {
                    for (item in work) {
                        checkActive()
                        try {
                            if (item.missing) {
                                skipMissingOp(item.op)
                                any = true
                                continue
                            }
                            val page = item.page?.let(::await)
                            val file = item.file?.let(::await)
                            // 取不回来（中枢 404）说明这份已经被改名/删除：跳过它、推进水位，
                            // 否则这条永远取不回的 op 会让每一轮同步都在这里失败（实测卡死过）
                            if ((item.page != null && page == null) || (item.file != null && file == null)) {
                                skipMissingOp(item.op)
                                any = true
                                continue
                            }
                            applyOp(item.op, compact, page, file)
                            any = true
                        } catch (e: Cancelled) {
                            throw e
                        } catch (error: Exception) {
                            // 单条变更应用失败（路径被占用、写盘异常等）不能卡住整轮：记一条、
                            // 推进水位，内容交给下一次全量对账再核（与桌面 client 的 itemFailed 同口径）。
                            db.log(
                                "warn",
                                "pull-op-failed",
                                "应用中枢变更「${item.op.optString("target")}」失败：${error.message ?: error.javaClass.simpleName}（已跳过，下次全量对账再核对）",
                                toJson(mapOf("kind" to item.op.optString("kind"), "path" to item.op.optString("target"))),
                            )
                            db.setSetting("sync_cursor", item.op.optLong("seq").toString())
                            db.setSetting(healAtSetting, "0")
                            any = true
                        }
                    }
                } finally {
                    work.forEach { item ->
                        item.page?.let(::cancelFetch)
                        item.file?.let(::discardStagedFile)
                    }
                }
            }
            if (ops.length() < CHANGE_BATCH) break
        }
        if (gap) {
            reconcile()
            markReconciled()
        }
        return any
    }

    private fun applyOp(op: JSONObject, compact: Boolean = false, page: PagePayload? = null, stagedFile: File? = null) {
        val seq = op.optLong("seq")
        val cursor = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
        if (seq <= cursor) return
        val target = op.optString("target")
        val kind = op.optString("kind")
        if (!SyncPreferences(db).allowed(kind, target, op.optString("old_path"))) {
            stagedFile?.delete()
            db.setSetting("sync_cursor", seq.toString()); return
        }
        when (kind) {
            "preference" -> SyncPreferences(db).merge(target, op.optJSONObject("preference"))
            "page" -> {
                // 本机还有没推出去的改动：先别覆盖（见 hasPendingOutbox 注释），
                // 本轮 converge() 会先推送、由中枢合并，权威正文再随回执写回来
                if (db.hasPendingOutbox(target)) {
                    stagedFile?.delete()
                    recordLocalEditWins("page", target)
                    db.setSetting("sync_cursor", seq.toString())
                    return
                }
                val content = if (compact) {
                    page?.content ?: getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                } else op.optString("content")
                // 先取旧正文，才写得清「改了多少行」——同步记录里这句就是用户要的「具体改了什么」
                val before = db.rawPage(target)
                db.writeSyncedPage(target, content, op.optInt("revision"))
                val evidence = if (compact) {
                    page?.evidence ?: getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                } else op.optJSONObject("evidence")
                evidence?.let { db.saveEvidence(target, it) }
                recordApplied("pull-page", SyncOpText.summarizePage(target, before, content))
            }
            "file" -> {
                if (db.hasPendingOutbox(target)) {
                    stagedFile?.delete()
                    recordLocalEditWins("file", target)
                    db.setSetting("sync_cursor", seq.toString())
                    return
                }
                val beforeBytes = db.file(target).let { if (it.exists()) it.length() else 0L }
                val staged = stagedFile ?: stageFile(target)
                val afterBytes = staged.length()
                try { db.installSyncedFile(target, staged) } finally { staged.delete() }
                recordApplied("pull-file", SyncOpText.summarizeFile(target, beforeBytes, afterBytes))
            }
            "delete" -> {
                val existing = db.file(target)
                val beforeBytes = if (existing.exists()) existing.length() else 0L
                db.deleteSyncedPath(target)
                recordApplied("pull-delete", SyncOpText.summarizeDelete(target, beforeBytes, target.endsWith(".md", true)))
            }
            "move" -> {
                val oldPath = op.optString("old_path")
                val sourceExisted = runCatching { db.file(oldPath).exists() }.getOrDefault(false)
                db.moveSyncedPath(oldPath, target, op.optInt("revision"))
                if (!sourceExisted && !db.file(target).exists()) {
                    // 本机漏掉了改名前的旧内容（旧 op 回放时 404 被跳过）：这条 move 在本地是空操作，
                    // 必须按新路径直接把内容补下来，否则改名后的页面/文件在手机上永远不落地
                    // （实测：原始资料在中枢改名后，手机一直缺这份，只在手动全量对账后才出现）。
                    pullMovedTarget(op, target)
                } else {
                    recordApplied("pull-move", SyncOpText.summarizeMove(oldPath, target))
                }
            }
            // 会话 / 看板 / 客户调研：手机端不存本地副本，读写都经窄代理走已绑定的中枢（见 AgentBridge），
            // 所以这里是「已知但不镜像」——跳过内容，水位照常推进，别让水位卡在这几类 op 上。
            "session", "board", "research" -> Unit
            else -> {
                // 协议比本端新：既不能瞎套页面逻辑，也不能吞得无声无息。
                // 水位仍然推进（否则后续 op 永远卡在它后面），但同步详情里留下一条 warn 可查。
                if (unknownKinds.add(kind)) {
                    db.log("warn", "sync-unknown-kind", SyncOpText.describeUnknownKind(kind), JSONObject().put("kind", kind))
                }
            }
        }
        db.setSetting("sync_cursor", seq.toString())
    }

    private fun reconcile(preferHub: Boolean = false, advanceCursor: Boolean = false) {
        checkActive()
        syncProgress = "正在读取中枢目录"
        db.log("info", "reconcile-start")
        // 大库的 snapshot 可达数十 MiB。先流式落临时文件，再逐项解析，避免 JSONObject
        // 将整份清单及字符串副本同时留在 Android 的 256 MiB 堆里。
        val staged = File(db.root, "snapshot-${UUID.randomUUID()}.json")
        val remotePaths = mutableSetOf<String>()
        val stalePaths = mutableSetOf<String>()
        /**
         * 本机已经改名/改分类/删除、但还没推给中枢的路径。
         *
         * 对账是「按中枢清单逐项核对本机有没有」：本机把文件推到新路径后，中枢的旧路径在本机
         * 已经不存在，会被当成「本机缺这份」拉回来——手机上于是新旧两份并存（实测：改分类后
         * 手动全量对账把旧路径复活）。待推送的旧路径要跳过，等这一轮 converge() 把改动推上去。
         */
        val pendingMoves = mutableSetOf<String>()
        val pendingDeletes = mutableSetOf<String>()
        runCatching {
            for (item in db.outbox()) {
                when (item.getString("kind")) {
                    "move" -> item.optString("old_path").takeIf { it.isNotBlank() }?.let(pendingMoves::add)
                    "delete" -> pendingDeletes += item.getString("target")
                }
            }
        }
        var inferredCursor = 0L
        var snapshotCursor = 0L
        var remoteCount = 0
        val tally = ChangeTally()
        val pending = mutableListOf<SnapshotWork>()
        fun flushPending() {
            if (pending.isEmpty()) return
            val batch = pending.toList()
            pending.clear()
            try {
                batch.forEach { work ->
                    checkActive()
                    try {
                        work.apply()
                    } catch (e: Cancelled) {
                        throw e
                    } catch (error: Exception) {
                        // 对账逐项容错：单项落地失败不中止整轮（否则 advanceCursor 永远执行不到，
                        // 每轮都从同一处重来，进度永远不前进）。内容交给下一次对账再试。
                        db.setSetting(healAtSetting, "0")
                        db.log(
                            "warn",
                            "reconcile-item-failed",
                            "对账时有一项没落地：${error.message ?: error.javaClass.simpleName}（已跳过，下次对账会再试）",
                        )
                    }
                }
            } finally {
                batch.forEach { work -> work.discard() }
            }
        }
        try {
            withConnection("GET", "/api/sync/snapshot") { response ->
                val stream = response.body?.byteStream() ?: throw IllegalStateException("中枢未返回清单内容")
                val declared = response.body?.contentLength() ?: -1L
                require(declared < 0 || declared <= MAX_SNAPSHOT_BYTES) { "中枢清单超过 256 MB 上限" }
                stream.use { input ->
                    staged.outputStream().buffered().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            checkActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= MAX_SNAPSHOT_BYTES) { "中枢清单超过 256 MB 上限" }
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            JsonReader(staged.inputStream().bufferedReader(StandardCharsets.UTF_8)).use { reader ->
                reader.beginObject()
                while (reader.hasNext()) when (reader.nextName()) {
                    "entries" -> {
                        reader.beginArray()
                        while (reader.hasNext()) {
                            checkActive()
                            var kind = ""
                            var path = ""
                            var hash = ""
                            var revision = 0
                            var distilled = false
                            reader.beginObject()
                            while (reader.hasNext()) when (reader.nextName()) {
                                "kind" -> kind = reader.nextString()
                                "path" -> path = reader.nextString()
                                "hash" -> hash = reader.nextString()
                                "revision" -> revision = reader.nextInt()
                                "distilled" -> distilled = reader.nextBoolean()
                                else -> reader.skipValue()
                            }
                            reader.endObject()
                            require(path.isNotBlank() && (kind == "page" || kind == "file")) { "中枢清单条目无效" }
                            remoteCount++
                            if (remoteCount % 25 == 0) syncProgress = "正在核对中枢目录（$remoteCount 项）"
                            inferredCursor = maxOf(inferredCursor, revision.toLong())
                            remotePaths += path
                            if (!SyncPreferences(db).allowed(kind, path)) continue
                            if (preferHub) db.dropOutboxForTarget(path)
                            // 本机已经把这份改名/改分类（或删掉了）但还没推上去：中枢的旧路径不拉回来，
                            // 否则手机上会同时出现新旧两份，等这一轮 converge() 推完改动自然收敛
                            if (path in pendingMoves || path in pendingDeletes) {
                                recordPendingLocal(kind, path)
                                continue
                            }
                            val localFile = db.file(path)
                            val localHash = if (localFile.exists()) sha256(localFile) else ""
                            if (localHash == hash) {
                                if (kind == "page" && db.pageRevision(path) != revision) {
                                    db.rawPage(path)?.let { db.writeSyncedPage(path, it, revision) }
                                }
                            } else if (kind == "page") {
                                if (localFile.exists() && db.pageRevision(path) > 0) {
                                    db.enqueue("page", path)
                                    recordLocalNewer("page", path)
                                } else {
                                    val fetchPath = path
                                    schedulePull()
                                    val future = fetchExecutor.submit<String?> {
                                        tolerateMissing { getJson("/api/sync/page-content?path=${encode(fetchPath)}").optString("content") }
                                    }
                                    pending += SnapshotWork(
                                        apply = {
                                            val content = await(future)
                                            if (content == null) {
                                                // 中枢在清单生成后把它改名/删掉了：跳过，别把整轮对账拖死
                                                completePull()
                                                recordMissingAtHub("page", fetchPath)
                                            } else {
                                                // 旧正文先读出来：这条同步记录要写清「新增还是修改、动了多少行」
                                                val before = db.rawPage(fetchPath)
                                                if (SyncPreferences(db).allowed("page", fetchPath)) db.writeSyncedPage(fetchPath, content, revision)
                                                completePull()
                                                recordApplied("pull-page", SyncOpText.summarizePage(fetchPath, before, content), tally)
                                            }
                                        },
                                        discard = { cancelFetch(future) },
                                    )
                                }
                            } else {
                                if (localFile.exists() && !preferHub) {
                                    db.enqueue("file", path)
                                    recordLocalNewer("file", path)
                                } else {
                                    val fetchPath = path
                                    val beforeBytes = if (localFile.exists()) localFile.length() else 0L
                                    schedulePull()
                                    val future = fetchExecutor.submit<File?> { tolerateMissing { stageFile(fetchPath) } }
                                    pending += SnapshotWork(
                                        apply = {
                                            val stagedFile = await(future)
                                            if (stagedFile == null) {
                                                completePull()
                                                recordMissingAtHub("file", fetchPath)
                                            } else {
                                                val afterBytes = stagedFile.length()
                                                try { if (SyncPreferences(db).allowed("file", fetchPath)) db.installSyncedFile(fetchPath, stagedFile) }
                                                finally { stagedFile.delete() }
                                                completePull()
                                                recordApplied("pull-file", SyncOpText.summarizeFile(fetchPath, beforeBytes, afterBytes), tally)
                                            }
                                        },
                                        discard = { discardStagedFile(future) },
                                    )
                                }
                            }
                            if (distilled && !db.evidenceDistilled(path)) {
                                val evidencePath = path
                                schedulePull()
                                val future = fetchExecutor.submit<JSONObject?> {
                                    tolerateMissing { getJson("/api/sync/evidence?path=${encode(evidencePath)}").optJSONObject("snapshot") }
                                }
                                pending += SnapshotWork(
                                    apply = {
                                        await(future)?.let { if (SyncPreferences(db).allowed("file", evidencePath)) db.saveEvidence(evidencePath, it) }
                                        completePull()
                                    },
                                    discard = { cancelFetch(future) },
                                )
                            }
                            if (pending.size >= SNAPSHOT_FETCH_BATCH) flushPending()
                        }
                        reader.endArray()
                    }
                    "cursor" -> snapshotCursor = reader.nextLong()
                    "stale" -> {
                        reader.beginArray()
                        while (reader.hasNext()) stalePaths += reader.nextString()
                        reader.endArray()
                    }
                    // 中枢随清单下发「本机在中枢配置里的成员名」：学回来，设置页与对话抽屉才有名字可显示
                    "device" -> {
                        if (reader.peek() == JsonToken.BEGIN_OBJECT) {
                            var name = ""
                            reader.beginObject()
                            while (reader.hasNext()) when (reader.nextName()) {
                                "name" -> name = reader.nextString()
                                else -> reader.skipValue()
                            }
                            reader.endObject()
                            learnDeviceLabel(name)
                        } else {
                            reader.skipValue()
                        }
                    }
                    // 中枢随清单下发「同步群组共用的更新源」（服务器/桌面端「更新源配置」那一份）：
                    // 手机没手填地址时直接用它检查更新，免得多端各填一遍
                    "updateSource" -> {
                        if (reader.peek() == JsonToken.BEGIN_OBJECT) {
                            var url = ""
                            var repo = ""
                            reader.beginObject()
                            while (reader.hasNext()) when (reader.nextName()) {
                                "url" -> url = reader.nextString()
                                "repo" -> repo = reader.nextString()
                                else -> reader.skipValue()
                            }
                            reader.endObject()
                            learnUpdateSource(url, repo)
                        } else {
                            reader.skipValue()
                        }
                    }
                    else -> reader.skipValue()
                }
                reader.endObject()
            }
            flushPending()
        } finally {
            pending.forEach { it.discard() }
            pending.clear()
            staged.delete()
        }
        var localCount = 0
        val brainPrefix = db.brain.canonicalPath + File.separator
        db.brain.walkTopDown().filter { it.isFile && !it.canonicalPath.startsWith(brainPrefix + ".trash" + File.separator) }.forEach { file ->
            checkActive()
            localCount++
            val path = file.canonicalPath.removePrefix(brainPrefix).replace('\\', '/')
            if (path !in remotePaths && path !in stalePaths) {
                val kind = if (!InboxFiles.contains(path) && (file.extension.equals("md", true) || file.extension.equals("markdown", true))) "page" else "file"
                db.enqueue(kind, path)
            }
        }
        if (advanceCursor) {
            snapshotCursor = maxOf(inferredCursor, snapshotCursor)
            val current = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
            if (snapshotCursor > current) db.setSetting("sync_cursor", snapshotCursor.toString())
        }
        db.log("info", "reconcile-done", "中枢 $remoteCount 项，本地 $localCount 项${tally.describe()}")
        syncProgress = if (remoteCount == 0) "正在补齐本机改动" else "已核对 $remoteCount 项"
    }

    /**
     * 记一条「具体改了什么」（拉取方向）：列表展示 describe() 的中文，展开看 data 的结构化字段，
     * 与 desktop 端 eventLog 的 data 键名同口径。落到本地内容才 +1 内容版本，前端据此渐进刷新文件树。
     */
    private fun recordApplied(event: String, item: SyncOpText.SyncOpSummary, tally: ChangeTally? = null) {
        if (!SyncOpText.isNoteworthy(item)) return
        tally?.note(item)
        roundChanges += 1
        db.log("info", event, SyncOpText.describe(item), toJson(SyncOpText.data(item)))
        db.bumpContentRevision()
    }

    /** 记一条推送（本机 → 中枢）：方向写清楚，别和拉取混成一句「同步了 N 项」 */
    private fun recordPush(event: String, kind: String, path: String, oldPath: String?, bytes: Long, revision: Int) {
        // AIWorks/ 下的系统页由应用自身写入（首次启动就会种下 index/log/scheme），不进用户记录
        if (!SyncOpText.isNoteworthyPush(path, oldPath)) return
        roundChanges += 1
        db.log("info", event, SyncOpText.describePush(kind, path, oldPath, bytes, revision), toJson(SyncOpText.pushData(kind, path, oldPath, bytes, revision)))
    }

    /** 本机版本较新、没被中枢覆盖：说明白为什么这项没落地，而不是静默跳过 */
    private fun recordLocalNewer(kind: String, path: String) {
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log("info", "pull-local-newer", "本机改动较新，保留本机版本并排队推送：$subject", toJson(mapOf("kind" to kind, "path" to path)))
    }

    /** 本机已改名/改分类/删除但还没推上去：中枢的旧路径不拉回（否则手机上新旧两份并存） */
    private fun recordPendingLocal(kind: String, path: String) {
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log(
            "info",
            "pull-pending-local",
            "$subject 本机已改名/移动或删除、尚未推送，中枢里的旧路径不再拉回本机",
            toJson(mapOf("kind" to kind, "path" to path)),
        )
    }

    /** 本机有还没推出去的编辑：本轮不按中枢的 op 覆盖，等推送上去由中枢合并后再写回权威正文 */
    private fun recordLocalEditWins(kind: String, path: String) {
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log(
            "info",
            "pull-local-edit-kept",
            "$subject 本机有尚未推送的改动，本轮不覆盖本机内容（推送后由中枢合并）",
            toJson(mapOf("kind" to kind, "path" to path)),
        )
    }

    /**
     * 记下中枢的灵感提炼队列状态（`/api/sync/distilled` 的 pending/failed 两个数组）。
     *
     * 手机端没有任务队列：本机 `/api/jobs` 是空桩，而侧栏「提炼中 / 提炼失败」徽标的数据源正是它。
     * 结果就是「电脑上标了提炼中、手机上什么都没有」（与 1.3.8 修的「已提炼」标记缺口同源）。
     * 这里把中枢的清单落到设置里，由 `/api/jobs` 桩按 web 端期望的 job 形状发出去。
     */
    private fun saveIdeaDistillStatus(response: JSONObject) {
        fun paths(key: String): String {
            val arr = response.optJSONArray(key) ?: return "[]"
            val out = JSONArray()
            for (i in 0 until arr.length()) {
                val path = arr.optString(i)
                if (path.isNotBlank() && SyncPreferences(db).allowed("file", path)) out.put(path)
            }
            return out.toString()
        }
        val pending = paths("pending")
        val failed = paths("failed")
        if (db.setting(ideaDistillPendingSetting) != pending) db.setSetting(ideaDistillPendingSetting, pending)
        if (db.setting(ideaDistillFailedSetting) != failed) db.setSetting(ideaDistillFailedSetting, failed)
    }

    /**
     * 中枢对本端推送做了合并/规范化（本端内容已被写回）：这是「我的改动怎么变了」的唯一解释，
     * 与 desktop / Docker 端 client.ts 的 push-merged 同措辞、同 data 键名。
     */
    private fun recordPushMerged(path: String, ack: JSONObject, localRaw: String, mergedRaw: String, revision: Int) {
        if (!SyncOpText.isNoteworthyPush(path)) return
        val op = ack.optJSONObject("op")
        val title = op?.optString("title")
        val added = op?.optInt("added") ?: 0
        val removed = op?.optInt("removed") ?: 0
        val localBytes = localRaw.toByteArray(Charsets.UTF_8).size.toLong()
        val mergedBytes = mergedRaw.toByteArray(Charsets.UTF_8).size.toLong()
        roundChanges += 1
        val data = JSONObject()
            .put("kind", SyncOpText.KIND_PAGE).put("verb", "merged").put("path", path)
            .put("revision", revision).put("added", added).put("removed", removed)
            .put("localBytes", localBytes).put("mergedBytes", mergedBytes)
        title?.takeIf { it.isNotBlank() }?.let { data.put("title", it) }
        db.log("info", "push-merged", SyncOpText.describePushMerged(path, title, added, removed, localBytes, mergedBytes), data)
    }

    /**
     * 结构化字段 → JSONObject：集合要显式转 JSONArray。
     *
     * Android 的 `JSONObject.put` 不包装集合——直接塞 List，序列化时会被当成普通对象调 `toString()`，
     * 于是 `data.changes` 落库成了字符串 `"[+ 某一行]"`，前端按数组读就一行都渲染不出来（实测踩到）。
     */
    private fun toJson(fields: Map<String, Any>): JSONObject {
        val out = JSONObject()
        for ((key, value) in fields) {
            out.put(key, if (value is Collection<*>) JSONArray(value) else value)
        }
        return out
    }

    /** 对账过程中的改动计数（只服务结尾那条汇总） */
    private class ChangeTally {
        private var addedPages = 0
        private var updatedPages = 0
        private var addedFiles = 0
        private var updatedFiles = 0
        private var removed = 0
        private var moved = 0

        fun note(item: SyncOpText.SyncOpSummary) {
            when (item.kind) {
                SyncOpText.KIND_PAGE -> if (item.verb == SyncOpText.VERB_ADD) addedPages++ else updatedPages++
                SyncOpText.KIND_FILE -> if (item.verb == SyncOpText.VERB_ADD) addedFiles++ else updatedFiles++
                SyncOpText.KIND_DELETE -> removed++
                SyncOpText.KIND_MOVE -> moved++
            }
        }

        fun describe(): String {
            val parts = mutableListOf<String>()
            if (addedPages > 0) parts += "新增页面 $addedPages"
            if (updatedPages > 0) parts += "修改页面 $updatedPages"
            if (addedFiles > 0) parts += "新增文件 $addedFiles"
            if (updatedFiles > 0) parts += "更新文件 $updatedFiles"
            if (removed > 0) parts += "删除 $removed"
            if (moved > 0) parts += "改名 $moved"
            if (parts.isEmpty()) return ""
            return "；本次落地：" + parts.joinToString("、")
        }
    }

    private fun stageFile(path: String): File {
        val staged = File(db.root, "sync-${UUID.randomUUID()}.tmp")
        val maxBytes = if (isInboxFile(path)) Long.MAX_VALUE else MAX_FILE_BYTES
        try {
            withConnection("GET", "/api/sync/file?path=${encode(path)}") { response ->
                val stream = response.body?.byteStream() ?: throw IllegalStateException("中枢未返回文件内容")
                val declared = response.body?.contentLength() ?: -1L
                require(declared < 0 || declared <= maxBytes) { "同步文件超过 200 MB 上限" }
                stream.use { input ->
                    staged.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= maxBytes) { "同步文件超过 200 MB 上限" }
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            return staged
        } catch (error: Exception) {
            staged.delete()
            throw error
        }
    }

    private data class SnapshotWork(val apply: () -> Unit, val discard: () -> Unit)
    private data class PagePayload(val content: String, val evidence: JSONObject?)
    private data class ChangeWork(
        val op: JSONObject,
        val page: Future<PagePayload?>? = null,
        val file: Future<File?>? = null,
        /** 中枢已判定该路径不存在（compact 回放的 missing 标记）：直接跳过，不再发请求 */
        val missing: Boolean = false,
    )

    private fun schedulePull() {
        pendingPulls++
        syncProgress = "正在下载内容（队列 $pendingPulls 项）"
    }

    private fun completePull() {
        pendingPulls = (pendingPulls - 1).coerceAtLeast(0)
        syncProgress = if (pendingPulls > 0) "正在下载内容（还剩 $pendingPulls 项）" else "已下载目录内容"
    }

    private fun <T> await(future: Future<T>): T = try {
        future.get()
    } catch (error: ExecutionException) {
        throw error.cause ?: error
    }

    private fun cancelFetch(future: Future<*>) {
        if (!future.isDone) future.cancel(true)
    }

    private fun discardStagedFile(future: Future<File?>) {
        if (!future.isDone) {
            future.cancel(true)
            return
        }
        if (future.isCancelled) return
        runCatching { await(future)?.delete() }
    }

    /**
     * 中枢已经没有这份内容（404：清单/oplog 里的旧条目滞后于改名或删除）时返回 null。
     *
     * 不能让它升级成整轮失败：水位推不过去，下一轮还会撞同一条，同步就永久卡死了（实测卡过）。
     * 其余错误（网络、鉴权、5xx）照旧抛出，交给上层的退避重试。
     */
    private fun <T> tolerateMissing(block: () -> T): T? = try {
        block()
    } catch (error: Exception) {
        if (error.message?.contains("404") == true) null else throw error
    }

    /** 取不回来的 op：推进水位并留一条记录，别静默跳过 */
    private fun skipMissingOp(op: JSONObject) {
        val kind = op.optString("kind")
        val target = op.optString("target")
        recordMissingAtHub(kind, target)
        val seq = op.optLong("seq")
        if (seq > 0) db.setSetting("sync_cursor", seq.toString())
    }

    /**
     * 改名 / 移动 op 落到本机时源路径不存在（旧内容没拉过）：按新路径把内容补下来。
     *
     * 只补一份；拉不到（中枢连新路径也没有）就记一条「中枢已无此内容」并安排下一次全量对账。
     * 分类开关关着时直接跳过（与其它 op 口径一致）。
     */
    private fun pullMovedTarget(op: JSONObject, target: String) {
        val isPage = target.endsWith(".md", true) || target.endsWith(".markdown", true)
        val kind = if (isPage) "page" else "file"
        if (!SyncPreferences(db).allowed(kind, target)) return
        checkActive()
        try {
            if (isPage) {
                val content = tolerateMissing {
                    getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                }
                if (content == null) { recordMissingAtHub(kind, target); return }
                val before = db.rawPage(target)
                db.writeSyncedPage(target, content, op.optInt("revision"))
                recordApplied("pull-page", SyncOpText.summarizePage(target, before, content))
            } else {
                val staged = tolerateMissing { stageFile(target) }
                if (staged == null) { recordMissingAtHub(kind, target); return }
                val beforeBytes = db.file(target).let { if (it.exists()) it.length() else 0L }
                val afterBytes = staged.length()
                try { db.installSyncedFile(target, staged) } finally { staged.delete() }
                recordApplied("pull-file", SyncOpText.summarizeFile(target, beforeBytes, afterBytes))
            }
        } catch (e: Cancelled) {
            throw e
        } catch (error: Exception) {
            // 补拉失败不该把整轮判失败：记一条并安排下一次全量对账重试
            db.setSetting(healAtSetting, "0")
            db.log(
                "warn",
                "pull-move-heal-failed",
                "补拉改名后的内容失败：${error.message ?: error.javaClass.simpleName}（下一次全量对账重试）",
                toJson(mapOf("path" to target)),
            )
        }
    }

    /** 中枢已经没有这份内容（多半是被改名或删除）：记一条，说清为什么这一项没落地 */
    private fun recordMissingAtHub(kind: String, path: String) {
        missingSkipped += 1
        // 改名后旧路径的 op 会在 oplog 里连片出现（实测一份原始资料改名后有 330 条旧 op 回放）：
        // 同一路径每轮只记一条，避免同步详情被同一句话刷屏。
        if (!missingLogged.add("$kind:$path")) return
        // 旧路径被跳过 = 本机很可能缺「改名后的新路径」：安排下一次前台同步先跑一轮全量对账补齐
        db.setSetting(healAtSetting, "0")
        if (!SyncOpText.isNoteworthyPush(path)) return
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log(
            "info",
            "pull-missing",
            "中枢已经没有这份内容（可能已被改名或删除），本次跳过：$subject",
            toJson(mapOf("kind" to kind, "path" to path)),
        )
    }

    private fun nodeId(): String {
        val existing = db.setting("sync_node_id")
        if (!existing.isNullOrBlank()) return existing
        return UUID.randomUUID().toString().also { db.setSetting("sync_node_id", it) }
    }

    private fun baseUrls(): List<String> {
        val primary = (db.setting("sync_hub_url") ?: error("未配置中枢地址")).trimEnd('/')
        val fallbacks = runCatching { JSONArray(db.setting("sync_direct_urls") ?: "[]") }.getOrDefault(JSONArray())
        return buildList {
            // 择优命中的那条排最前（局域网直连优先）；探不到时自然回到配置的中枢地址，行为与历史一致
            activeBase?.takeIf { it.isNotBlank() }?.let(::add)
            add(primary)
            for (i in 0 until fallbacks.length()) fallbacks.optString(i).trimEnd('/').takeIf { it.startsWith("http") }?.let(::add)
        }.distinct()
    }

    // ── 连接通道择优（局域网 → IPv6 → IPv4 → 断开）────────────────────────────────

    /** 「优先局域网」开关：只有显式存过 '0' 才算关，老库默认开（与 server 同口径） */
    fun preferLan(): Boolean = db.setting(linkPreferLanSetting) != "0"

    /** 设置页改开关：记一条日志并立刻按新策略重选一次，用户不必等下一轮同步 */
    fun setPreferLan(value: Boolean) {
        val before = preferLan()
        db.setSetting(linkPreferLanSetting, if (value) "1" else "0")
        if (before == value) return
        db.log(
            "info",
            "link-config",
            if (value) "已启用「优先局域网」：同一局域网内优先走内网直连，探不到时按 IPv6 → IPv4 自动降级"
            else "已关闭「优先局域网」：只按配置的中枢地址连接",
            JSONObject().put("preferLan", value),
        )
        forceProbe = true
        request(false)
    }

    /**
     * 网络已切换（Wi-Fi ↔ 蜂窝、开 / 关 VPN、路由器重新下发 IPv6 前缀）。
     *
     * 双栈记账按域名记在进程里，换网络后不能沿用：在没有 IPv6 的网络里学到的「这个域名走 IPv4」
     * 如果留着，换到有 IPv6 的网络仍会先按 IPv4 走、界面继续显示「IPv6 连不上」，直到 IPv4 成功
     * 10 次后的回探——用户看到的就是「安卓端连不上 IPv6」。这里清掉学到的状态与旧网络通告的
     * 局域网地址，并立刻重新探测；下一次请求重新按 IPv6 优先试。
     */
    fun onNetworkChanged() {
        if (db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return
        val now = System.currentTimeMillis()
        if (now - lastNetworkResetAt < networkResetMinIntervalMs) return
        lastNetworkResetAt = now
        DualStack.reset()
        announcedLanCache = emptyList()
        forceProbe = true
        db.log("info", "link-network-changed", "网络已切换：清掉学到的双栈状态，重新按 IPv6 优先探测连接通道")
        request(false)
    }

    /** 本机当前网络是否真有 IPv6 出口（拿不到网络信息时按「有」处理，退回历史行为） */
    private fun deviceHasIpv6(): Boolean = network?.hasIpv6() ?: true

    /** 本机在同步群组里的显示名：中枢配置里的成员名（对账时学回），没学到时退回手机型号 */
    fun deviceLabel(): String {
        val learned = db.setting(deviceLabelSetting)?.trim().orEmpty()
        if (learned.isNotEmpty()) return learned
        val model = android.os.Build.MODEL?.trim().orEmpty()
        return if (model.isEmpty()) "手机" else "手机 $model"
    }

    /** 学回中枢配置里的成员名；名字变了记一条日志让用户看得见（与 server deviceLabel.ts 同口径） */
    private fun learnDeviceLabel(name: String) {
        val trimmed = name.trim().take(40)
        if (trimmed.isEmpty()) return
        val before = db.setting(deviceLabelSetting)?.trim().orEmpty()
        if (before == trimmed) return
        db.setSetting(deviceLabelSetting, trimmed)
        db.log(
            "info",
            "device-label",
            "本机名称已按中枢配置对齐为「$trimmed」",
            JSONObject().put("label", trimmed).put("previous", before),
        )
    }

    /** 显示名是哪来的：设置页据此说明「按中枢配置」还是「暂时显示手机名」 */
    fun deviceLabelSource(): String =
        if (db.setting(deviceLabelSetting)?.trim().isNullOrEmpty()) "hostname" else "member-config"

    /**
     * 学回中枢的更新源（多端同步共用一份，见 server/routes/sync.ts 的 updateSource 字段）：
     * 只写「中枢下发」那两个键，本机手填的地址不被覆盖——检查更新时本机手填优先。
     */
    private fun learnUpdateSource(url: String, repo: String) {
        val trimmedUrl = url.trim().trimEnd('/')
        val trimmedRepo = repo.trim().trim('/')
        if (trimmedUrl.isEmpty() || trimmedRepo.isEmpty()) return
        val before = "${db.setting(AppUpdateConfig.KEY_HUB_URL).orEmpty()}/${db.setting(AppUpdateConfig.KEY_HUB_REPO).orEmpty()}"
        if (before == "$trimmedUrl/$trimmedRepo") return
        db.setSetting(AppUpdateConfig.KEY_HUB_URL, trimmedUrl)
        db.setSetting(AppUpdateConfig.KEY_HUB_REPO, trimmedRepo)
        db.log(
            "info",
            "update-source",
            "更新源已按中枢配置对齐为「$trimmedRepo」",
            JSONObject().put("repo", trimmedRepo).put("url", trimmedUrl),
        )
    }

    /** 通道现状（`/api/sync/status` 的 link 字段）；未启用同步时为 null，界面据此整块隐藏 */
    fun linkStatus(): JSONObject? {
        if (db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return null
        val base = activeBase.orEmpty()
        val candidates = JSONArray()
        for (item in linkCandidates) {
            candidates.put(
                JSONObject()
                    .put("kind", item.kind).put("label", item.label).put("url", item.url).put("ok", item.ok)
                    .put("latencyMs", item.latencyMs ?: JSONObject.NULL)
                    .put("error", item.error ?: JSONObject.NULL)
                    // 中枢主地址实际连上的协议族：连接详情据此说「IPv6 / IPv4」，不再猜域名解析
                    .put("family", item.family ?: JSONObject.NULL),
            )
        }
        return JSONObject()
            .put("channel", linkChannel)
            .put("url", if (linkChannel == SyncLink.CHANNEL_OFFLINE) "" else base)
            .put("host", SyncLink.hostPortOf(base))
            .put("latencyMs", linkLatencyMs ?: JSONObject.NULL)
            .put("since", linkSince ?: JSONObject.NULL)
            .put("probedAt", linkProbedAt ?: JSONObject.NULL)
            .put("preferLan", preferLan())
            .put("candidates", candidates)
    }

    private fun announcedLanUrls(): List<String> {
        announcedLanCache?.let { return it }
        val parsed = runCatching {
            val raw = JSONArray(db.setting(linkLanUrlsSetting) ?: "[]")
            (0 until raw.length()).map { raw.getString(it) }
        }.getOrDefault(emptyList())
        announcedLanCache = parsed
        return parsed
    }

    /** 记住中枢通告的内网地址：本轮与下次启动都先用它试局域网 */
    private fun rememberAnnouncedLan(urls: List<String>) {
        announcedLanCache = urls
        runCatching { db.setSetting(linkLanUrlsSetting, JSONArray(urls).toString()) }
    }

    /** 改绑定/解绑后清掉上一个中枢学到的东西（不能拿旧中枢的内网地址去连新中枢） */
    private fun resetLinkBinding() {
        activeBase = null
        linkCandidates = emptyList()
        linkChannel = SyncLink.CHANNEL_OFFLINE
        linkLatencyMs = null
        linkSince = null
        linkProbedAt = null
        lastProbeRoundAt = 0L
        probeBoundHub = null
        announcedLanCache = emptyList()
        runCatching { db.setSetting(linkLanUrlsSetting, "[]") }
    }

    /**
     * 一轮同步开头调一次：首次、到期（10 分钟）或显式要求（改档位）才真探。
     * 节流不是可选项——离线时每轮同步都先探一遍会把「同步中」白白拖长几秒。
     */
    private fun maybeProbeLink() {
        if (db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return
        val hubBase = (db.setting("sync_hub_url") ?: "").trimEnd('/')
        // 绑定换了一个中枢：上一个中枢学到的内网地址与通道判定一律作废，且**必须立刻重探**——
        // 否则节流会让我们拿着旧中枢的候选继续显示「已断开」（实测：刚绑定完仍探旧地址）。
        if (hubBase != probeBoundHub) {
            resetLinkBinding()
            forceProbe = true
        }
        val now = System.currentTimeMillis()
        val firstRound = lastProbeRoundAt == 0L
        val due = firstRound || now - lastProbeRoundAt >= linkReprobeIntervalMs
        if (!forceProbe && !due) return
        if (!firstRound && forceProbe && now - lastProbeRoundAt < linkProbeMinIntervalMs) return
        forceProbe = false
        try {
            runProbeRound()
        } catch (error: Cancelled) {
            throw error
        } catch (error: Exception) {
            db.log("warn", "link-probe-failed", "连接通道探测失败：${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun runProbeRound() {
        val hubBase = (db.setting("sync_hub_url") ?: "").trimEnd('/')
        if (hubBase.isBlank()) return
        if (probeBoundHub != null && probeBoundHub != hubBase) resetLinkBinding()
        probeBoundHub = hubBase
        val prefer = preferLan()
        val results = mutableListOf<SyncLink.Candidate>()
        var learned: List<String>? = null
        // 最多两轮：第一轮从中枢取回内网地址清单，第二轮把它们探掉（清单会随网段变化，每次启动重学一遍）
        for (pass in 0..1) {
            for (target in SyncLink.planProbes(hubBase, announcedLanUrls(), prefer)) {
                checkActive()
                if (results.any { it.url == target.url }) continue
                val probe = probeAnnounce(target)
                results += SyncLink.Candidate(target.kind, target.label, target.url, probe.ok, probe.latencyMs, probe.error, probe.family)
                if (target.kind == SyncLink.KIND_HUB && probe.ok && probe.lan.isNotEmpty()) learned = probe.lan
                // 局域网已经通了就不必再探剩下的：这一轮的目的就是找到最快那条路
                if (target.kind == SyncLink.KIND_LAN && probe.ok && prefer) break
            }
            val pending = learned
            if (pending != null) {
                val changed = pending != announcedLanUrls()
                rememberAnnouncedLan(pending)
                learned = null
                // 刚学到（或清单变了）的地址要立刻探一轮，否则这一轮仍然只走了公网
                if (changed) continue
            }
            break
        }
        linkCandidates = results
        linkProbedAt = Instant.now().toString()
        lastProbeRoundAt = System.currentTimeMillis()

        val winner = SyncLink.pickWinner(results, prefer)
        if (winner == null) {
            // 全部候选失败：可能是真断网，也可能是中枢版本还没有这个通告端点（404）。
            // 后者不能显示「已断开」——同步其实正常，只是猜不出走的哪条路，退回按中枢地址归类。
            val hubProbe = results.firstOrNull { it.kind == SyncLink.KIND_HUB }
            if (hubProbe != null && !hubProbe.ok && hubProbe.error?.contains("404") == true) {
                activeBase = hubBase
                linkChannel = detectHubChannel(hubBase)
                linkLatencyMs = null
                linkSince = null
                if (!announceMissingLogged) {
                    announceMissingLogged = true
                    db.log("info", "link-announce-unavailable", "中枢尚未提供连接通告端点，连接通道按中枢地址判定：${SyncLink.channelLabel(linkChannel)}")
                }
                return
            }
            linkChannel = SyncLink.CHANNEL_OFFLINE
            linkLatencyMs = null
            return
        }

        val nextBase = winner.url
        // 主地址的通道取「这次探测实际连上的协议族」：探测走的就是双栈路径，比事后猜 DNS 可信
        val nextChannel = if (winner.kind == SyncLink.KIND_LAN) {
            SyncLink.CHANNEL_LAN
        } else {
            SyncLink.channelOfFamily(winner.family) ?: detectHubChannel(nextBase)
        }
        val previousBase = activeBase
        val changed = nextBase != previousBase || nextChannel != linkChannel
        activeBase = nextBase
        linkLatencyMs = winner.latencyMs
        linkChannel = nextChannel
        if (changed) {
            linkSince = Instant.now().toString()
            db.log(
                "info",
                "link-changed",
                "连接通道：${SyncLink.channelLabel(nextChannel)}（${SyncLink.hostPortOf(nextBase)}，延迟 ${winner.latencyMs ?: "?"} 毫秒）",
                JSONObject()
                    .put("channel", nextChannel).put("base", nextBase)
                    .put("latencyMs", winner.latencyMs ?: JSONObject.NULL)
                    .put("previous", previousBase ?: hubBase),
            )
        }
    }

    private data class AnnounceProbe(
        val ok: Boolean,
        val latencyMs: Long?,
        val error: String?,
        val lan: List<String>,
        /** 这次探测实际连上的协议族（6 / 4）；局域网候选与探测失败时为 null */
        val family: Int? = null,
    )

    /**
     * 一次候选探测：打中枢的连接通告端点（带令牌）。既证明这个地址可达，又顺手取回中枢的内网地址清单。
     *
     * 中枢主地址走与真实同步请求同一条双栈路径（按协议族分池的 OkHttp 客户端 + DualStack.plan/record）：
     *  - 探测本身也记账——回到 IPv6 可用网络时，探测成功就会立刻切回 IPv6 优先，不必等 10 次
     *    IPv4 成功后的回探（否则界面会长时间停在上一个网络学到的「IPv6 连不上」）；
     *  - 每个协议族各有独立预算。旧实现一个 6 秒总超时，IPv6 黑洞时会把预算耗光、来不及试 IPv4，
     *    出现「探测说断开 / 连不上、同步其实正常」，也会把通道判定带偏。
     * 局域网候选是 IP 字面量、双栈策略本来就不介入：保持 1.5 秒硬超时且不记账。
     */
    private fun probeAnnounce(target: SyncLink.ProbeTarget): AnnounceProbe =
        if (target.kind == SyncLink.KIND_LAN) probePlain(target.url, linkProbeLanTimeoutMs) else probeHub(target.url)

    private fun announceRequest(url: okhttp3.HttpUrl): Request = Request.Builder().url(url)
        .header("Authorization", "Bearer ${token()}")
        .header("Accept", "application/json")
        .build()

    /** 局域网候选：IP 字面量，不参与双栈记账，短超时即可 */
    private fun probePlain(base: String, timeoutMs: Long): AnnounceProbe {
        val url = "$base/api/sync/announce".toHttpUrlOrNull()
            ?: return AnnounceProbe(false, null, "地址无效", emptyList())
        val call = clientsFor(dualStackConfig().connectTimeoutMs).plain.newCall(announceRequest(url))
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        activeCalls.add(call)
        val startedAt = System.currentTimeMillis()
        return try {
            call.execute().use { response -> parseAnnounce(response, base, System.currentTimeMillis() - startedAt, null) }
        } catch (error: Exception) {
            checkActive()
            AnnounceProbe(false, null, describeLinkError(error, timeoutMs), emptyList())
        } finally {
            activeCalls.remove(call)
        }
    }

    /** 中枢主地址：走与同步请求同一套双栈策略，成功时把实际连上的协议族一起带回来 */
    private fun probeHub(base: String): AnnounceProbe {
        val url = "$base/api/sync/announce".toHttpUrlOrNull()
            ?: return AnnounceProbe(false, null, "地址无效", emptyList())
        val config = dualStackConfig()
        val deviceIpv6 = deviceHasIpv6()
        val availability = if (config.enabled) addressAvailability(url.host) else null
        if (availability == null) {
            // 解析失败 / 策略关闭：与历史行为一致，普通客户端 + 一个宽松超时
            return probePlain(base, probeTimeoutMs(SyncLink.KIND_HUB))
        }
        val state = DualStack.state(url.host)
        DualStack.alignSingleStack(state, availability.first, availability.second, deviceIpv6)
        val plan = DualStack.plan(state, availability.first, availability.second, bodyless = true, deviceIpv6)
        if (plan.isEmpty()) return AnnounceProbe(false, null, DualStack.NO_DEVICE_IPV6_REASON, emptyList())
        val clients = clientsFor(config.connectTimeoutMs)
        var failure: Exception? = null
        var lastError: String? = null
        for ((index, planned) in plan.withIndex()) {
            checkActive()
            val client = if (planned.family == 6) clients.v6 else clients.v4
            // 每个协议族各自一份预算（连接 + TLS + 响应头）：IPv6 黑洞时不会把整个探测的预算耗光
            val budget = maxOf(config.connectTimeoutMs + PROBE_ATTEMPT_MARGIN_MS, linkProbeLanTimeoutMs)
            val startedAt = System.currentTimeMillis()
            try {
                val opened = openResponse("GET", url, null, null, client, budget)
                val status: Int
                val text: String
                try {
                    status = opened.response.code
                    text = runCatching { opened.response.body?.string().orEmpty() }.getOrDefault("")
                } finally {
                    activeCalls.remove(opened.call)
                    opened.response.close()
                }
                // 拿到响应头 = 这一族可达：旧中枢没有 announce 端点（404）也证明域名连得上，
                // 不能算成 IPv6 的失败（否则探测会把双栈记账带偏）
                logDualStackEvent(DualStack.record(config, state, planned.family, true, System.currentTimeMillis() - startedAt))
                if (status !in 200..299) {
                    return AnnounceProbe(false, null, "中枢返回 $status", emptyList(), planned.family)
                }
                return parseAnnounceText(text, base, System.currentTimeMillis() - startedAt, planned.family)
            } catch (error: Exception) {
                checkActive()
                logDualStackEvent(DualStack.record(config, state, planned.family, false, System.currentTimeMillis() - startedAt))
                failure = error
                lastError = describeLinkError(error, budget)
                if (!isConnectFailure(error) || index == plan.lastIndex) break
            }
        }
        return AnnounceProbe(false, null, lastError ?: failure?.message?.take(60) ?: "连不上", emptyList())
    }

    private fun parseAnnounce(response: Response, base: String, latencyMs: Long, family: Int?): AnnounceProbe {
        if (!response.isSuccessful) return AnnounceProbe(false, null, "中枢返回 ${response.code}", emptyList(), family)
        return parseAnnounceText(response.body?.string().orEmpty(), base, latencyMs, family)
    }

    private fun parseAnnounceText(text: String, base: String, latencyMs: Long, family: Int?): AnnounceProbe {
        val data = runCatching { JSONObject(text) }.getOrNull()
            ?: return AnnounceProbe(false, null, "中枢应答异常", emptyList(), family)
        if (!data.optBoolean("ok")) return AnnounceProbe(false, null, "中枢应答异常", emptyList(), family)
        val lan = mutableListOf<String>()
        data.optJSONArray("lan")?.let { arr -> for (i in 0 until arr.length()) lan += arr.optString(i) }
        return AnnounceProbe(true, latencyMs, null, SyncLink.normalizeAnnouncedLan(lan, db.setting("sync_hub_url")), family)
    }

    private fun probeTimeoutMs(kind: String): Long =
        if (kind == SyncLink.KIND_LAN) linkProbeLanTimeoutMs
        else maxOf(linkProbeLanTimeoutMs, dualStackConfig().connectTimeoutMs + 1000L)

    /** 走中枢主地址（域名）时到底是 IPv6 还是 IPv4：优先信双栈记账，其次看域名解析出的协议族 */
    private fun detectHubChannel(base: String): String {
        SyncLink.classifyBase(base)?.let { return it }
        val host = SyncLink.hostnameOf(base)
        val entry = DualStack.status().firstOrNull { it.host == host }
        if (entry != null) return if (entry.family == 4) SyncLink.CHANNEL_IPV4 else SyncLink.CHANNEL_IPV6
        return try {
            val addresses = InetAddress.getAllByName(host)
            when {
                addresses.any { FamilyDns.isFamily(it, 6) } -> SyncLink.CHANNEL_IPV6
                addresses.any { FamilyDns.isFamily(it, 4) } -> SyncLink.CHANNEL_IPV4
                else -> SyncLink.CHANNEL_IPV4
            }
        } catch (_: UnknownHostException) {
            SyncLink.CHANNEL_IPV4
        }
    }

    /** 探测失败原因：超时/连不上给一句人话，其余截断保留（完整信息在同步详情里） */
    private fun describeLinkError(error: Exception, timeoutMs: Long): String {
        val text = error.message.orEmpty()
        return when {
            error is java.io.InterruptedIOException || text.contains("timeout", true) || text.contains("Canceled", true) ->
                "探测超时（$timeoutMs 毫秒）"
            error is java.net.ConnectException || error is java.net.SocketException || error is UnknownHostException ||
                text.contains("failed", true) || text.contains("refused", true) || text.contains("unreachable", true) -> "连不上"
            else -> text.take(60).ifBlank { "连不上" }
        }
    }
    private fun token(): String = secrets.get("sync_hub_token") ?: error("未配置绑定令牌")
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")
    private fun isInboxFile(path: String) = path.startsWith("收集箱/")

    private fun getJson(path: String) = JSONObject(String(request("GET", path, null, "application/json"), StandardCharsets.UTF_8))
    private fun postJson(path: String, body: JSONObject) = JSONObject(String(request("POST", path, body.toString().toByteArray(), "application/json"), StandardCharsets.UTF_8))

    private fun request(method: String, path: String, body: ByteArray?, contentType: String): ByteArray {
        checkActive()
        val requestBody = body?.toRequestBody(contentType.toMediaType())
        return withConnection(method, path, contentType, requestBody) { response ->
            val stream = response.body?.byteStream() ?: throw IllegalStateException("中枢未返回内容")
            val declared = response.body?.contentLength() ?: -1L
            if (declared > MAX_JSON_BYTES) throw JsonResponseTooLarge(declared)
            stream.use { readLimited(it, MAX_JSON_BYTES) }
        }
    }

    /** 当前生效的双栈配置（设置页可改；默认 IPv6 优先 + 标准阈值） */
    private fun dualStackConfig(): DualStackConfig = DualStackConfig.fromSettings { key -> db.setting(key) }

    /**
     * 按当前配置的连接超时取一套客户端（每次配置变化重建一次）：
     *  - plain：策略关闭 / 解析不出地址时用（系统排序，历史行为）；
     *  - v6 / v4：各自 Dns 只喂选定协议族，切族换池、不打断在途传输。
     * 连接超时来自设置项（sync_dualstack_connect_timeout_ms）——此前这里写死 6 秒，设置页调阈值
     * 对真实连接完全不起作用，探测超时还按配置算，两边对不上。
     */
    private data class ClientSet(
        val connectTimeoutMs: Int,
        val plain: OkHttpClient,
        val v6: OkHttpClient,
        val v4: OkHttpClient,
    )

    @Volatile private var clientSet: ClientSet? = null

    private fun clientsFor(connectTimeoutMs: Int): ClientSet {
        val cached = clientSet
        if (cached != null && cached.connectTimeoutMs == connectTimeoutMs) return cached
        val base = OkHttpClient.Builder()
            .connectTimeout(connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // 不能是 0（无限）：半开连接下大附件上传会一直卡在 write() 上，读超时管不到「写不进」，
            // 而 running 恒为 true 会让之后所有同步请求只排队不执行（界面停在「同步中」直到切后台）。
            // 超时按单次写操作计（不是整个请求体），60 秒足够慢网下的分片上传。
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
        return ClientSet(
            connectTimeoutMs,
            base,
            base.newBuilder().dns(FamilyDns(6)).build(),
            base.newBuilder().dns(FamilyDns(4)).build(),
        ).also { clientSet = it }
    }

    private data class OpenResponse(val call: Call, val response: Response)

    /**
     * 建连并拿到**响应头**；读 body、判断状态码都交给调用方。
     *
     * 「这个协议族连没连上」的唯一判据是响应头有没有拿到：拿到 4xx/5xx 也说明这一族网络是通的，
     * 不能算成 IPv6 的失败（这台中枢 404 是常态：改名/删除遗留的 op、旧中枢没有 /distilled、
     * 超过大小上限的批次等）。调用方负责 close，并在此期间把 call 留在 activeCalls 里以便取消。
     */
    private fun openResponse(
        method: String,
        url: okhttp3.HttpUrl,
        contentType: String?,
        body: RequestBody?,
        client: OkHttpClient,
        timeoutMs: Long? = null,
    ): OpenResponse {
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${token()}")
            .header("Accept", "application/json, application/octet-stream")
        contentType?.let { builder.header("Content-Type", it) }
        builder.method(method, body)
        val call = client.newCall(builder.build())
        timeoutMs?.let { call.timeout().timeout(it, TimeUnit.MILLISECONDS) }
        activeCalls.add(call)
        val response = try {
            call.execute()
        } catch (error: Exception) {
            activeCalls.remove(call)
            throw error
        }
        return OpenResponse(call, response)
    }

    /** 拿到响应头之后的收尾：4xx/5xx 与读 body 出错原样抛出（不换族、不记协议族的账） */
    private fun <T> consume(opened: OpenResponse, block: (Response) -> T): T = try {
        val response = opened.response
        if (!response.isSuccessful) {
            val error = response.body?.string()?.take(200).orEmpty()
            throw IllegalStateException("中枢返回 ${response.code}：$error")
        }
        block(response)
    } finally {
        activeCalls.remove(opened.call)
        opened.response.close()
    }

    /**
     * 发一次请求并按双栈策略轮换协议族（IPv6 优先 → 失败用 IPv4；IPv4 用稳后定期回探）。
     *
     * 关键约束：
     *  - 一次请求（含大文件上传／下载）只在**建连那一刻**选定协议族，成功后全程同一条连接；
     *  - 只有「响应头都没拿到」（isConnectFailure）才换族重试，传输途中出错一律不换；
     *  - 也只有「响应头都没拿到」才记进协议族的失败账本：拿到响应头之后的 4xx/5xx、读 body
     *    出错说明这一族网络是通的，不能判成「IPv6 连不上」——中枢 404 是常态（改名/删除遗留的
     *    op、旧中枢没有 /distilled），此前一次 404 就可能凑满阈值，把可用的 IPv6 判死并切到 IPv4。
     */
    private fun <T> withConnection(
        method: String,
        path: String,
        contentType: String? = null,
        body: RequestBody? = null,
        block: (Response) -> T,
    ): T {
        var failure: Exception? = null
        for (base in baseUrls()) {
            checkActive()
            val url = (base + path).toHttpUrlOrNull()
            if (url == null) {
                failure = IllegalArgumentException("中枢地址无效: $base")
                continue
            }
            val config = dualStackConfig()
            val clients = clientsFor(config.connectTimeoutMs)
            val deviceIpv6 = deviceHasIpv6()
            // 解析不出地址或策略关闭时不介入：交给系统默认连接器，行为与历史版本一致
            val availability = if (config.enabled) addressAvailability(url.host) else null
            if (availability == null) {
                try {
                    val result = consume(openResponse(method, url, contentType, body, clients.plain), block)
                    connected = true
                    return result
                } catch (error: Exception) {
                    checkActive()
                    failure = error
                    continue
                }
            }
            val state = DualStack.state(url.host)
            // 域名解析 + 本机网络先校准状态（界面显示的「当前用哪一族」必须是真的）
            DualStack.alignSingleStack(state, availability.first, availability.second, deviceIpv6)
            val plan = DualStack.plan(state, availability.first, availability.second, body == null, deviceIpv6)
            if (plan.isEmpty()) {
                // 本机没有 IPv6 出口、中枢地址又只有 AAAA：没有可尝试的协议族，给出能照着排查的话
                failure = IllegalStateException(
                    "${DualStack.NO_DEVICE_IPV6_REASON}，而中枢地址只解析出 IPv6（${url.host}）：" +
                        "请连上支持 IPv6 的网络，或把中枢地址改成同时有 IPv4 记录的域名 / 直接填 IPv4 地址",
                )
                continue
            }
            for ((index, planned) in plan.withIndex()) {
                checkActive()
                val client = if (planned.family == 6) clients.v6 else clients.v4
                val startedAt = System.currentTimeMillis()
                val opened = try {
                    openResponse(method, url, contentType, body, client)
                } catch (error: Exception) {
                    checkActive()
                    // 只有「响应头都没拿到」才算这一族连不上：记一次失败并决定是否换族
                    logDualStackEvent(
                        DualStack.record(config, state, planned.family, false, System.currentTimeMillis() - startedAt)
                    )
                    failure = error
                    if (!isConnectFailure(error) || index == plan.lastIndex) break
                    continue
                }
                // 拿到响应头 = 这一族网络可达：之后的 4xx/5xx、读 body 出错都不算 IPv6 的账
                logDualStackEvent(
                    DualStack.record(config, state, planned.family, true, System.currentTimeMillis() - startedAt)
                )
                val result = consume(opened, block)
                connected = true
                return result
            }
        }
        throw failure ?: IllegalStateException("无法连接同步中枢")
    }

    /** 域名解析出的协议族清单；解析失败返回 null（让请求自己报 DNS 错，不当作双栈问题记账） */
    private fun addressAvailability(host: String): Pair<Boolean, Boolean>? = try {
        val addresses = InetAddress.getAllByName(host)
        Pair(
            addresses.any { FamilyDns.isFamily(it, 6) },
            addresses.any { FamilyDns.isFamily(it, 4) },
        )
    } catch (_: UnknownHostException) {
        null
    }

    private fun logDualStackEvent(event: DualStackEvent?) {
        if (event == null) return
        db.log(event.level, event.event, event.detail)
    }

    /** 上传一个文件；返回中枢应答（含 revision），推送记录要写「送到了中枢哪一版」 */
    private fun postFile(path: String, file: File): JSONObject {
        if (!isInboxFile(path)) {
            require(file.length() <= MAX_FILE_BYTES) { "同步文件超过 200 MB 上限" }
        }
        // multipart 从文件流式读，不整块进内存；文件名与字段名与中枢接口一致
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("path", path)
            .addFormDataPart(
                "file",
                path.substringAfterLast('/'),
                file.asRequestBody("application/octet-stream".toMediaType()),
            )
            .build()
        return withConnection("POST", "/api/sync/file", null, body) { response ->
            val bytes = response.body?.byteStream()?.use { readLimited(it, MAX_JSON_BYTES) } ?: ByteArray(0)
            runCatching { JSONObject(String(bytes, StandardCharsets.UTF_8)) }.getOrDefault(JSONObject())
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    private fun readLimited(input: java.io.InputStream, limit: Long): ByteArray {
        val output = java.io.ByteArrayOutputStream(minOf(limit, 64 * 1024L).toInt())
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > limit) throw JsonResponseTooLarge(total)
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }
    private class JsonResponseTooLarge(size: Long) : IllegalStateException("同步 JSON 响应过大（至少 ${size / 1024 / 1024} MiB）")
    private class Cancelled : RuntimeException()

    companion object {
        private const val MAX_FILE_BYTES = 200L * 1024 * 1024
        private const val MAX_JSON_BYTES = 8L * 1024 * 1024
        private const val MAX_SNAPSHOT_BYTES = 256L * 1024 * 1024
        /**
         * 增量补拉每批条数。中枢侧 limit 上限 500，手机端一次多拿一些能把「离线一段时间后
         * 追赶积压」的往返次数从几千次降到几百次（实测补 10 天积压 20 条一批要 30 分钟级）；
         * 页面正文是 compact 模式按需再拉，批次放大不增加单次内存峰值。
         */
        private const val CHANGE_BATCH = 100
        private const val MAX_PARALLEL_FETCHES = 4
        private const val SNAPSHOT_FETCH_BATCH = MAX_PARALLEL_FETCHES
        /** 探测单协议族尝试的预算 = 配置的连接超时 + 这段余量（TLS 握手 + 读响应头） */
        private const val PROBE_ATTEMPT_MARGIN_MS = 2_000L
        /** 网络切换重置的最小间隔（系统回调常连发） */
        private const val networkResetMinIntervalMs = 3_000L
    }
}
