import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import {
  consoleInternalPort,
  consoleStatus,
  consoleUpstream,
  ensureConsole,
  normalizeOrigin,
  restartConsole,
  stopConsole,
} from '../assistant/agentConsole.js';
import { ConsoleRpcError, createConsoleRpc } from '../assistant/agentConsoleRpc.js';
import { bundledDshHome, bundledDshVersion } from '../assistant/config.js';
import { DEFAULT_OFFICIAL_INPUT_MODALITIES, normalizeInputModalities } from '../assistant/modelCapabilities.js';
import { mirrorAgentModelConfig } from '../sync/agentModelSync.js';

/**
 * 控制台的模型保存接口是**唯一拿到 Key 明文**的入口：保存成功后顺带把本机模型配置镜像进同步。
 * 镜像内部按 digest 抑制重复，且异常只记日志，不影响接口返回。
 */
function mirrorModelConfigAfterSave(): void {
  mirrorAgentModelConfig();
}

/**
 * 内置 Agent 控制台的 BFF（原生控制台专用）。
 *
 * DSH 仍是配置真源：这里的每个读写都转成 dsh web 自己的 HTTP RPC
 * （settings / credentials / llm / pluginManager / agentPresets），
 * 前端只看到归一化后的 Engram 口径，不再有 iframe，也不需要浏览器拿 dsh token。
 *
 * 鉴权：requireAssistantAccess —— owner 登录态 / MCP token / **同步成员令牌**（手机）都能进。
 * v1.5.1 起手机端经本地服务窄代理到这里远程配置中枢的内置 Agent（模型/插件/预设/高级）：
 * 手机不跑 dsh，也没有自己的 dsh 配置，改的始终是中枢这一份；凭据只写不读（credentials/describe
 * 只回 configured，不回明文 Key）。反代 /agent-console/* 仍是 owner-only，BFF 只做配置读写。
 */

