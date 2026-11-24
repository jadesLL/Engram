/**
 * 飞书多维表格 → 原始资料的同步执行器。
 *
 * 链路：读配置 → 调飞书 Open API 拉整表 → 渲染 Markdown → 写入
 * `原始资料/文档/飞书多维表格/<表名>.md`。写入走 pipeline/rawMaterial 的
 * createRawMaterial / overwriteRawMaterial：文件登记为知识库页面，自动入提取与提炼队列，
 * 并随普通文件的同步管道发到其他端。
 *
 * 关键约束：
 *  - **内容不变就不写**：正文不含同步时间，记录与字段都没变时跳过写入，避免每次自动同步
 *    都把「已提炼」标记打回待办（设置页仍会显示最近拉取时间）。
 *  - **只覆盖自己生成的文件**：正文带 engram:feishu-bitable 标记且 app/table 对得上才覆盖；
 *    用户在落点上另建的文件会换一个带序号的路径，绝不误删。
 *  - 删除数据源只移除配置，已拉取的资料保留（原始资料归用户所有，清理走回收站）。
 */

import fs from 'node:fs';
import { getSetting, setSetting } from './db.js';
import { pagePathTaken, safeJoin } from './vault.js';
import { splitFrontmatter } from './rawBody.js';
import { createRawMaterial, overwriteRawMaterial, RawMaterialWriteError } from '../pipeline/rawMaterial.js';
import { resetSourceDistillation } from '../pipeline/sourceLedger.js';
import {
  FEISHU_CONFIG_KEY,
  FEISHU_RAW_DIR,
  feishuFilePath,
  parseFeishuBitableConfig,
  parseFeishuSourceMarker,
  serializeFeishuBitableConfig,
  type FeishuBitableConfig,
  type FeishuBitableSource,
} from './feishuBitableConfig.js';
import { describeFeishuError, fetchBitableTable, renderBitableMarkdown } from './feishuBitable.js';

/** 资料 frontmatter 里「来源」的展示标签（也是识别自动同步文件的依据） */
export const FEISHU_SOURCE_LABEL = '飞书多维表格';

export type FeishuSyncState = 'running' | 'ok' | 'error';

export interface FeishuSyncLiveState {
  state: FeishuSyncState;
  startedAt: number;
  finishedAt: number;
  /** 进度 / 失败原因（成功时为空） */
  message: string;
  recordCount: number;
}

const liveStates = new Map<string, FeishuSyncLiveState>();
const inflight = new Map<string, Promise<FeishuSyncLiveState>>();
/** 上次尝试时间（内存）：失败后按间隔重试，而不是每分钟打一次飞书 */
const lastAttemptAt = new Map<string, number>();

export function feishuLiveStates(): Record<string, FeishuSyncLiveState> {
  return Object.fromEntries(liveStates);
}

export function feishuLiveState(id: string): FeishuSyncLiveState | null {
  return liveStates.get(id) ?? null;
}

/** 删除数据源时清掉它的最近状态，避免设置页再显示一条已不存在的记录 */
export function clearFeishuLiveState(id: string): void {
  liveStates.delete(id);
  lastAttemptAt.delete(id);
}

export function readFeishuConfig(): FeishuBitableConfig {
  return parseFeishuBitableConfig(getSetting(FEISHU_CONFIG_KEY));
}

export function saveFeishuConfig(config: FeishuBitableConfig): void {
  setSetting(FEISHU_CONFIG_KEY, serializeFeishuBitableConfig(config));
}

/**
 * 只更新配置里的一个数据源：每次都重新读配置再写回，
 * 避免同步过程中用户删掉了数据源/改了配置却被这次同步的旧快照覆盖回来。
 */
export function updateFeishuSource(
  id: string,
  updater: (source: FeishuBitableSource, config: FeishuBitableConfig) => FeishuBitableSource,
): FeishuBitableSource | null {
  const config = readFeishuConfig();
  const index = config.sources.findIndex((source) => source.id === id);
  if (index < 0) return null;
  const next = updater(config.sources[index], config);
  config.sources[index] = next;
  saveFeishuConfig(config);
  return next;
}

/** 在资料落点里按正文标记找同一张表已拉取过的文件（重新接入时复用，不另起一份） */
export function findFeishuPathByMarker(appToken: string, tableId: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeJoin(FEISHU_RAW_DIR), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const rel = `${FEISHU_RAW_DIR}/${entry.name}`;
    try {
      // 标记固定在正文开头，读前几 KB 足够，不加载整份大表
      const raw = fs.readFileSync(safeJoin(rel), 'utf8').slice(0, 4000);
      const marker = parseFeishuSourceMarker(raw);
      if (marker && marker.appToken === appToken && marker.tableId === tableId) return rel;
    } catch {
      // 单个文件读不了不影响找其它文件
    }
  }
  return null;
}

/**
 * 把渲染好的正文写到资料落点：
 *  1. 目标是本数据源生成的文件（标记匹配）且内容变了 → 覆盖；
 *  2. 内容没变 → 跳过（不重置提炼标记）；
 *  3. 目标不存在 / 被用户占用 / 不能覆盖 → 用带序号的新路径新建。
 */
