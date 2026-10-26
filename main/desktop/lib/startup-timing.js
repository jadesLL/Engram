// 启动分段计时（Electron 主进程；无第三方依赖、可单测）：
//   node desktop/scripts/tests/startup-log.test.js
//
// 目的：用户反馈「首次打开启动时间太长」，但 app.log 里原本只有零散日志、没有可对照的分段数据。
// 这里记录从**进程真实启动时刻**（用 process.uptime 回推，Electron 引导时间也计入）到各节点的
// 累计耗时，每到一个节点输出一行 `[startup] <label> +Nms`；进入主界面时再输出一条总耗时摘要
// （各段为相邻标记之间的增量），便于和基线对比，也便于用户反馈时直接贴这段日志。
'use strict';

/** 进程启动时刻（Unix ms）：把 t0 从「main.js 开始执行」回推到真正的进程启动 */
function processStartedAt(now = Date.now, uptime = () => process.uptime()) {
  return now() - Math.round(uptime() * 1000);
}

/**
 * 创建启动计时器。
 * @param {{startedAt?: number, now?: () => number}} [opts]
 *   startedAt 省略时按 processStartedAt() 回推进程启动时刻；now 可注入假时钟（单测用）。
 */
function createStartupTimer(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : processStartedAt(now);
  let lastAt = startedAt;
  const marks = [];
  const seen = new Set();
  return {
    startedAt,
    /**
     * 记录一个节点；同名节点只记第一次（second-instance / activate 会重走启动流程，
     * 但启动耗时只应统计进程的第一次），返回已有或新的记录。
     */
    mark(label) {
      if (seen.has(label)) return marks.find((m) => m.label === label);
      const at = now();
      const totalMs = Math.max(0, Math.round(at - startedAt));
      const deltaMs = Math.max(0, Math.round(at - lastAt));
      lastAt = at;
      seen.add(label);
      const rec = { label: String(label), totalMs, deltaMs };
      marks.push(rec);
      return rec;
    },
    has(label) {
      return seen.has(label);
    },
    /** 从进程启动到现在的累计耗时（摘要行用，取的是摘要输出时刻而非最后一个标记） */
    elapsedMs() {
      return Math.max(0, Math.round(now() - startedAt));
    },
    marks() {
      return marks.slice();
    },
  };
}

/** 单条分段日志：`[startup] whenReady +812ms`（+Nms = 自进程启动起算的累计耗时） */
function formatMark(rec) {
  return `[startup] ${rec.label} +${rec.totalMs}ms`;
}

/**
 * 总耗时摘要：`[startup] 总耗时 +12345ms：main-loaded 350ms | whenReady 900ms | ...`
 * 各段为相邻标记之间的增量（第一段 = 进程启动到模块初始化完成）；totalMs 不传时取最后一条标记。
 */
function formatSummary(marks, opts = {}) {
  const totalMs = Number.isFinite(opts.totalMs) ? Math.max(0, Math.round(opts.totalMs)) : marks.length ? marks[marks.length - 1].totalMs : 0;
  const note = opts.note ? `（${opts.note}）` : '';
  const segments = marks.map((m) => `${m.label} ${m.deltaMs}ms`).join(' | ');
  return segments
    ? `[startup] 总耗时 +${totalMs}ms${note}：${segments}`
    : `[startup] 总耗时 +${totalMs}ms${note}`;
}

module.exports = { processStartedAt, createStartupTimer, formatMark, formatSummary };