/** 生产单例：目标来自真正在跑的 dsh web 子进程 */
const consoleRpc = createConsoleRpc({ getTarget: () => consoleUpstream() });

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/** 从请求头还原浏览器访问 Engram 的 origin（反代/HTTPS 场景走 x-forwarded-*） */
function requestOrigin(req: FastifyRequest): string | null {
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHeader || String(req.protocol || 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return normalizeOrigin(proto, host);
}

function sendConsoleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConsoleRpcError) {
    return reply.code(error.status).send({
      error: error.message,
      code: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send({ error: `控制台操作失败：${message}`, code: 'console-failed' });
}

/** 确保控制台已启动并返回 origin（各数据接口的前置） */
async function ensureOrigin(req: FastifyRequest): Promise<string> {
  const origin = requestOrigin(req);
  if (!origin) throw new ConsoleRpcError('无法识别访问地址（Host 头缺失或非法）', { status: 400, code: 'bad-origin' });
  const status = await ensureConsole(origin);
  if (!status.running) {
    throw new ConsoleRpcError(status.error || '内置 Agent 控制台未启动', { status: 503, code: 'console-unavailable' });
  }
  return origin;
}

async function describeSettings(origin: string): Promise<any> {
  return (await consoleRpc.call(origin, 'settings/describe', {})) as any;
}

function namespaceView(describe: any, ns: string): any | null {
  const list: any[] = Array.isArray(describe?.namespaces) ? describe.namespaces : [];
  return list.find((item) => item?.ns === ns) ?? null;
}

function viewValue(view: any): Record<string, any> {
  return view && typeof view.value === 'object' && view.value !== null ? view.value : {};
}

function viewRevision(view: any): number {
  return typeof view?.revision === 'number' ? view.revision : 0;
}

async function mutateNamespace(origin: string, ns: string, ops: unknown[], expectedRevision?: number): Promise<any> {
  const args: Record<string, unknown> = { ns, ops };
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision;
  return (await consoleRpc.call(origin, 'settings/mutate', args)) as any;
}

async function updateNamespace(origin: string, ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<any> {
  const args: Record<string, unknown> = { ns, patch };
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision;
  return (await consoleRpc.call(origin, 'settings/update', args)) as any;
}

async function describeCredentials(origin: string, refs: string[]): Promise<Record<string, any>> {
  const unique = [...new Set(refs.filter((ref) => typeof ref === 'string' && ref.length > 0))];
  const out: Record<string, any> = {};
  for (let index = 0; index < unique.length; index += 64) {
    const chunk = unique.slice(index, index + 64);
    const answer = (await consoleRpc.call(origin, 'credentials/describe', { refs: chunk })) as Record<string, any>;
    if (answer && typeof answer === 'object') Object.assign(out, answer);
  }
  return out;
}

function profileRef(profile: any, provider: string): string {
  const named = typeof profile?.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : '';
  return named || deriveKeyRef(provider);
}

/** DSH 的约定：手填的密钥存到 `<PROVIDER>_API_KEY`（大写、非字母数字转下划线） */
function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

async function rpcValue<T = any>(origin: string, endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await consoleRpc.call(origin, endpoint, args)) as T;
}

const OFFICIAL_PROVIDER = 'deepseek-official';
const PI_AI_NS = 'llm-pi-ai';
const PRESET_NS = 'agent-preset-registry';
const WEB_NS = 'web';
const WEB_SEARCH_NS = 'web-search-deepseek';
const WEB_API_NS = 'web-deepseek-api';
const WEB_PROVIDERS = {
  searchProvider: { api: 'deepseek-search-api', messages: 'deepseek-official' },
  fetchProvider: { api: 'deepseek-fetch-api', messages: 'http' },
};

/* ------------------------------------------------------------------ *
 * 模型
 * ------------------------------------------------------------------ */

function officialModels(view: any): Array<{ id: string; name: string; contextWindow?: number; inputModalities: string[] }> {
  const models = Array.isArray(viewValue(view).models) ? viewValue(view).models : [];
  return models
    .filter((item: any) => item && typeof item.id === 'string')
    .map((item: any) => ({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
      // 输入能力：保留条目上的有效值；未声明/脏值的官方模型按只读文本回填（图片能力需显式声明）
      inputModalities: normalizeInputModalities(item.inputModalities, ['text']),
    }));
}

/** pi-ai 用户自己加的提供者（user 层优先，base 层兜底） */
function customProvidersOf(view: any): Array<{ id: string; raw: any }> {
  const value = viewValue(view);
  const base = view && typeof view.base === 'object' && view.base !== null ? view.base.providers : undefined;
  const user = view && typeof view.user === 'object' && view.user !== null ? view.user.providers : undefined;
  const merged: Record<string, any> = {
    ...(base && typeof base === 'object' ? base : {}),
    ...(user && typeof user === 'object' ? user : {}),
  };
  return Object.entries(merged)
    .filter(([id, raw]) => typeof id === 'string' && id.length > 0 && raw && typeof raw === 'object')
    .map(([id, raw]) => ({ id, raw: raw as any }));
}

async function modelsPayload(origin: string): Promise<any> {
  const [describe, declared, catalog] = await Promise.all([
    describeSettings(origin),
    rpcValue<any[]>(origin, 'llm/listConfigurableProviders'),
    rpcValue<any>(origin, 'session/modelCatalog').catch(() => null),
  ]);
  const defaultView = namespaceView(describe, 'agent-default-model');
  const officialView = namespaceView(describe, 'llm-deepseek');
  const piView = namespaceView(describe, PI_AI_NS);
  const officialDeclared = (Array.isArray(declared) ? declared : []).find((item) => item?.provider === OFFICIAL_PROVIDER);
  const officialValue = viewValue(officialView);
  const officialKeyRef = typeof officialValue.apiKeyEnv === 'string' && officialValue.apiKeyEnv
    ? officialValue.apiKeyEnv
    : 'DEEPSEEK_API_KEY';
  const customs = customProvidersOf(piView).map(({ id, raw }) => {
    const models = Array.isArray(raw.models) ? raw.models : [];
    return {
      id,
      displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
      api: typeof raw.api === 'string' ? raw.api : '',
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : '',
      apiKeyEnv: profileRef(raw, id),
      models: models
        .filter((item: any) => item && typeof item.id === 'string')
        .map((item: any) => ({
          id: item.id,
          name: typeof item.name === 'string' && item.name ? item.name : item.id,
          // pi-ai 的字段名是 input；缺省表示继承提供商默认能力，不要凭空补成 ['text']
          ...(Array.isArray(item.input) ? { input: normalizeInputModalities(item.input, ['text']) } : {}),
        })),
    };
  });
  const credentials = await describeCredentials(origin, [
    officialKeyRef,
    ...customs.map((item) => item.apiKeyEnv),
  ]);

  const official = {
    providerId: OFFICIAL_PROVIDER,
    title: typeof officialDeclared?.displayName === 'string' && officialDeclared.displayName ? officialDeclared.displayName : 'DeepSeek',
    apiKey: {
      configured: credentials[officialKeyRef]?.configured === true,
      ref: officialKeyRef,
      writable: credentials[officialKeyRef]?.writable !== false,
      hint: `留空使用环境变量认证（${officialKeyRef}）`,
    },
    baseURL: {
      value: typeof officialValue.baseURL === 'string' ? officialValue.baseURL : '',
      placeholder: '留空使用官方地址',
    },
    models: officialModels(officialView),
    maxTokens: typeof officialValue.maxTokens === 'number' ? officialValue.maxTokens : 0,
    revision: viewRevision(officialView),
  };

  const customProviders = customs.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    api: item.api,
    baseURL: item.baseURL,
    apiKeyConfigured: credentials[item.apiKeyEnv]?.configured === true,
    models: item.models,
    revision: viewRevision(piView),
  }));

  const catalogDefault = catalog && typeof catalog.default === 'object' && catalog.default !== null ? catalog.default : null;
  const fallbackDefault = viewValue(defaultView);
  const current = {
    provider: String(catalogDefault?.provider ?? fallbackDefault.provider ?? OFFICIAL_PROVIDER),
    model: String(catalogDefault?.model ?? fallbackDefault.model ?? ''),
    ...(typeof fallbackDefault.reasoningEffort === 'string' ? { reasoningEffort: fallbackDefault.reasoningEffort } : {}),
  };
  const providerOptions = [
    { value: OFFICIAL_PROVIDER, label: official.title },
    ...customProviders.map((item) => ({ value: item.id, label: item.displayName })),
  ];
  const modelOptions: Array<{ value: string; label: string; provider: string }> = [
    ...official.models.map((item) => ({ value: item.id, label: item.name, provider: OFFICIAL_PROVIDER })),
    ...customProviders.flatMap((item) => item.models.map((model: any) => ({ value: model.id, label: model.name, provider: item.id }))),
  ];
  if (current.model && !modelOptions.some((item) => item.value === current.model && item.provider === current.provider)) {
    modelOptions.unshift({ value: current.model, label: current.model, provider: current.provider });
  }
  // 声明式提供者（anthropic/openai/…）：给「添加模型提供商」用；已加入的自定义提供者单独展示
  const declaredProviders = (Array.isArray(declared) ? declared : [])
    .filter((item: any) => item && typeof item.provider === 'string' && Array.isArray(item.settingsPath) && item.settingsPath.length > 0)
    .filter((item: any) => !customProviders.some((custom) => custom.id === item.provider))
    .map((item: any) => ({
      provider: item.provider,
      displayName: typeof item.displayName === 'string' && item.displayName ? item.displayName : item.provider,
      defaultBaseURL: typeof item.defaultBaseURL === 'string' ? item.defaultBaseURL : '',
      nativeAuth: Boolean(item.nativeAuth),
    }));
  return {
    writable: describe?.writable !== false,
    default: {
      ...current,
      revision: viewRevision(defaultView),
      providerOptions,
      modelOptions,
    },
    official,
    customProviders,
    declaredProviders,
    apiProtocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  };
}