function writeFeishuFile(source: FeishuBitableSource, content: string): { path: string; changed: boolean } {
  const rel = source.filePath;
  const abs = safeJoin(rel);
  if (fs.existsSync(abs)) {
    let body = '';
    try {
      body = splitFrontmatter(fs.readFileSync(abs, 'utf8')).body;
    } catch {
      body = '';
    }
    const marker = parseFeishuSourceMarker(body);
    if (marker && marker.appToken === source.appToken && marker.tableId === source.tableId) {
      if (body.trim() === content.trim()) return { path: rel, changed: false };
      try {
        overwriteRawMaterial({ path: rel, content, sourceLabel: FEISHU_SOURCE_LABEL });
        // 正文变了：把旧的提炼标记打回待办（否则自动整理永远认为这份资料已处理过）
        resetSourceDistillation(rel);
        return { path: rel, changed: true };
      } catch (error) {
        if (!(error instanceof RawMaterialWriteError)) throw error;
        // 文件在但已不是已登记的页面（例如被手工替换）：换一个路径，不动原文件
      }
    }
  }

  const target = pagePathTaken(rel) ? feishuFilePath(source.name, source.tableId, pagePathTaken) : rel;
  createRawMaterial({ path: target, content, sourceLabel: FEISHU_SOURCE_LABEL });
  return { path: target, changed: true };
}

function publish(id: string, state: FeishuSyncLiveState): FeishuSyncLiveState {
  liveStates.set(id, state);
  return state;
}

export interface FeishuSyncDeps {
  /** 测试注入；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入；缺省 Date.now */
  now?: () => number;
}

async function runSync(id: string, deps: FeishuSyncDeps = {}): Promise<FeishuSyncLiveState> {
  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  lastAttemptAt.set(id, startedAt);
  const config = readFeishuConfig();
  const source = config.sources.find((item) => item.id === id);
  if (!source) {
    return publish(id, {
      state: 'error',
      startedAt,
      finishedAt: clock(),
      message: '数据源不存在（可能已被移除）',
      recordCount: 0,
    });
  }

  if (!config.appId || !config.appSecret) {
    const message = '还没有填写飞书应用凭据，请先保存 App ID 与 App Secret';
    updateFeishuSource(id, (current) => ({ ...current, lastStatus: 'error', lastError: message }));
    return publish(id, { state: 'error', startedAt, finishedAt: clock(), message, recordCount: 0 });
  }

  publish(id, {
    state: 'running',
    startedAt,
    finishedAt: 0,
    message: '正在从飞书拉取…',
    recordCount: 0,
  });

  try {
    const table = await fetchBitableTable(
      { appId: config.appId, appSecret: config.appSecret, fetchImpl: deps.fetchImpl, now: deps.now },
      {
        apiBase: source.apiBase,
        appToken: source.appToken,
        appName: source.appName,
        tableId: source.tableId,
      },
    );
    const content = renderBitableMarkdown({
      appToken: source.appToken,
      appName: table.appName || source.appName,
      tableId: source.tableId,
      tableName: table.tableName || source.name,
      url: source.url,
      fields: table.fields,
      records: table.records,
      truncated: table.truncated,
    });
    const written = writeFeishuFile(source, content);
    updateFeishuSource(id, (current) => ({
      ...current,
      name: table.tableName || current.name,
      appName: table.appName || current.appName,
      filePath: written.path,
      lastSyncAt: clock(),
      lastStatus: 'ok',
      lastError: '',
      lastRecordCount: table.records.length,
    }));
    return publish(id, {
      state: 'ok',
      startedAt,
      finishedAt: clock(),
      message: written.changed ? '已更新资料' : '内容无变化，已跳过写入',
      recordCount: table.records.length,
    });
  } catch (error) {
    const message = describeFeishuError(error);
    updateFeishuSource(id, (current) => ({ ...current, lastStatus: 'error', lastError: message }));
    // 失败必须落日志：设置页只展示最近一次，排查还要能对上时间线
    console.warn(`[feishu] 数据源「${source.name}」拉取失败：${message}`);
    return publish(id, { state: 'error', startedAt, finishedAt: clock(), message, recordCount: 0 });
  }
}

/** 拉取一个数据源；同一数据源同时只跑一个任务（重复点「立即拉取」复用进行中的任务） */
export function syncFeishuSource(id: string, deps: FeishuSyncDeps = {}): Promise<FeishuSyncLiveState> {
  const running = inflight.get(id);
  if (running) return running;
  const promise = runSync(id, deps).finally(() => {
    inflight.delete(id);
  });
  inflight.set(id, promise);
  return promise;
}

const SCHEDULER_TICK_MS = 60_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * 自动同步调度：每分钟看一遍配置，到期的数据源串行拉取（一次只打一张表）。
 * 失败后按同一间隔重试（lastAttemptAt 在内存里），不会每分钟重试。
 */
export async function feishuSchedulerTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) return;
    for (const source of config.sources) {
      if (!source.autoSync) continue;
      const lastAttempt = lastAttemptAt.get(source.id) ?? source.createdAt;
      if (now - lastAttempt < source.intervalMinutes * 60_000) continue;
      await syncFeishuSource(source.id);
    }
  } finally {
    ticking = false;
  }
}

export function startFeishuSyncScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void feishuSchedulerTick().catch((error) => {
      console.warn('[feishu] 自动同步调度失败（下一分钟重试）', error);
    });
  }, SCHEDULER_TICK_MS);
  // 定时器不阻止进程退出（测试 / 桌面端退出不挂住事件循环）
  schedulerTimer.unref?.();
}

export function stopFeishuSyncScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}
