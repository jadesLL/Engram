import { computed, reactive } from 'vue';
import { api } from '../api';

export type RuntimeKind = 'server' | 'desktop' | 'android-local';

export interface RuntimeCapabilities {
  runtime: RuntimeKind;
  localFirst: boolean;
  agentMode: 'local' | 'hub' | 'unavailable';
  nativeActions: string[];
  syncRoles: Array<'none' | 'hub' | 'member'>;
  features: {
    /** Agent 聊天交互面（聊天抽屉 / 会话）：服务端 / 桌面端 true；手机绑定中枢后也为 true（会话经中枢代理） */
    agent: boolean;
    /** 能管 Agent 的「管理面」（外部接入 / MCP Token 等 owner 级配置）：服务端 / 桌面端 true，手机端（android-local）false */
    agentAdmin: boolean;
    /**
     * 内置 Agent 控制台（模型 / 插件 / Agent 预设 / 高级）：
     * 服务端 / 桌面端恒 true；手机（android-local）绑定同步中枢后为 true——手机不跑 dsh，
     * 配置经成员令牌窄代理写中枢。未绑定中枢时 false（设置页整个 Agent 大类不出现）。
     */
    agentConsole: boolean;
    /** 视频理解模型配置（GET/PUT /api/settings/video-config）：服务端 / 桌面端 true；手机绑定中枢后 true（同样写中枢） */
    videoConfig: boolean;
    mcp: boolean;
    jobs: boolean;
    onlyOffice: boolean;
    serverUpdate: boolean;
    /** 手机端专属：应用内在线更新（下载 APK 并调起系统安装器）。桌面/服务端形态为 false */
    apkUpdate: boolean;
    ddns: boolean;
    backup: boolean;
    fileExtraction: boolean;
  };
}

const fullCapabilities: RuntimeCapabilities = {
  runtime: 'server',
  localFirst: false,
  agentMode: 'local',
  nativeActions: [],
  syncRoles: ['none', 'hub', 'member'],
  features: {
    agent: true,
    agentAdmin: true,
    agentConsole: true,
    videoConfig: true,
    mcp: true,
    jobs: true,
    onlyOffice: true,
    serverUpdate: true,
    apkUpdate: false,
    ddns: true,
    backup: true,
    fileExtraction: true,
  },
};

const state = reactive({
  value: fullCapabilities,
  loaded: false,
  loading: null as Promise<RuntimeCapabilities> | null,
});

export async function loadRuntimeCapabilities(force = false): Promise<RuntimeCapabilities> {
  if (!force && state.loaded) return state.value;
  if (state.loading) return state.loading;
  state.loading = api.get('/api/runtime/capabilities')
    .then(({ data }) => {
      state.value = {
        ...fullCapabilities,
        ...data,
        nativeActions: Array.isArray(data?.nativeActions) ? data.nativeActions : [],
        features: { ...fullCapabilities.features, ...(data?.features || {}) },
      };
      return state.value;
    })
    .catch(() => state.value)
    .finally(() => {
      state.loaded = true;
      state.loading = null;
    });
  return state.loading;
}

export function useRuntimeCapabilities() {
  return {
    capabilities: computed(() => state.value),
    loaded: computed(() => state.loaded),
    load: loadRuntimeCapabilities,
  };
}

export function runtimeCapabilitiesSnapshot(): RuntimeCapabilities {
  return state.value;
}