async function saveDefaultModel(origin: string, body: any): Promise<any> {
  const provider = String(body?.provider ?? '').trim();
  const model = String(body?.model ?? '').trim();
  if (!provider || !model) throw new ConsoleRpcError('provider 与 model 都必填', { status: 400, code: 'bad-request' });
  const describe = await describeSettings(origin);
  const view = namespaceView(describe, 'agent-default-model');
  const ops: any[] = [
    { op: 'set', path: ['provider'], value: provider },
    { op: 'set', path: ['model'], value: model },
  ];
  const effort = typeof body?.reasoningEffort === 'string' ? body.reasoningEffort.trim() : '';
  if (effort) ops.push({ op: 'set', path: ['reasoningEffort'], value: effort });
  await mutateNamespace(origin, 'agent-default-model', ops, body?.expectedRevision ?? viewRevision(view));
  return modelsPayload(origin);
}

async function saveOfficialModel(origin: string, body: any): Promise<any> {
  const describe = await describeSettings(origin);
  const view = namespaceView(describe, 'llm-deepseek');
  const value = viewValue(view);
  const ref = typeof value.apiKeyEnv === 'string' && value.apiKeyEnv ? value.apiKeyEnv : 'DEEPSEEK_API_KEY';
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  if (body?.clearApiKey === true) {
    await consoleRpc.call(origin, 'credentials/unset', { ref }).catch(() => undefined);
  } else if (apiKey) {
    await consoleRpc.call(origin, 'credentials/set', { ref, value: apiKey });
  }
  const ops: any[] = [];
  if (typeof body?.baseURL === 'string') {
    const baseURL = body.baseURL.trim();
    ops.push(baseURL ? { op: 'set', path: ['baseURL'], value: baseURL } : { op: 'unset', path: ['baseURL'] });
  }
  if (Array.isArray(body?.models)) {
    const existingModels: any[] = Array.isArray(value.models) ? value.models : [];
    const models = body.models
      .filter((item: any) => item && typeof item.id === 'string' && item.id.trim())
      .map((item: any) => {
        const id = item.id.trim();
        // 合并原条目：toolUpdate 等 dsh 字段不能因为界面只改名字/窗口就丢掉
        const base = existingModels.find((entry) => entry && entry.id === id) ?? {};
        // 输入能力：显式传了就规范化后覆盖；没传保留原条目（新建条目按官方默认文本+图片）
        const inputModalities = item.inputModalities !== undefined
          ? normalizeInputModalities(item.inputModalities, DEFAULT_OFFICIAL_INPUT_MODALITIES)
          : Array.isArray(base.inputModalities)
            ? normalizeInputModalities(base.inputModalities, DEFAULT_OFFICIAL_INPUT_MODALITIES)
            : [...DEFAULT_OFFICIAL_INPUT_MODALITIES];
        return {
          ...base,
          id,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
          ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
          inputModalities,
        };
      });
    if (models.length === 0) throw new ConsoleRpcError('模型目录至少保留一个模型', { status: 400, code: 'bad-request' });
    ops.push({ op: 'set', path: ['models'], value: models });
  }
  if (typeof body?.maxTokens === 'number' && body.maxTokens > 0) {
    ops.push({ op: 'set', path: ['maxTokens'], value: Math.floor(body.maxTokens) });
  }
  if (ops.length > 0) await mutateNamespace(origin, 'llm-deepseek', ops, body?.expectedRevision ?? viewRevision(view));
  return modelsPayload(origin);
}

