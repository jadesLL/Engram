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
    agent: boolean;
    agentAdmin: boolean;
    mcp: boolean;
    jobs: boolean;
    onlyOffice: boolean;
    serverUpdate: boolean;
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
    mcp: true,
    jobs: true,
    onlyOffice: true,
    serverUpdate: true,
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
