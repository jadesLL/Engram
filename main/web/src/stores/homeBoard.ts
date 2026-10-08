/**
 * 首页看板的编辑状态（2026-10-05）：布局的读写都收在这一层。
 *
 * 两处落盘、一条文本：
 *  - 服务端设置 `home_layout`（/api/settings，多端一致，Web / Docker / 桌面共用）；
 *  - localStorage（同一份 JSON 作**即时回退**：进页面先按本地画出来，服务端答复到了再校正；
 *    旧服务端、断网、本地模式都能用，用户不会看到「空白首页」）。
 *
 * 约定：
 *  - 任何写操作先改内存再落盘（界面立刻响应），落盘失败只在控制台留痕——布局是偏好，
 *    失败不该弹打扰性提示，也不该把用户刚拖动的位置回滚；
 *  - 写服务端去抖 600ms：连点「添加」或一路拖着排不会打出十几个 PUT；
 *  - 服务端返回的文本一律过 normalizeHomeBoard，坏数据只影响这一台设备（回默认布局）。
 */
import { defineStore } from 'pinia';
import { api } from '../api';
import {
  HOME_LAYOUT_SETTING,
  HOME_LAYOUT_STORAGE_KEY,
  addModule,
  autoArrangeBoard,
  compactBoard,
  defaultHomeBoard,
  moveModuleTo,
  normalizeHomeBoard,
  removeModule,
  serializeHomeBoard,
  setColumns,
  updateModule,
  type BoardColumns,
  type HomeBoard,
  type HomeModule,
  type ModuleKind,
} from '../lib/homeBoard.ts';
import type { GridPlace } from '../lib/homeGrid.ts';

/** 写服务端的去抖窗口：拖拽排序会连续触发，攒一下再发 */
const SERVER_WRITE_DEBOUNCE_MS = 600;

/**
 * 服务端那份值能不能用：必须是能解析成 `{modules:[...]}` 的 JSON 文本。
 * 只判「非空」会让坏 JSON 走 normalizeHomeBoard → 拿到默认布局 → 覆盖掉本地的好布局。
 */
function isUsableLayout(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw) as { modules?: unknown };
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.modules);
  } catch {
    return false;
  }
}

/** 去抖句柄放在 store 外：store 是单例，不必进响应式状态 */
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
/** 去抖窗口内累积的最新一份布局文本（窗口到点才真正 PUT，见 scheduleServerWrite） */
let pendingServerText = '';

/**
 * 把还在去抖窗口里的那份立刻发出去（页面隐藏/卸载前调用，避免「刚点完就关」丢掉服务端副本）。
 * 用 async 而不是 `return api.put(...).catch(...)`：后者的成功值类型会把 AxiosResponse 带出来，
 * 与「返回 void」的契约不兼容（也会让调用方以为能拿到响应）。
 */
export async function flushHomeBoardWrite(): Promise<void> {
  if (serverWriteTimer) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  if (!pendingServerText) return;
  const payload = pendingServerText;
  pendingServerText = '';
  try {
    await api.put('/api/settings', { [HOME_LAYOUT_SETTING]: payload });
  } catch {
    /* 离线写入失败：本地仍是最新，下次改动会再试 */
  }
}

function readLocal(): HomeBoard {
  try {
    const raw = localStorage.getItem(HOME_LAYOUT_STORAGE_KEY);
    return raw ? normalizeHomeBoard(raw) : defaultHomeBoard();
  } catch {
    // 隐私模式 / 存储被禁用：内存里自己维护一份，别让首页直接挂掉
    return defaultHomeBoard();
  }
}

function writeLocal(board: HomeBoard) {
  try {
    localStorage.setItem(HOME_LAYOUT_STORAGE_KEY, serializeHomeBoard(board));
  } catch {
    /* 存不下就算了：服务端仍是权威副本 */
  }
}