async function saveProvider(origin: string, providerId: string, body: any): Promise<any> {
  const id = String(providerId || '').trim();
  if (!id || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new ConsoleRpcError('Provider ID 必须是小写字母开头的短横线标识', { status: 400, code: 'bad-request' });
  }
  const describe = await describeSettings(origin);
  const piView = namespaceView(describe, PI_AI_NS);
  const customs = customProvidersOf(piView);
  const existing = customs.find((item) => item.id === id);
  const existingRaw = existing?.raw ?? {};
  const baseURL = typeof body?.baseURL === 'string' ? body.baseURL.trim() : String(existingRaw.baseURL ?? '');
  if (baseURL) {
    try {
      const parsed = new URL(baseURL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new ConsoleRpcError('API 地址必须是 http(s) URL', { status: 400, code: 'bad-request' });
    }
  }
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  const ref = profileRef(existingRaw, id);
  const profile: Record<string, unknown> = {
    ...(existingRaw && typeof existingRaw === 'object' ? existingRaw : {}),
  };
  if (typeof body?.displayName === 'string' && body.displayName.trim()) profile.displayName = body.displayName.trim();
  if (typeof body?.api === 'string' && body.api.trim()) profile.api = body.api.trim();
  if (baseURL) profile.baseURL = baseURL;
  else delete profile.baseURL;
  if (Array.isArray(body?.models)) {
    const existingModels: any[] = Array.isArray(existingRaw.models) ? existingRaw.models : [];
    const models = body.models
      .filter((item: any) => item && typeof item.id === 'string' && item.id.trim())
      .map((item: any) => {
        const id = item.id.trim();
        // 合并原条目：pi-ai 的其它模型字段（reasoning、toolUpdate 等）不能因为界面只改名字/窗口就丢掉
        const base = existingModels.find((entry) => entry && entry.id === id) ?? {};
        const model: Record<string, unknown> = {
          ...base,
          id,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
          ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
        };
        // 输入能力字段名是 input：传了就规范化写入；没传保留原条目，原本没有就不加（表示继承提供商默认）
        if (item.input !== undefined) model.input = normalizeInputModalities(item.input, ['text']);
        return model;
      });
    if (models.length === 0) throw new ConsoleRpcError('至少填一个模型', { status: 400, code: 'bad-request' });
    profile.models = models;
  } else if (!Array.isArray(profile.models) || profile.models.length === 0) {
    throw new ConsoleRpcError('至少填一个模型', { status: 400, code: 'bad-request' });
  }
  if (apiKey) profile.apiKeyEnv = ref;
  const ops: any[] = [{ op: 'set', path: ['providers', id], value: profile }];
  await mutateNamespace(origin, PI_AI_NS, ops, body?.expectedRevision ?? viewRevision(piView));
  if (body?.clearApiKey === true) {
    await consoleRpc.call(origin, 'credentials/unset', { ref }).catch(() => undefined);
  } else if (apiKey) {
    await consoleRpc.call(origin, 'credentials/set', { ref, value: apiKey });
  }
  return modelsPayload(origin);
}

async function removeProvider(origin: string, providerId: string): Promise<any> {
  const id = String(providerId || '').trim();
  const describe = await describeSettings(origin);
  const piView = namespaceView(describe, PI_AI_NS);
  const existing = customProvidersOf(piView).find((item) => item.id === id);
  if (!existing) throw new ConsoleRpcError(`没有找到提供者「${id}」`, { status: 404, code: 'not-found' });
  const ref = profileRef(existing.raw, id);
  if (existing.raw?.apiKeyEnv === ref) {
    await consoleRpc.call(origin, 'credentials/unset', { ref }).catch(() => undefined);
  }
  await mutateNamespace(origin, PI_AI_NS, [{ op: 'unset', path: ['providers', id] }], viewRevision(piView));
  return modelsPayload(origin);
}

async function discoverModels(origin: string, body: any): Promise<any> {
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
  // dsh 只给 pi-ai 注册了模型发现；官方 DeepSeek 的模型目录由内置清单维护
  if (!provider || provider === OFFICIAL_PROVIDER) {
    throw new ConsoleRpcError('DeepSeek 官方提供商的模型目录由内置清单维护，不能在线探测；第三方/自定义提供商才支持「获取可用模型」', {
      status: 400,
      code: 'discover-unsupported',
    });
  }
  const settingsNs = PI_AI_NS;
  const request: Record<string, unknown> = {};
  if (provider) request.provider = provider;
  if (typeof body?.baseURL === 'string' && body.baseURL.trim()) request.baseURL = body.baseURL.trim();
  if (typeof body?.api === 'string' && body.api.trim()) request.api = body.api.trim();
  if (typeof body?.apiKey === 'string' && body.apiKey.trim()) request.apiKey = body.apiKey.trim();
  const models = await rpcValue<any[]>(origin, 'llm/discoverModels', { settingsNs, request });
  return {
    models: (Array.isArray(models) ? models : [])
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({ id: item.id, name: typeof item.name === 'string' && item.name ? item.name : item.id })),
  };
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

function numberField(view: any, key: string, label: string, hint: string, extra: Record<string, unknown> = {}) {
  const value = viewValue(view)[key];
  return {
    key,
    label,
    hint,
    type: 'number' as const,
    value: typeof value === 'number' ? value : undefined,
    ...extra,
  };
}

function booleanField(value: boolean, key: string, label: string, hint: string) {
  return { key, label, hint, type: 'boolean' as const, value };
}

async function pluginsPayload(origin: string): Promise<any> {
  const [describe, bundles, inventory] = await Promise.all([
    describeSettings(origin),
    rpcValue<any[]>(origin, 'pluginManager/listBundles'),
    rpcValue<any>(origin, 'pluginInventory/list'),
  ]);
  const subagent = namespaceView(describe, 'subagent');
  const agentLoop = namespaceView(describe, 'agent-loop');
  const webView = namespaceView(describe, WEB_NS);
  const messagesView = namespaceView(describe, WEB_SEARCH_NS);
  const apiView = namespaceView(describe, WEB_API_NS);
  const terminalView = namespaceView(describe, 'pwsh-sandbox') ?? namespaceView(describe, 'bash-sandbox');
  const terminalNs = namespaceView(describe, 'pwsh-sandbox') ? 'pwsh-sandbox' : 'bash-sandbox';
  const searchProvider = String(viewValue(webView).searchProvider ?? 'deepseek-official');
  const useSearchApi = searchProvider === WEB_PROVIDERS.searchProvider.api;
  const selectedWebView = useSearchApi ? apiView : messagesView;
  const selectedWebNs = useSearchApi ? WEB_API_NS : WEB_SEARCH_NS;
  const webKeyRef = String(viewValue(selectedWebView).apiKeyEnv ?? 'DEEPSEEK_API_KEY');
  const credentials = await describeCredentials(origin, [webKeyRef]);

  const cards = [
    {
      key: 'subagent',
      title: '子智能体',
      description: '设置子智能体的递归层级、数量和模型。',
      icon: 'ai',
      fields: [
        numberField(subagent, 'maxDepth', '最大递归深度', 'Agent 派生子智能体的最大层级。', { min: 0, step: 1 }),
        numberField(subagent, 'maxActiveSubagents', '并行数量上限', '同时运行的子智能体数量。', { min: 1, step: 1 }),
      ],
      revisions: { subagent: viewRevision(subagent) },
    },
    {
      key: 'web-search',
      title: '网页搜索',
      description: '设置 DeepSeek 的搜索提供方。',
      icon: 'globe',
      fields: [
        booleanField(useSearchApi, 'useSearchApi', '启用新版 Web 搜索 API', '默认关闭，搜索通过 DeepSeek Messages 完成。'),
        {
          key: 'apiKey',
          label: 'API Key',
          hint: '留空表示保持当前密钥；仅使用 DeepSeek 账号模型的对话可以通过默认接口地址搜索。',
          type: 'secret' as const,
          configured: credentials[webKeyRef]?.configured === true,
          ref: webKeyRef,
        },
        {
          key: 'baseURL',
          label: useSearchApi ? 'Search / Fetch API 基础地址' : 'Messages API 地址',
          hint: useSearchApi
            ? '填写含 API 前缀的地址，例如 https://api.deepseek.com/v1/tools；留空恢复默认。'
            : '留空使用默认接口地址。',
          type: 'text' as const,
          value: typeof viewValue(selectedWebView).baseURL === 'string' ? viewValue(selectedWebView).baseURL : '',
          placeholder: useSearchApi ? 'https://api.deepseek.com/v1/tools' : '',
        },
        {
          key: 'limit',
          label: useSearchApi ? '每次搜索结果数' : '单次请求最多搜索次数',
          hint: useSearchApi ? '每个查询返回的结果条数（1–50，默认 10）。' : '辅助模型在一次请求内最多可执行的搜索次数。',
          type: 'number' as const,
          min: 1,
          ...(useSearchApi ? { max: 50 } : {}),
          value: typeof viewValue(selectedWebView)[useSearchApi ? 'count' : 'maxUses'] === 'number'
            ? viewValue(selectedWebView)[useSearchApi ? 'count' : 'maxUses']
            : undefined,
          meta: { ns: selectedWebNs, path: useSearchApi ? ['count'] : ['maxUses'] },
        },
      ],
      revisions: {
        [WEB_NS]: viewRevision(webView),
        [WEB_SEARCH_NS]: viewRevision(messagesView),
        [WEB_API_NS]: viewRevision(apiView),
      },
    },
    {
      key: 'agent-loop',
      title: 'Agent 循环',
      description: '控制 Agent 派发工具调用的方式。',
      icon: 'refresh',
      fields: [
        numberField(agentLoop, 'maxParallelToolCalls', '并行工具调用数', '同一轮里最多并行执行多少个工具调用。', { min: 1, step: 1 }),
      ],
      revisions: { 'agent-loop': viewRevision(agentLoop) },
    },
    {
      key: 'terminal',
      title: '终端',
      description: '限制每条命令最多能跑多久、最多输出多少内容。',
      icon: 'terminal',
      fields: [
        numberField(terminalView, 'timeoutMs', '命令超时（毫秒）', '单条命令允许运行多久，超时即终止。', { min: 1, step: 1000 }),
        numberField(terminalView, 'maxOutputBytes', '单流输出上限（字节）', '超出部分会转存到临时文件，而不是被丢弃。', { min: 1, step: 1024 }),
      ],
      revisions: { [terminalNs]: viewRevision(terminalView) },
    },
  ];

  const experimental = (Array.isArray(bundles) ? bundles : [])
    .filter((bundle: any) => typeof bundle?.name === 'string' && bundle.name.includes('dsh-experimental-'))
    .map((bundle: any) => {
      const meta = bundle.meta && typeof bundle.meta === 'object' ? bundle.meta : {};
      const title = meta.title && typeof meta.title === 'object' ? meta.title.zh || meta.title.en : '';
      const description = meta.description && typeof meta.description === 'object' ? meta.description.zh || meta.description.en : '';
      return {
        key: bundle.name,
        title: title || bundle.name,
        description: description || '',
        tag: '实验性',
        enabled: bundle.enabled === true,
        kind: 'bundle' as const,
        id: bundle.name,
      };
    });

  const rawEntries: any[] = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const entries = rawEntries.map((entry: any) => {
    const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
    const title = meta.title && typeof meta.title === 'object' ? meta.title.zh || meta.title.en : '';
    const description = meta.description && typeof meta.description === 'object' ? meta.description.zh || meta.description.en : '';
    return {
      entryId: String(entry.entryId ?? entry.moduleName ?? ''),
      title: title || String(entry.entryId ?? entry.moduleName ?? '未知插件'),
      description: description || '',
      module: String(entry.moduleName ?? ''),
      enabled: entry.enabled === true,
      status: entry.fiberPhase ? String(entry.fiberPhase) : entry.enabled === true ? '已启用' : '已停用',
      scope: 'global' as const,
    };
  });

  return {
    writable: describe?.writable !== false,
    cards,
    experimental,
    inventory: entries,
  };
}

async function savePluginCard(origin: string, cardKey: string, body: any): Promise<any> {
  const values = body?.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {};
  const expectedRevisions = body?.expectedRevisions && typeof body.expectedRevisions === 'object'
    ? (body.expectedRevisions as Record<string, number>)
    : {};
  const describe = await describeSettings(origin);
  if (cardKey === 'web-search') {
    const webView = namespaceView(describe, WEB_NS);
    const messagesView = namespaceView(describe, WEB_SEARCH_NS);
    const apiView = namespaceView(describe, WEB_API_NS);
    const useSearchApi = values.useSearchApi === true;
    const selectedView = useSearchApi ? apiView : messagesView;
    const selectedNs = useSearchApi ? WEB_API_NS : WEB_SEARCH_NS;
    const keyRef = viewValue(selectedView).apiKeyEnv || 'DEEPSEEK_API_KEY';
    const apiKey = typeof values.apiKey === 'string' ? values.apiKey.trim() : '';
    const sectionOps: any[] = [];
    if (typeof values.baseURL === 'string') {
      const baseURL = values.baseURL.trim();
      sectionOps.push(baseURL ? { op: 'set', path: ['baseURL'], value: baseURL } : { op: 'unset', path: ['baseURL'] });
    }
    const limit = typeof values.limit === 'number' ? Math.floor(values.limit) : Number(values.limit);
    if (Number.isFinite(limit) && limit > 0) {
      sectionOps.push({ op: 'set', path: [useSearchApi ? 'count' : 'maxUses'], value: limit });
    }
    if (sectionOps.length > 0) {
      await mutateNamespace(origin, selectedNs, sectionOps, expectedRevisions[selectedNs] ?? viewRevision(selectedView));
    }
    if (apiKey) await consoleRpc.call(origin, 'credentials/set', { ref: keyRef, value: apiKey });
    const webValue = viewValue(webView);
    const base = webView && typeof webView.base === 'object' && webView.base !== null ? webView.base : {};
    const selectionOps: any[] = [];
    for (const field of ['searchProvider', 'fetchProvider'] as const) {
      const target = WEB_PROVIDERS[field][useSearchApi ? 'api' : 'messages'];
      if (base[field] === target) selectionOps.push({ op: 'unset', path: [field] });
      else selectionOps.push({ op: 'set', path: [field], value: target });
    }
    await mutateNamespace(origin, WEB_NS, selectionOps, expectedRevisions[WEB_NS] ?? viewRevision(webView));
    return pluginsPayload(origin);
  }
  // 其余卡片：字段 → (namespace, path, value) 直接写回
  const cardSpecs: Record<string, Array<{ key: string; ns: string; path: string[] }>> = {
    subagent: [
      { key: 'maxDepth', ns: 'subagent', path: ['maxDepth'] },
      { key: 'maxActiveSubagents', ns: 'subagent', path: ['maxActiveSubagents'] },
    ],
    'agent-loop': [{ key: 'maxParallelToolCalls', ns: 'agent-loop', path: ['maxParallelToolCalls'] }],
    terminal: [
      { key: 'timeoutMs', ns: 'pwsh-sandbox', path: ['timeoutMs'] },
      { key: 'maxOutputBytes', ns: 'pwsh-sandbox', path: ['maxOutputBytes'] },
    ],
  };
  const specs = cardSpecs[cardKey];
  if (!specs) throw new ConsoleRpcError(`未知的插件配置卡：${cardKey}`, { status: 400, code: 'bad-request' });
  if (cardKey === 'terminal') {
    const terminalNs = namespaceView(describe, 'pwsh-sandbox') ? 'pwsh-sandbox' : 'bash-sandbox';
    for (const spec of specs) spec.ns = terminalNs;
  }
  const byNs = new Map<string, any[]>();
  for (const spec of specs) {
    if (!(spec.key in values)) continue;
    const raw = values[spec.key];
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new ConsoleRpcError(`${spec.key} 需要非负数字`, { status: 400, code: 'bad-request' });
    }
    const ops = byNs.get(spec.ns) ?? [];
    ops.push({ op: 'set', path: spec.path, value: Math.floor(numeric) });
    byNs.set(spec.ns, ops);
  }
  for (const [ns, ops] of byNs) {
    const view = namespaceView(describe, ns);
    await mutateNamespace(origin, ns, ops, expectedRevisions[ns] ?? viewRevision(view));
  }
  return pluginsPayload(origin);
}

async function togglePlugin(origin: string, body: any): Promise<any> {
  const kind = body?.kind === 'plugin' ? 'plugin' : 'bundle';
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const enabled = body?.enabled === true;
  if (!id) throw new ConsoleRpcError('缺少插件标识', { status: 400, code: 'bad-request' });
  const result = kind === 'bundle'
    ? await rpcValue<any>(origin, 'pluginManager/setBundleEnabled', { name: id, enabled })
    : await rpcValue<any>(origin, 'pluginManager/setPluginEnabled', { id, enabled });
  // dsh 的写接口即使失败也回 ok:true；成败看 value.application / value.error
  const application = typeof result?.application === 'string' ? result.application : '';
  if (result?.error || (application && application !== 'applied' && application !== 'unchanged')) {
    const detail = typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error ?? application);
    throw new ConsoleRpcError(`插件开关未生效（${detail}）`, { status: 409, code: 'plugin-toggle-failed' });
  }
  return pluginsPayload(origin);
}

/* ------------------------------------------------------------------ *
 * Agent 预设
 * ------------------------------------------------------------------ */

const PRESET_META: Record<string, { title: string; description: string }> = {
  standard: { title: '标准模式', description: '处理代码、文件和资料，适合大多数任务。' },
  ptc: { title: 'PTC 模式', description: '用程序化工具调用扩展 DSH 的能力，适合多工具编排。' },
  minimal: { title: '极简模式', description: '只保留最小工具集，适合快速问答和简单任务。' },
  cordis: { title: '创造模式', description: '可组合插件与工作流，扩展 DSH 的能力。' },
};