export const useHomeBoardStore = defineStore('homeBoard', {
  state: () => ({
    board: readLocal() as HomeBoard,
    /** 是否进入编辑态（拖拽手柄、增删改按钮只在编辑态出现） */
    editing: false,
    /** 服务端布局是否已对齐过一次：控制「加载中」提示与是否用远端覆盖本地 */
    loaded: false,
    history: [] as HomeBoard[],
    revision: 0,
  }),
  actions: {
    /**
     * 读一次服务端布局：远端有**能解析**的布局就以远端为准（多端一致性），否则保持本地。
     * 注意「读不出来」与「没有远端」要同等对待——服务端那份被写坏（或半截 JSON）时不能反过来
     * 把本地这份好布局换成默认布局（那才是真的丢用户设置）。
     */
    async load() {
      const revision = this.revision;
      try {
        const { data } = await api.get('/api/settings');
        const raw = data?.settings?.[HOME_LAYOUT_SETTING];
        if (isUsableLayout(raw) && revision === this.revision) {
          const remote = normalizeHomeBoard(raw);
          this.board = remote;
          writeLocal(remote);
          if (JSON.parse(raw).version === 3) this.persist();
        }
        this.loaded = true;
      } catch {
        // 未登录 / 旧服务端 / 断网：本地布局继续用
        this.loaded = true;
      }
    },
    /** 本地与服务端各写一份（写操作统一走这里） */
    persist() {
      this.revision += 1;
      const text = serializeHomeBoard(this.board);
      writeLocal(this.board);
      this.scheduleServerWrite(text);
    },
    /**
     * 去抖写服务端：**窗口内最后一份**才是要发的（早先写成「定时器已存在就不管」，
     * 结果连点条数 / 连续拖两块时发出去的始终是第一次的旧布局，下次启动还会被它覆盖回来）。
     */
    scheduleServerWrite(text: string) {
      pendingServerText = text;
      if (serverWriteTimer) return;
      serverWriteTimer = setTimeout(() => {
        serverWriteTimer = null;
        const payload = pendingServerText;
        pendingServerText = '';
        void api.put('/api/settings', { [HOME_LAYOUT_SETTING]: payload }).catch(() => {
          /* 服务端暂时写不进去（离线/旧版本）不影响本地已生效的布局 */
        });
      }, SERVER_WRITE_DEBOUNCE_MS);
    },
    add(kind: ModuleKind) {
      const before = this.board.modules.length;
      const next = addModule(this.board, kind);
      if (next.modules.length === before) return false;
      this.commit(next);
      // 新模块还没设置过：把它所在的那一格滚进视野，否则用户以为「点了没反应」
      return true;
    },
    remove(id: string) {
      this.commit(removeModule(this.board, id));
    },
    update(id: string, patch: Partial<Omit<HomeModule, 'id' | 'kind'>>) {
      this.commit(updateModule(this.board, id, patch));
    },
    /**
     * 拖动 / 缩放：把某张卡挪到栅格位置（homeGrid.placeItem 保证不叠、不越界）。
     * 位置没变就不写盘；指针拖动仅在松手时提交整份预览。
     */
    place(id: string, place: GridPlace) {
      const next = moveModuleTo(this.board, id, place);
      if (next === this.board) return;
      this.commit(next);
    },
    /** 手动紧凑：所有卡片往上收，平时保留用户留白。 */
    compact() {
      const next = compactBoard(this.board);
      if (next === this.board) return;
      this.commit(next);
    },
    /** 一键排整齐：按当前顺序顺次铺满 */
    autoArrange() {
      this.commit(autoArrangeBoard(this.board));
    },
    /** 换整页列数：v3 起栅格列数固定（见 homeGrid.GRID_COLS），这个入口保留成空操作（旧调用点不用改） */
    setBoardColumns(columns: BoardColumns) {
      const next = setColumns(this.board, columns);
      if (next === this.board) return;
      this.board = next;
      this.persist();
    },
    /** 编辑态开关：退出编辑时结束拖拽高亮（避免残留落点线） */
    setEditing(on: boolean) {
      this.editing = on;
    },
    /** 恢复默认布局（编辑态的「重置」按钮） */
    resetToDefault() {
      this.commit(defaultHomeBoard());
    },
    commit(next: HomeBoard) {
      if (serializeHomeBoard(next) === serializeHomeBoard(this.board)) return;
      this.history.push(JSON.parse(serializeHomeBoard(this.board)) as HomeBoard);
      if (this.history.length > 30) this.history.shift();
      this.board = next;
      this.persist();
    },
    undo() {
      const previous = this.history.pop();
      if (!previous) return;
      this.board = previous;
      this.persist();
    },
  },
});