async function presetsPayload(origin: string): Promise<any> {
  const [describe, list] = await Promise.all([
    describeSettings(origin),
    rpcValue<any>(origin, 'agentPresets/list'),
  ]);
  const registry = namespaceView(describe, PRESET_NS);
  const rawPresets: any[] = Array.isArray(list?.presets) ? list.presets : [];
  const presets = rawPresets.map((preset: any) => {
    const meta = PRESET_META[preset.id] ?? { title: preset.name || preset.id, description: preset.description || '' };
    return {
      id: String(preset.id),
      title: preset.name || meta.title,
      description: preset.description || meta.description,
      ...(preset.isDefault === true ? { tag: '新任务默认' } : {}),
      ...(preset.broken ? { broken: String(preset.broken) } : {}),
    };
  });
  return {
    writable: describe?.writable !== false,
    selected: String(viewValue(registry).selectedDefault ?? rawPresets.find((item) => item.isDefault)?.id ?? ''),
    revision: viewRevision(registry),
    presets,
  };
}

async function saveDefaultPreset(origin: string, body: any): Promise<any> {
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) throw new ConsoleRpcError('缺少预设 id', { status: 400, code: 'bad-request' });
  const describe = await describeSettings(origin);
  const registry = namespaceView(describe, PRESET_NS);
  await updateNamespace(origin, PRESET_NS, { selectedDefault: id }, body?.expectedRevision ?? viewRevision(registry));
  return presetsPayload(origin);
}

/* ------------------------------------------------------------------ *
 * 高级
 * ------------------------------------------------------------------ */

async function advancedPayload(origin: string): Promise<any> {
  const describe = await describeSettings(origin);
  const sessionLog = namespaceView(describe, 'session-log-deepseek');
  return {
    writable: describe?.writable !== false,
    sessionLog: {
      enabled: viewValue(sessionLog).enabled !== false,
      revision: viewRevision(sessionLog),
    },
    console: {
      dshVersion: bundledDshVersion(),
      home: bundledDshHome(),
    },
  };
}

async function saveSessionLog(origin: string, body: any): Promise<any> {
  const enabled = body?.enabled === true;
  const describe = await describeSettings(origin);
  const view = namespaceView(describe, 'session-log-deepseek');
  await updateNamespace(origin, 'session-log-deepseek', { enabled }, body?.expectedRevision ?? viewRevision(view));
  return advancedPayload(origin);
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export async function agentConsoleRoutes(app: FastifyInstance) {
  // 控制台配置面：owner / MCP token / 同步成员令牌（手机远程配置）都放行；
  // 只读写中枢本机 dsh 的配置，不回显任何模型 Key 明文。
  app.addHook('preHandler', requireAssistantAccess);

  app.get('/api/agent-console/status', async (req) => {
    const origin = requestOrigin(req);
    if (!origin) return { running: false, startedAt: null, dshVersion: bundledDshVersion(), error: '无法识别访问地址（Host 头缺失或非法）', origin: '', upstreamReady: false };
    const status = await ensureConsole(origin);
    return { ...status, upstreamReady: Boolean(consoleInternalPort()) };
  });

  app.post('/api/agent-console/restart', async (req, reply) => {
    const origin = requestOrigin(req);
    if (!origin) return reply.code(400).send({ error: '无法识别访问地址（Host 头缺失或非法）' });
    try {
      const status = await restartConsole(origin);
      return { ...status, upstreamReady: Boolean(consoleInternalPort()) };
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.post('/api/agent-console/stop', async () => {
    stopConsole();
    return { ...consoleStatus(), upstreamReady: false };
  });

  app.get('/api/agent-console/models', async (req, reply) => {
    try {
      const payload = await modelsPayload(await ensureOrigin(req));
      // 控制台页面打开时顺带镜像：用户在原生控制台里改的配置也能尽快进同步
      mirrorModelConfigAfterSave();
      return payload;
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.put('/api/agent-console/models/default', async (req, reply) => {
    try {
      const payload = await saveDefaultModel(await ensureOrigin(req), req.body ?? {});
      mirrorModelConfigAfterSave();
      return payload;
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.put('/api/agent-console/models/official', async (req, reply) => {
    try {
      const payload = await saveOfficialModel(await ensureOrigin(req), req.body ?? {});
      // BFF 这里刚拿到明文 Key 并写进 dsh：保存即镜像
      mirrorModelConfigAfterSave();
      return payload;
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.put('/api/agent-console/models/providers/:id', async (req, reply) => {
    try {
      const id = (req.params as { id?: string }).id ?? '';
      const payload = await saveProvider(await ensureOrigin(req), id, req.body ?? {});
      mirrorModelConfigAfterSave();
      return payload;
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.delete('/api/agent-console/models/providers/:id', async (req, reply) => {
    try {
      const id = (req.params as { id?: string }).id ?? '';
      return await removeProvider(await ensureOrigin(req), id);
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.post('/api/agent-console/models/discover', async (req, reply) => {
    try {
      return await discoverModels(await ensureOrigin(req), req.body ?? {});
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.get('/api/agent-console/plugins', async (req, reply) => {
    try {
      return await pluginsPayload(await ensureOrigin(req));
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.patch('/api/agent-console/plugins/config/:cardKey', async (req, reply) => {
    try {
      const cardKey = (req.params as { cardKey?: string }).cardKey ?? '';
      return await savePluginCard(await ensureOrigin(req), cardKey, req.body ?? {});
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.patch('/api/agent-console/plugins/toggle', async (req, reply) => {
    try {
      return await togglePlugin(await ensureOrigin(req), req.body ?? {});
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.get('/api/agent-console/presets', async (req, reply) => {
    try {
      return await presetsPayload(await ensureOrigin(req));
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.put('/api/agent-console/presets/default', async (req, reply) => {
    try {
      return await saveDefaultPreset(await ensureOrigin(req), req.body ?? {});
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.get('/api/agent-console/presets/:id', async (req, reply) => {
    try {
      const origin = await ensureOrigin(req);
      const id = (req.params as { id?: string }).id ?? '';
      const document = await rpcValue(origin, 'agentPresets/read', { agentPreset: id });
      return { id, ...(document as any) };
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.get('/api/agent-console/advanced', async (req, reply) => {
    try {
      return await advancedPayload(await ensureOrigin(req));
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  app.put('/api/agent-console/advanced/session-log', async (req, reply) => {
    try {
      return await saveSessionLog(await ensureOrigin(req), req.body ?? {});
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });

  /** 兜底：按 namespace 读一个设置视图（后续做 schema 表单/诊断用） */
  app.get('/api/agent-console/settings/:ns', async (req, reply) => {
    try {
      const origin = await ensureOrigin(req);
      const ns = (req.params as { ns?: string }).ns ?? '';
      const describe = await describeSettings(origin);
      const view = namespaceView(describe, ns);
      if (!view) return reply.code(404).send({ error: `没有找到设置命名空间「${ns}」`, code: 'not-found' });
      return view;
    } catch (error) {
      return sendConsoleError(reply, error);
    }
  });
}
