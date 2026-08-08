<template>
  <div class="settings-view">
    <header class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>管理账户、模型、自动化与本地数据。</p>
      </div>
    </header>

    <div class="settings-mobile-nav">
      <label for="settings-section">设置分类</label>
      <select id="settings-section" v-model="activeSettingsSection">
        <option v-for="item in settingsNavigation" :key="item.id" :value="item.id">
          {{ item.label }}
        </option>
      </select>
    </div>

    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="item in settingsNavigation"
          :key="item.id"
          type="button"
          :class="{ active: activeSettingsSection === item.id }"
          @click="activeSettingsSection = item.id"
        >
          <Icon :name="item.icon" :size="17" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="settings-content">
        <section v-show="activeSettingsSection === 'account'" class="settings-panel">
          <div class="panel-head">
            <div>
              <h3>账户与外观</h3>
              <p>调整登录凭据和界面显示方式。</p>
            </div>
          </div>

          <div class="settings-group">
            <div class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>修改密码</strong>
                <span>新密码至少需要 6 位。</span>
              </div>
              <div class="password-controls">
                <input v-model="pwd.old" type="password" autocomplete="current-password" placeholder="原密码" />
                <input v-model="pwd.next" type="password" autocomplete="new-password" placeholder="新密码" />
                <button class="btn primary" type="button" @click="changePwd">修改密码</button>
              </div>
              <p v-if="pwdMsg" class="setting-message" :class="pwdOk ? 'ok' : 'err'">{{ pwdMsg }}</p>
            </div>

            <div class="setting-row">
              <div class="setting-copy">
                <strong>主题</strong>
                <span>选择浅色、深色或跟随系统。</span>
              </div>
              <select
                class="setting-control"
                :value="app.theme"
                aria-label="主题"
                @change="app.setTheme(($event.target as HTMLSelectElement).value as any)"
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-copy">
                <strong>侧边栏风格</strong>
                <span>控制知识目录的层级和密度。</span>
              </div>
              <select
                class="setting-control wide"
                :value="app.sidebarStyle"
                aria-label="侧边栏风格"
                @change="app.setSidebarStyle(($event.target as HTMLSelectElement).value as any)"
              >
                <option value="a">方案 A · macOS 分层列表</option>
                <option value="b">方案 B · iOS 卡片</option>
                <option value="c">方案 C · 极简文字</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-copy">
                <strong>当前会话</strong>
                <span>退出后需要重新输入密码。</span>
              </div>
              <button class="btn danger" type="button" @click="logout">退出登录</button>
            </div>
          </div>
        </section>

        <section v-show="activeSettingsSection === 'models'" class="settings-panel model-workspace">
          <div class="panel-head model-panel-head">
            <div>
              <h3>模型配置</h3>
              <p>管理对话生成与语义检索使用的服务商配置。</p>
            </div>
            <div class="panel-actions">
              <button class="btn" type="button" :disabled="testingAll" @click="testAll">
                <Icon name="activity" :size="15" />
                {{ testingAll ? '测试中...' : '测试全部' }}
              </button>
              <button class="btn" type="button" @click="rebuild">重建索引</button>
              <button class="btn primary" type="button" @click="openForm(activeModelKind)">
                <Icon name="plus" :size="15" />
                添加配置
              </button>
            </div>
          </div>

          <p v-if="testResult" class="workspace-message" :class="testOk ? 'ok' : 'err'">{{ testResult }}</p>

          <div class="model-tabs" role="tablist" aria-label="模型类型">
            <button
              v-for="section in modelSections"
              :key="section.kind"
              type="button"
              role="tab"
              :aria-selected="activeModelKind === section.kind"
              :class="{ active: activeModelKind === section.kind }"
              @click="activeModelKind = section.kind"
            >
              <span>{{ section.kind === 'chat' ? '对话模型' : 'Embedding' }}</span>
              <span class="tab-count">{{ configuredProviderCount(section) }}/{{ section.cards.length }}</span>
            </button>
          </div>

          <template v-for="section in modelSections" :key="section.kind">
            <div v-show="activeModelKind === section.kind" class="model-section-body">
              <div v-if="activeModelFor(section.kind)" class="active-model-strip">
                <div class="provider-mark active-mark">
                  {{ providerMark(providerName(activeModelFor(section.kind)!.provider)) }}
                </div>
                <div class="active-model-copy">
                  <span>当前启用</span>
                  <strong>{{ activeModelFor(section.kind)!.name }}</strong>
                  <small>
                    {{ activeModelFor(section.kind)!.model }}
                    <template v-if="section.kind === 'emb'"> · {{ activeModelFor(section.kind)!.dim }} 维</template>
                  </small>
                </div>
                <button
                  class="btn"
                  type="button"
                  :disabled="testingId === activeModelFor(section.kind)!.id"
                  @click="testOne(section.kind, activeModelFor(section.kind)!)"
                >
                  {{ testingId === activeModelFor(section.kind)!.id ? '测试中...' : '测试当前连接' }}
                </button>
              </div>

              <div class="model-section-intro">
                <p>{{ section.copy }}</p>
                <span>{{ section.cards.length }} 家服务商</span>
              </div>

              <div class="provider-catalog">
                <article
                  v-for="card in section.cards"
                  :key="`${section.kind}-${card.provider.id}`"
                  class="provider-card"
                  :class="{ active: card.primary?.id === section.activeId }"
                >
                  <div class="provider-card-head">
                    <div class="provider-identity">
                      <div class="provider-mark">{{ providerMark(card.provider.name) }}</div>
                      <div class="provider-title">
                        <strong>{{ card.provider.name }}</strong>
                        <span>{{ card.primary ? lineName(card.provider, card.primary.line, card.primary.baseUrl) : '尚未配置' }}</span>
                      </div>
                    </div>
                    <span class="status-indicator" :class="{ active: card.primary?.id === section.activeId, configured: card.primary?.apiKey }">
                      {{ card.primary?.id === section.activeId ? '使用中' : card.primary?.apiKey ? '已配置' : '未配置' }}
                    </span>
                  </div>

                  <template v-if="card.primary">
                    <dl class="config-details">
                      <div>
                        <dt>模型</dt>
                        <dd :title="card.primary.model">{{ card.primary.model }}</dd>
                      </div>
                      <div v-if="section.kind === 'emb'">
                        <dt>维度</dt>
                        <dd>{{ card.primary.dim }}</dd>
                      </div>
                      <div>
                        <dt>密钥</dt>
                        <dd>{{ maskKey(card.primary.apiKey) }}</dd>
                      </div>
                    </dl>

                    <p
                      v-if="cardTest[card.primary.id]"
                      class="inline-result"
                      :class="cardTest[card.primary.id].ok ? 'ok' : 'err'"
                    >
                      {{ cardTest[card.primary.id].ok ? '连接成功' : cardTest[card.primary.id].error }}
                    </p>

                    <div class="model-card-actions">
                      <button
                        class="btn small"
                        type="button"
                        :disabled="testingId === card.primary.id"
                        @click="testOne(section.kind, card.primary)"
                      >{{ testingId === card.primary.id ? '测试中...' : '测试' }}</button>
                      <button
                        v-if="card.primary.id !== section.activeId"
                        class="btn small primary"
                        type="button"
                        @click="selectModel(section.kind, card.primary.id)"
                      >启用</button>
                      <button class="btn small" type="button" @click="openForm(section.kind, card.primary)">编辑</button>
                      <button class="text-action danger" type="button" @click="removeModel(section.kind, card.primary.id)">清除</button>
                    </div>
                  </template>

                  <div v-else class="provider-empty">
                    <p>{{ card.provider.hint || '配置 API 地址、模型名称和访问密钥后即可使用。' }}</p>
                    <button class="btn primary" type="button" @click="openForm(section.kind, undefined, card.provider.id)">
                      配置
                    </button>
                  </div>

                  <div v-if="card.extras.length" class="extra-configs">
                    <div class="extra-configs-title">其他配置</div>
                    <div v-for="extra in card.extras" :key="extra.id" class="extra-config">
                      <div class="extra-title">
                        <strong>{{ extra.name }}</strong>
                        <span>
                          {{ extra.model }}<template v-if="section.kind === 'emb'"> · {{ extra.dim }} 维</template>
                        </span>
                      </div>
                      <span v-if="extra.id === section.activeId" class="status-indicator active">使用中</span>
                      <div class="extra-actions">
                        <button class="text-action" type="button" :disabled="!extra.apiKey || testingId === extra.id" @click="testOne(section.kind, extra)">测试</button>
                        <button v-if="extra.id !== section.activeId" class="text-action accent" type="button" :disabled="!extra.apiKey" @click="selectModel(section.kind, extra.id)">启用</button>
                        <button class="text-action" type="button" @click="openForm(section.kind, extra)">编辑</button>
                        <button class="text-action danger" type="button" @click="removeModel(section.kind, extra.id)">删除</button>
                      </div>
                      <p
                        v-if="cardTest[extra.id]"
                        class="inline-result"
                        :class="cardTest[extra.id].ok ? 'ok' : 'err'"
                      >{{ cardTest[extra.id].ok ? '连接成功' : cardTest[extra.id].error }}</p>
                    </div>
                  </div>

                  <button
                    v-if="card.primary"
                    class="add-provider-config"
                    type="button"
                    @click="openForm(section.kind, undefined, card.provider.id)"
                  >
                    <Icon name="plus" :size="13" />
                    添加同厂商配置
                  </button>
                </article>
              </div>

              <div v-if="section.unknown.length" class="unknown-configs">
                <div class="subsection-head">
                  <h4>自定义与历史配置</h4>
                  <span>{{ section.unknown.length }} 项</span>
                </div>
                <div class="unknown-grid">
                  <article
                    v-for="model in section.unknown"
                    :key="model.id"
                    class="custom-model-row"
                    :class="{ active: model.id === section.activeId }"
                  >
                    <div class="provider-mark">{{ providerMark(providerName(model.provider)) }}</div>
                    <div class="custom-model-copy">
                      <strong>{{ model.name }}</strong>
                      <span>
                        {{ providerName(model.provider) }} · {{ model.model }}
                        <template v-if="section.kind === 'emb'"> · {{ model.dim }} 维</template>
                      </span>
                    </div>
                    <span v-if="model.id === section.activeId" class="status-indicator active">使用中</span>
                    <div class="custom-model-actions">
                      <button class="text-action" type="button" :disabled="!model.apiKey || testingId === model.id" @click="testOne(section.kind, model)">测试</button>
                      <button v-if="model.id !== section.activeId" class="text-action accent" type="button" :disabled="!model.apiKey" @click="selectModel(section.kind, model.id)">启用</button>
                      <button class="text-action" type="button" @click="openForm(section.kind, model)">编辑</button>
                      <button class="text-action danger" type="button" @click="removeModel(section.kind, model.id)">删除</button>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </template>
        </section>

        <section v-show="activeSettingsSection === 'automation'" class="settings-panel">
          <div class="panel-head">
            <div>
              <h3>自动化</h3>
              <p>安排知识库的夜间整理任务。</p>
            </div>
          </div>

          <div class="settings-group">
            <div class="setting-row">
              <div class="setting-copy">
                <strong>Dream Cycle</strong>
                <span>按计划自动整理资料、关系和索引。</span>
              </div>
              <label class="switch-control">
                <input v-model="dreamEnabled" type="checkbox" @change="saveDream" />
                <span aria-hidden="true"></span>
                <em>{{ dreamEnabled ? '已启用' : '已停用' }}</em>
              </label>
            </div>
            <div class="setting-row">
              <div class="setting-copy">
                <strong>运行计划</strong>
                <span>使用 cron 表达式，默认每天 03:00。</span>
              </div>
              <input v-model="dreamCron" class="cron-input" aria-label="Dream Cycle cron 表达式" @change="saveDream" />
            </div>
          </div>
        </section>

        <section v-show="activeSettingsSection === 'mcp'" class="settings-panel">
          <div class="panel-head">
            <div>
              <h3>MCP 集成</h3>
              <p>为 Claude Code、Cursor 等客户端提供知识库访问能力。</p>
            </div>
            <button class="btn primary" type="button" @click="newToken">
              <Icon name="plus" :size="15" />
              生成 Token
            </button>
          </div>

          <div class="endpoint-block">
            <div>
              <span>MCP Server 地址</span>
              <code>{{ mcpUrl }}</code>
            </div>
            <button class="btn" type="button" @click="copy(mcpUrl)">复制地址</button>
          </div>

          <div class="integration-note">
            请求头使用 <code>Authorization: Bearer &lt;token&gt;</code>。
          </div>

          <div v-if="mcpTokens.length" class="token-list">
            <div v-for="tokenItem in mcpTokens" :key="tokenItem.id" class="token-row">
              <div class="token-copy">
                <strong>{{ tokenItem.name }}</strong>
                <code class="token">{{ tokenItem.token }}</code>
              </div>
              <div class="token-actions">
                <button class="btn small" type="button" @click="copy(tokenItem.token)">复制</button>
                <button class="text-action danger" type="button" @click="delToken(tokenItem.id)">删除</button>
              </div>
            </div>
          </div>
          <div v-else class="empty-panel">尚未生成访问 Token。</div>
        </section>

        <section v-show="activeSettingsSection === 'storage'" class="settings-panel trash-section">
          <div class="panel-head">
            <div>
              <h3>存储空间</h3>
              <p>
                {{ trashLoading ? '正在读取回收站...' : `回收站中有 ${trashItems.length} 个项目，共 ${formatBytes(trashTotalSize)}` }}
              </p>
            </div>
            <button class="btn danger" type="button" :disabled="trashLoading || !trashItems.length" @click="emptyTrash">
              <Icon name="trash" :size="14" />
              清空回收站
            </button>
          </div>

          <div class="trash-tools">
            <label class="trash-select-all">
              <input
                type="checkbox"
                :checked="allVisibleTrashSelected"
                :disabled="!filteredTrash.length"
                @change="toggleAllTrash"
              />
              <span>全选</span>
            </label>
            <input v-model="trashQuery" class="trash-filter" placeholder="筛选名称或原路径" />
            <button class="btn small" type="button" :disabled="!selectedTrash.size || trashBusy" @click="restoreSelectedTrash">
              <Icon name="restore" :size="14" />
              恢复所选
            </button>
            <button class="btn small danger" type="button" :disabled="!selectedTrash.size || trashBusy" @click="deleteSelectedTrash">
              <Icon name="trash" :size="14" />
              永久删除
            </button>
          </div>

          <div v-if="filteredTrash.length" class="trash-list">
            <div v-for="item in filteredTrash" :key="item.id" class="trash-row">
              <input
                type="checkbox"
                :checked="selectedTrash.has(item.id)"
                :aria-label="`选择 ${item.name}`"
                @change="toggleTrash(item.id)"
              />
              <Icon :name="item.kind === 'page' ? 'pages' : 'attach'" :size="16" class="trash-kind" />
              <div class="trash-main">
                <div class="trash-name-line">
                  <span class="trash-name" :title="item.name">{{ item.name }}</span>
                  <span v-if="item.legacy" class="legacy-tag">历史项目</span>
                </div>
                <div class="trash-meta" :title="item.originalPath">
                  <span>{{ item.originalPath }}</span>
                  <span>{{ formatTrashDate(item.deletedAt) }}</span>
                  <span>{{ formatBytes(item.size) }}</span>
                </div>
              </div>
              <div class="trash-actions">
                <button class="icon-btn" type="button" title="恢复" :disabled="trashBusy" @click="restoreTrash([item.id])">
                  <Icon name="restore" :size="15" />
                </button>
                <button class="icon-btn danger-icon" type="button" title="永久删除" :disabled="trashBusy" @click="deleteTrash([item.id])">
                  <Icon name="trash" :size="15" />
                </button>
              </div>
            </div>
          </div>
          <p v-else-if="trashLoading" class="trash-empty">正在读取回收站...</p>
          <p v-else class="trash-empty">{{ trashQuery ? '没有匹配的项目' : '回收站为空' }}</p>
          <p v-if="trashMsg" class="setting-message" :class="trashOk ? 'ok' : 'err'">{{ trashMsg }}</p>
        </section>

        <section v-show="activeSettingsSection === 'data'" class="settings-panel">
          <div class="panel-head">
            <div>
              <h3>数据管理</h3>
              <p>查看本地存储方式并执行不可撤销的数据操作。</p>
            </div>
          </div>

          <div class="data-location">
            <Icon name="folder" :size="20" />
            <div>
              <strong>本地 Markdown 数据</strong>
              <p>知识内容位于服务端 <code>data/brain/</code>，复制整个 <code>data/</code> 目录即可完成备份。</p>
            </div>
          </div>

          <div class="danger-section">
            <div class="danger-section-head">
              <h4>危险操作</h4>
              <span>执行前需要再次确认登录密码。</span>
            </div>
            <div class="danger-row">
              <div>
                <strong>清空 AI 整理日志</strong>
                <p>删除 AIWorks/log 下的运行日志，概念、实体和原始资料不受影响。</p>
              </div>
              <button class="btn danger" type="button" @click="wipeAiLogs">清空日志</button>
            </div>
            <div class="danger-row">
              <div>
                <strong>一键清除知识数据</strong>
                <p>删除全部概念、实体、原始资料、归档和查询页面，并重置索引。</p>
              </div>
              <button class="btn danger solid" type="button" @click="wipe">一键清除</button>
            </div>
          </div>
          <p v-if="wipeMsg" class="setting-message" :class="wipeOk ? 'ok' : 'err'">{{ wipeMsg }}</p>
        </section>
      </div>
    </div>

    <div v-if="form.show" class="modal-mask" @click.self="form.show = false">
      <div
        class="model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-dialog-title"
      >
        <div class="dialog-head">
          <div>
            <span>{{ form.kind === 'chat' ? '对话模型' : 'Embedding 模型' }}</span>
            <h3 id="model-dialog-title">{{ form.id ? '编辑模型配置' : '添加模型配置' }}</h3>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="form.show = false">
            <Icon name="x" :size="18" />
          </button>
        </div>

        <div class="dialog-body">
          <div class="modal-form">
            <div class="field">
              <label for="model-name">备注名</label>
              <input id="model-name" v-model="form.name" placeholder="例如：主力配置" />
            </div>
            <div class="field">
              <label for="model-provider">服务商</label>
              <select id="model-provider" v-model="form.provider" @change="pickProvider(form.provider)">
                <option v-if="!providerById(form.provider)" :value="form.provider">{{ providerName(form.provider) }}</option>
                <option v-for="provider in providerOptions" :key="provider.id" :value="provider.id">
                  {{ provider.name }}
                </option>
              </select>
            </div>
            <div class="field">
              <label for="model-line">线路</label>
              <select id="model-line" v-model="form.line" @change="onFormLineChange">
                <option v-for="line in linesFor(currentFormProvider, form.kind)" :key="line.id" :value="line.id">
                  {{ line.name }}
                </option>
              </select>
            </div>
            <div class="field">
              <label for="model-choice">模型</label>
              <select id="model-choice" v-model="form.modelChoice" @change="onFormModelChange">
                <option v-for="model in formModelOptions" :key="model.id" :value="model.id">{{ model.name }}</option>
                <option value="__custom__">自定义模型名称</option>
              </select>
            </div>
            <div v-if="form.modelChoice === '__custom__'" class="field field-wide">
              <label for="custom-model-name">自定义模型名称</label>
              <input id="custom-model-name" v-model="form.model" placeholder="完整模型 ID 或 ep- 接入点" />
            </div>
            <div class="field field-wide">
              <label for="model-base-url">Base URL</label>
              <input id="model-base-url" v-model="form.baseUrl" placeholder="https://.../v1" />
            </div>
            <div class="field">
              <label for="model-api-key">API Key</label>
              <input id="model-api-key" v-model="form.apiKey" type="password" :placeholder="formKeyPlaceholder" />
              <span v-if="form.id" class="field-help">留空保持原 Key</span>
            </div>
            <div v-if="form.kind === 'emb'" class="field">
              <label for="model-dimension">向量维度</label>
              <select v-if="formDimensionOptions.length" id="model-dimension" v-model.number="form.dim">
                <option v-for="dim in formDimensionOptions" :key="dim" :value="dim">{{ dim }}</option>
              </select>
              <input v-else id="model-dimension" v-model.number="form.dim" type="number" min="1" placeholder="1024" />
            </div>
          </div>
          <p v-if="formHint" class="dialog-hint">{{ formHint }}</p>
          <p v-if="formError" class="setting-message err">{{ formError }}</p>
          <p v-if="formTest" class="setting-message" :class="formTest.ok ? 'ok' : 'err'">
            {{ formTest.ok ? '连接成功' : formTest.error }}
          </p>
        </div>

        <div class="dialog-actions">
          <button class="btn" type="button" :disabled="formTesting || !effectiveFormApiKey" @click="testForm">
            {{ formTesting ? '测试中...' : '测试连接' }}
          </button>
          <div>
            <button class="btn" type="button" @click="form.show = false">取消</button>
            <button class="btn primary" type="button" :disabled="formSaving" @click="saveModel">
              {{ formSaving ? '保存中...' : '保存配置' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon.vue';
import {
  PROVIDERS,
  modelById,
  providerById,
  type ApiLine,
  type ModelOption,
  type ProviderPreset,
} from '../presets';

type ModelKind = 'chat' | 'emb';
type SettingsSection = 'account' | 'models' | 'automation' | 'mcp' | 'storage' | 'data';
type DraftField = 'model' | 'baseUrl' | 'apiKey' | 'dim';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  line?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  dim?: number;
  supportsDimensions?: boolean;
}

interface ModelDraft {
  line: string;
  baseUrl: string;
  model: string;
  modelChoice: string;
  apiKey: string;
  dim: number;
}

interface ProviderCard {
  provider: ProviderPreset;
  primary?: ModelEntry;
  extras: ModelEntry[];
}

interface TrashEntry {
  id: string;
  kind: 'page' | 'file';
  name: string;
  originalPath: string;
  deletedAt: string;
  size: number;
  legacy: boolean;
}

const app = useAppStore();
const auth = useAuthStore();

const activeSettingsSection = ref<SettingsSection>('account');
const activeModelKind = ref<ModelKind>('chat');
const settingsNavigation: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'account', label: '账户与外观', icon: 'settings' },
  { id: 'models', label: '模型配置', icon: 'ai' },
  { id: 'automation', label: '自动化', icon: 'activity' },
  { id: 'mcp', label: 'MCP 集成', icon: 'link' },
  { id: 'storage', label: '存储空间', icon: 'archive' },
  { id: 'data', label: '数据管理', icon: 'trash' },
];

const chatModels = ref<ModelEntry[]>([]);
const embModels = ref<ModelEntry[]>([]);
const activeChat = ref('');
const activeEmb = ref('');

function activeModelFor(kind: ModelKind): ModelEntry | undefined {
  const list = kind === 'chat' ? chatModels.value : embModels.value;
  const activeId = kind === 'chat' ? activeChat.value : activeEmb.value;
  return list.find((model) => model.id === activeId);
}

function configuredProviderCount(section: { cards: ProviderCard[] }): number {
  return section.cards.filter((card) => Boolean(card.primary?.apiKey)).length;
}

function providerMark(name: string): string {
  const compact = name.trim().replace(/\s+/g, '');
  return compact.slice(0, 2).toUpperCase() || 'AI';
}

const cardTest = reactive<Record<string, { ok: boolean; error?: string }>>({});
const testingId = ref('');
const testingAll = ref(false);
const testResult = ref('');
const testOk = ref(false);

const quickDrafts = reactive<Record<string, ModelDraft>>({});
const quickErrors = reactive<Record<string, string>>({});
const quickSavingKey = ref('');
const editingId = ref('');
const editingKind = ref<ModelKind>('chat');
const inlineDraft = reactive<ModelDraft>(blankDraft());
const inlineError = ref('');
const inlineSaving = ref(false);

const pwd = ref({ old: '', next: '' });
const pwdMsg = ref('');
const pwdOk = ref(false);

const dreamEnabled = ref(true);
const dreamCron = ref('0 3 * * *');
const mcpTokens = ref<any[]>([]);
const mcpUrl = computed(() => `${location.origin}/mcp`);
const trashItems = ref<TrashEntry[]>([]);
const trashTotalSize = ref(0);
const trashLoading = ref(false);
const trashBusy = ref(false);
const trashQuery = ref('');
const selectedTrash = ref(new Set<string>());
const trashMsg = ref('');
const trashOk = ref(true);
const filteredTrash = computed(() => {
  const query = trashQuery.value.trim().toLowerCase();
  if (!query) return trashItems.value;
  return trashItems.value.filter((item) =>
    item.name.toLowerCase().includes(query) || item.originalPath.toLowerCase().includes(query)
  );
});
const allVisibleTrashSelected = computed(() =>
  filteredTrash.value.length > 0 && filteredTrash.value.every((item) => selectedTrash.value.has(item.id))
);

const form = ref({
  show: false,
  kind: 'chat' as ModelKind,
  id: '',
  name: '',
  provider: 'custom',
  line: 'custom',
  baseUrl: '',
  model: '',
  modelChoice: '__custom__',
  apiKey: '',
  dim: 1024,
});
const formTest = ref<{ ok: boolean; error?: string } | null>(null);
const formTesting = ref(false);
const formSaving = ref(false);
const formError = ref('');

const fixedChatProviders = computed(() => PROVIDERS.filter((provider) => provider.id !== 'custom'));
const fixedEmbeddingProviders = computed(() =>
  PROVIDERS.filter((provider) => provider.id !== 'custom' && provider.embeddingModels.length > 0)
);

function cardsFor(kind: ModelKind): ProviderCard[] {
  const providers = kind === 'chat' ? fixedChatProviders.value : fixedEmbeddingProviders.value;
  const list = kind === 'chat' ? chatModels.value : embModels.value;
  return providers.map((provider) => {
    const matches = list.filter((model) => model.provider === provider.id);
    return { provider, primary: matches[0], extras: matches.slice(1) };
  });
}

function unknownModels(kind: ModelKind): ModelEntry[] {
  const fixedIds = new Set(
    (kind === 'chat' ? fixedChatProviders.value : fixedEmbeddingProviders.value).map((provider) => provider.id)
  );
  const list = kind === 'chat' ? chatModels.value : embModels.value;
  return list.filter((model) => !fixedIds.has(model.provider));
}

const modelSections = computed(() => [
  {
    kind: 'chat' as const,
    title: '对话模型',
    copy: '每个厂商固定一张主卡，可添加多个独立配置。',
    cards: cardsFor('chat'),
    unknown: unknownModels('chat'),
    activeId: activeChat.value,
  },
  {
    kind: 'emb' as const,
    title: 'Embedding 模型（语义检索）',
    copy: '只显示提供文本向量模型的厂商。切换模型或维度后会自动重建索引。',
    cards: cardsFor('emb'),
    unknown: unknownModels('emb'),
    activeId: activeEmb.value,
  },
]);

const providerOptions = computed(() =>
  form.value.kind === 'emb'
    ? PROVIDERS.filter((provider) => provider.embeddingModels.length > 0 || provider.id === 'custom')
    : PROVIDERS
);

const customPreset = providerById('custom')!;
const currentFormProvider = computed<ProviderPreset>(() => {
  const preset = providerById(form.value.provider);
  if (preset) return preset;
  return { ...customPreset, id: form.value.provider, name: providerName(form.value.provider) };
});
const formModelOptions = computed(() => modelOptionsForDraft(form.value.kind, currentFormProvider.value, form.value));
const formDimensionOptions = computed(() => dimensionOptionsForDraft(currentFormProvider.value, form.value));
const formLine = computed(() => lineFor(currentFormProvider.value, form.value.line, form.value.kind));
const formKeyPlaceholder = computed(() => formLine.value?.apiKeyPlaceholder || 'API Key');
const formHint = computed(() => formLine.value?.hint || currentFormProvider.value.hint || '');
const existingFormEntry = computed(() => {
  if (!form.value.id) return undefined;
  const list = form.value.kind === 'chat' ? chatModels.value : embModels.value;
  return list.find((model) => model.id === form.value.id);
});
const effectiveFormApiKey = computed(() => form.value.apiKey.trim() || existingFormEntry.value?.apiKey || '');

function blankDraft(): ModelDraft {
  return { line: '', baseUrl: '', model: '', modelChoice: '__custom__', apiKey: '', dim: 1024 };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function linesFor(provider: ProviderPreset, kind: ModelKind): ApiLine[] {
  if (kind === 'emb') {
    const payg = provider.lines.filter((line) => line.type === 'payg');
    return payg.length ? payg : provider.lines;
  }
  return provider.lines;
}

function lineFor(provider: ProviderPreset, lineId: string | undefined, kind: ModelKind): ApiLine | undefined {
  const lines = linesFor(provider, kind);
  return lines.find((line) => line.id === lineId) || lines[0];
}

function inferLine(provider: ProviderPreset, entry: ModelEntry | undefined, kind: ModelKind): string {
  const lines = linesFor(provider, kind);
  if (entry?.line && lines.some((line) => line.id === entry.line)) return entry.line;
  const baseUrl = normalizeUrl(entry?.baseUrl || '');
  return lines.find((line) => normalizeUrl(line.baseUrl) === baseUrl)?.id || lines[0]?.id || '';
}

function providerModels(provider: ProviderPreset, kind: ModelKind): ModelOption[] {
  return kind === 'chat' ? provider.chatModels : provider.embeddingModels;
}

function modelOptionsForDraft(kind: ModelKind, provider: ProviderPreset, draft: Pick<ModelDraft, 'line'>): ModelOption[] {
  const models = providerModels(provider, kind);
  const line = lineFor(provider, draft.line, kind);
  if (kind === 'chat' && line?.models?.length) {
    return line.models.map((id) => modelById(provider.id, id, 'chat') || { id, name: id });
  }
  return models;
}

function modelOptionForDraft(kind: ModelKind, provider: ProviderPreset, draft: Pick<ModelDraft, 'model' | 'modelChoice'>) {
  if (draft.modelChoice === '__custom__') return undefined;
  return modelById(provider.id, draft.modelChoice || draft.model, kind === 'chat' ? 'chat' : 'embedding');
}

function dimensionOptionsForDraft(provider: ProviderPreset, draft: Pick<ModelDraft, 'model' | 'modelChoice'>): number[] {
  return modelOptionForDraft('emb', provider, draft)?.dimensions || [];
}

function defaultModel(provider: ProviderPreset, kind: ModelKind, lineId: string): ModelOption | undefined {
  const available = modelOptionsForDraft(kind, provider, { line: lineId });
  const defaultId = kind === 'chat' ? provider.defaultChat : provider.defaultEmbedding;
  return available.find((model) => model.id === defaultId) || available[0];
}

function createDraft(kind: ModelKind, provider: ProviderPreset, existing?: ModelEntry): ModelDraft {
  const line = inferLine(provider, existing, kind);
  const available = modelOptionsForDraft(kind, provider, { line });
  const existingOption = existing
    ? available.find((model) => model.id === existing.model)
    : defaultModel(provider, kind, line);
  const selected = existingOption || (!existing ? defaultModel(provider, kind, line) : undefined);
  return {
    line,
    baseUrl: existing?.baseUrl || lineFor(provider, line, kind)?.baseUrl || '',
    model: existing?.model || selected?.id || '',
    modelChoice: existingOption || (!existing && selected) ? (existingOption || selected)!.id : '__custom__',
    apiKey: '',
    dim: existing?.dim || selected?.dim || 1024,
  };
}

function quickKey(kind: ModelKind, providerId: string): string {
  return `${kind}:${providerId}`;
}

function draftFor(kind: ModelKind, provider: ProviderPreset): ModelDraft {
  const key = quickKey(kind, provider.id);
  if (!quickDrafts[key]) quickDrafts[key] = createDraft(kind, provider);
  return quickDrafts[key];
}

function cardDraft(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): ModelDraft {
  return primary ? inlineDraft : draftFor(kind, provider);
}

function setCardDraftValue(
  kind: ModelKind,
  provider: ProviderPreset,
  primary: ModelEntry | undefined,
  field: DraftField,
  value: string | number
) {
  const draft = cardDraft(kind, provider, primary);
  if (field === 'dim') draft.dim = Number(value) || 0;
  else draft[field] = String(value);
}

function applyLineToDraft(kind: ModelKind, provider: ProviderPreset, draft: ModelDraft, lineId: string) {
  draft.line = lineId;
  const line = lineFor(provider, lineId, kind);
  if (line) draft.baseUrl = line.baseUrl;
  const available = modelOptionsForDraft(kind, provider, draft);
  if (line?.models?.length || (draft.modelChoice !== '__custom__' && !available.some((m) => m.id === draft.modelChoice))) {
    const next = defaultModel(provider, kind, lineId);
    draft.modelChoice = next?.id || '__custom__';
    draft.model = next?.id || '';
    if (kind === 'emb') draft.dim = next?.dim || 1024;
  }
}

function applyModelToDraft(kind: ModelKind, provider: ProviderPreset, draft: ModelDraft, choice: string) {
  draft.modelChoice = choice;
  if (choice === '__custom__') {
    draft.model = '';
    return;
  }
  draft.model = choice;
  if (kind === 'emb') {
    const option = modelById(provider.id, choice, 'embedding');
    if (option?.dim) draft.dim = option.dim;
  }
}

function changeCardLine(
  kind: ModelKind,
  provider: ProviderPreset,
  primary: ModelEntry | undefined,
  lineId: string
) {
  applyLineToDraft(kind, provider, cardDraft(kind, provider, primary), lineId);
  clearCardError(kind, provider, primary);
}

function changeCardModel(
  kind: ModelKind,
  provider: ProviderPreset,
  primary: ModelEntry | undefined,
  choice: string
) {
  applyModelToDraft(kind, provider, cardDraft(kind, provider, primary), choice);
  clearCardError(kind, provider, primary);
}

function clearCardError(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry) {
  if (primary) inlineError.value = '';
  else quickErrors[quickKey(kind, provider.id)] = '';
}

function cardFormError(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): string {
  return primary ? inlineError.value : quickErrors[quickKey(kind, provider.id)] || '';
}

function cardFormBusy(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): boolean {
  return primary ? inlineSaving.value : quickSavingKey.value === quickKey(kind, provider.id);
}

function cardKeyPlaceholder(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): string {
  if (primary) return '留空保持原 Key';
  return lineFor(provider, draftFor(kind, provider).line, kind)?.apiKeyPlaceholder || 'API Key';
}

function lineName(provider: ProviderPreset, lineId?: string, baseUrl?: string): string {
  const matched = provider.lines.find((line) => line.id === lineId)
    || provider.lines.find((line) => normalizeUrl(line.baseUrl) === normalizeUrl(baseUrl || ''));
  return matched?.name || provider.lines[0]?.name || '自定义线路';
}

function providerName(id: string): string {
  return providerById(id)?.name || id || '自定义';
}

function maskKey(key: string): string {
  if (!key) return '未填 Key';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function toggleInlineEdit(kind: ModelKind, entry: ModelEntry) {
  if (editingId.value === entry.id) {
    closeInlineEdit();
    return;
  }
  const provider = providerById(entry.provider) || { ...customPreset, id: entry.provider, name: providerName(entry.provider) };
  Object.assign(inlineDraft, createDraft(kind, provider, entry));
  editingId.value = entry.id;
  editingKind.value = kind;
  inlineError.value = '';
}

function closeInlineEdit() {
  editingId.value = '';
  inlineError.value = '';
}

function modelValue(draft: ModelDraft): string {
  return (draft.modelChoice === '__custom__' ? draft.model : draft.modelChoice).trim();
}

function validateDraft(draft: ModelDraft, kind: ModelKind, apiKey: string): string {
  if (!normalizeUrl(draft.baseUrl)) return '请填写 Base URL。';
  if (!modelValue(draft)) return '请填写模型名称。';
  if (!apiKey.trim()) return '请填写 API Key。';
  if (kind === 'emb' && (!Number.isFinite(draft.dim) || draft.dim <= 0)) return '请填写有效的向量维度。';
  return '';
}

function entryFromDraft(
  kind: ModelKind,
  provider: ProviderPreset,
  draft: ModelDraft,
  existing?: ModelEntry,
  name?: string
): ModelEntry {
  const model = modelValue(draft);
  const option = modelOptionForDraft(kind, provider, draft);
  const supportsDimensions = kind === 'emb'
    ? option?.supportsDimensions === true
      || (!option && existing?.model === model && existing.supportsDimensions === true)
    : undefined;
  return {
    id: existing?.id || newId(),
    name: name?.trim() || existing?.name || provider.name,
    provider: existing?.provider || provider.id,
    line: draft.line,
    baseUrl: normalizeUrl(draft.baseUrl),
    model,
    apiKey: draft.apiKey.trim() || existing?.apiKey || '',
    ...(kind === 'emb' ? { dim: draft.dim || option?.dim || 1024, supportsDimensions } : {}),
  };
}

async function saveCardDraft(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry) {
  if (primary) await saveInlineEdit(kind, provider, primary);
  else await saveQuick(kind, provider);
}

async function saveQuick(kind: ModelKind, provider: ProviderPreset) {
  const key = quickKey(kind, provider.id);
  const draft = draftFor(kind, provider);
  quickErrors[key] = '';
  const error = validateDraft(draft, kind, draft.apiKey);
  if (error) {
    quickErrors[key] = error;
    return;
  }
  quickSavingKey.value = key;
  const previousList = [...(kind === 'chat' ? chatModels.value : embModels.value)];
  const previousActive = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    const entry = entryFromDraft(kind, provider, draft);
    if (kind === 'chat') {
      chatModels.value.push(entry);
      if (!activeChat.value) activeChat.value = entry.id;
    } else {
      embModels.value.push(entry);
      if (!activeEmb.value) activeEmb.value = entry.id;
    }
    await persist();
    delete quickDrafts[key];
  } catch (error: any) {
    if (kind === 'chat') {
      chatModels.value = previousList;
      activeChat.value = previousActive;
    } else {
      embModels.value = previousList;
      activeEmb.value = previousActive;
    }
    quickErrors[key] = errorMessage(error, '保存失败，请重试。');
  } finally {
    quickSavingKey.value = '';
  }
}

async function saveInlineEdit(kind: ModelKind, provider: ProviderPreset, existing: ModelEntry) {
  inlineError.value = '';
  const effectiveKey = inlineDraft.apiKey.trim() || existing.apiKey;
  const error = validateDraft(inlineDraft, kind, effectiveKey);
  if (error) {
    inlineError.value = error;
    return;
  }
  inlineSaving.value = true;
  const list = kind === 'chat' ? chatModels : embModels;
  const index = list.value.findIndex((model) => model.id === existing.id);
  const previous = index >= 0 ? { ...list.value[index] } : undefined;
  try {
    const entry = entryFromDraft(kind, provider, inlineDraft, existing);
    if (index < 0) throw new Error('找不到要编辑的配置。');
    list.value[index] = entry;
    await persist();
    closeInlineEdit();
  } catch (error: any) {
    if (index >= 0 && previous) list.value[index] = previous;
    inlineError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    inlineSaving.value = false;
  }
}

function openForm(kind: ModelKind, existing?: ModelEntry, providerId?: string) {
  formTest.value = null;
  formError.value = '';
  const id = existing?.provider || providerId || 'custom';
  const provider = providerById(id) || { ...customPreset, id, name: providerName(id) };
  const draft = createDraft(kind, provider, existing);
  form.value = {
    show: true,
    kind,
    id: existing?.id || '',
    name: existing?.name || '',
    provider: id,
    ...draft,
  };
}

function pickProvider(id: string) {
  const provider = providerById(id) || customPreset;
  const draft = createDraft(form.value.kind, provider);
  form.value.line = draft.line;
  form.value.baseUrl = draft.baseUrl;
  form.value.model = draft.model;
  form.value.modelChoice = draft.modelChoice;
  form.value.dim = draft.dim;
  if (!form.value.name) form.value.name = provider.name;
  formTest.value = null;
  formError.value = '';
}

function onFormLineChange() {
  applyLineToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.line);
  formTest.value = null;
  formError.value = '';
}

function onFormModelChange() {
  applyModelToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.modelChoice);
  formTest.value = null;
  formError.value = '';
}

async function persist() {
  await api.put('/api/settings', {
    chat_models: JSON.stringify(chatModels.value),
    active_chat_model: activeChat.value,
    embedding_models: JSON.stringify(embModels.value),
    active_embedding_model: activeEmb.value,
  });
}

async function saveModel() {
  formError.value = '';
  const existing = existingFormEntry.value;
  const effectiveKey = form.value.apiKey.trim() || existing?.apiKey || '';
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formSaving.value = true;
  const kind = form.value.kind;
  const list = kind === 'chat' ? chatModels : embModels;
  const previousList = list.value.map((model) => ({ ...model }));
  const previousActive = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    const entry = entryFromDraft(kind, currentFormProvider.value, form.value, existing, form.value.name);
    const index = list.value.findIndex((model) => model.id === entry.id);
    if (index >= 0) list.value[index] = entry;
    else list.value.push(entry);
    if (kind === 'chat' && !activeChat.value) activeChat.value = entry.id;
    if (kind === 'emb' && !activeEmb.value) activeEmb.value = entry.id;
    await persist();
    form.value.show = false;
  } catch (error: any) {
    list.value = previousList;
    if (kind === 'chat') activeChat.value = previousActive;
    else activeEmb.value = previousActive;
    formError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    formSaving.value = false;
  }
}

async function selectModel(kind: ModelKind, id: string) {
  const previous = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    if (kind === 'chat') activeChat.value = id;
    else activeEmb.value = id;
    await persist();
  } catch (error: any) {
    if (kind === 'chat') activeChat.value = previous;
    else activeEmb.value = previous;
    cardTest[id] = { ok: false, error: errorMessage(error, '启用失败，请重试。') };
  }
}

async function removeModel(kind: ModelKind, id: string) {
  if (!confirm('删除该模型配置？')) return;
  const previousList = [...(kind === 'chat' ? chatModels.value : embModels.value)];
  const previousActive = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    delete cardTest[id];
    if (kind === 'chat') {
      chatModels.value = chatModels.value.filter((model) => model.id !== id);
      if (activeChat.value === id) activeChat.value = chatModels.value[0]?.id || '';
    } else {
      embModels.value = embModels.value.filter((model) => model.id !== id);
      if (activeEmb.value === id) activeEmb.value = embModels.value[0]?.id || '';
    }
    await persist();
    if (editingId.value === id) closeInlineEdit();
  } catch (error: any) {
    if (kind === 'chat') {
      chatModels.value = previousList;
      activeChat.value = previousActive;
    } else {
      embModels.value = previousList;
      activeEmb.value = previousActive;
    }
    cardTest[id] = { ok: false, error: errorMessage(error, '删除失败，请重试。') };
  }
}

async function testOne(kind: ModelKind, model: ModelEntry) {
  if (!model.apiKey) return;
  testingId.value = model.id;
  delete cardTest[model.id];
  try {
    const { data } = await api.post('/api/settings/test-llm', {
      entry: model,
      kind: kind === 'chat' ? 'chat' : 'embedding',
    });
    cardTest[model.id] = { ok: data.ok, error: data.error };
  } catch (error: any) {
    cardTest[model.id] = { ok: false, error: errorMessage(error, '连接测试失败。') };
  } finally {
    testingId.value = '';
  }
}

async function testForm() {
  formError.value = '';
  formTest.value = null;
  const existing = existingFormEntry.value;
  const effectiveKey = form.value.apiKey.trim() || existing?.apiKey || '';
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formTesting.value = true;
  try {
    const entry = entryFromDraft(form.value.kind, currentFormProvider.value, form.value, existing, form.value.name);
    const { data } = await api.post('/api/settings/test-llm', {
      entry,
      kind: form.value.kind === 'chat' ? 'chat' : 'embedding',
    });
    formTest.value = { ok: data.ok, error: data.error };
  } catch (error: any) {
    formTest.value = { ok: false, error: errorMessage(error, '连接测试失败。') };
  } finally {
    formTesting.value = false;
  }
}

async function testAll() {
  testingAll.value = true;
  testResult.value = '';
  try {
    const { data } = await api.post('/api/settings/test-llm');
    testOk.value = data.chat && data.embedding;
    testResult.value = testOk.value
      ? '对话与 Embedding 均连接成功'
      : `连接异常：${data.error || (data.chat ? 'Embedding 失败' : '对话模型失败')}`;
  } catch (error: any) {
    testOk.value = false;
    testResult.value = errorMessage(error, '连接测试失败。');
  } finally {
    testingAll.value = false;
  }
}

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.message || fallback;
}

async function rebuild() {
  if (!confirm('将重新扫描并索引全部页面，可能需要几分钟。继续？')) return;
  await api.post('/api/settings/rebuild-index');
  testResult.value = '索引重建已在后台开始';
  testOk.value = true;
}

async function changePwd() {
  pwdMsg.value = '';
  try {
    await api.post('/api/auth/password', {
      oldPassword: pwd.value.old,
      newPassword: pwd.value.next,
    });
    pwdOk.value = true;
    pwdMsg.value = '密码已修改';
    pwd.value = { old: '', next: '' };
  } catch (error: any) {
    pwdOk.value = false;
    pwdMsg.value = error.response?.data?.error || '修改失败';
  }
}

async function saveDream() {
  await api.post('/api/dream/schedule', { cron: dreamCron.value, enabled: dreamEnabled.value });
}

async function newToken() {
  const name = prompt('Token 备注名：', 'claude-code') || 'default';
  await api.post('/api/settings/mcp-tokens', { name });
  const { data } = await api.get('/api/settings/mcp-tokens');
  mcpTokens.value = data.tokens;
}

async function delToken(id: number) {
  if (!confirm('删除后使用该 token 的客户端将无法访问。继续？')) return;
  await api.delete(`/api/settings/mcp-tokens/${id}`);
  mcpTokens.value = mcpTokens.value.filter((tokenItem) => tokenItem.id !== id);
}

function copy(text: string) {
  navigator.clipboard.writeText(text);
}

function logout() {
  auth.logout();
}

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatTrashDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toggleTrash(id: string) {
  const next = new Set(selectedTrash.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTrash.value = next;
}

function toggleAllTrash() {
  const next = new Set(selectedTrash.value);
  if (allVisibleTrashSelected.value) {
    filteredTrash.value.forEach((item) => next.delete(item.id));
  } else {
    filteredTrash.value.forEach((item) => next.add(item.id));
  }
  selectedTrash.value = next;
}

async function loadTrash() {
  trashLoading.value = true;
  try {
    const { data } = await api.get('/api/trash');
    trashItems.value = data.items;
    trashTotalSize.value = data.totalSize;
    const available = new Set(trashItems.value.map((item) => item.id));
    selectedTrash.value = new Set([...selectedTrash.value].filter((id) => available.has(id)));
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '回收站读取失败';
  } finally {
    trashLoading.value = false;
  }
}

async function restoreTrash(ids: string[]) {
  if (!ids.length || trashBusy.value) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.post('/api/trash/restore', { ids });
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已恢复 ${data.restored.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已恢复 ${data.restored.length} 个项目`;
    app.bumpSidebar();
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '恢复失败';
  } finally {
    trashBusy.value = false;
  }
}

function restoreSelectedTrash() {
  return restoreTrash([...selectedTrash.value]);
}

async function deleteTrash(ids: string[]) {
  if (!ids.length || trashBusy.value) return;
  if (!confirm(`将永久删除选中的 ${ids.length} 个项目，此操作不可撤销。继续？`)) return;
  if (!confirm('最后一次确认：真的要永久删除吗？')) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.delete('/api/trash', { data: { ids } });
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已删除 ${data.deleted.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已永久删除 ${data.deleted.length} 个项目`;
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '永久删除失败';
  } finally {
    trashBusy.value = false;
  }
}

function deleteSelectedTrash() {
  return deleteTrash([...selectedTrash.value]);
}

async function emptyTrash() {
  if (trashBusy.value || !trashItems.value.length) return;
  if (!confirm(`将永久删除回收站中的 ${trashItems.value.length} 个项目，此操作不可撤销。继续？`)) return;
  if (!confirm('最后一次确认：真的要清空回收站吗？')) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.delete('/api/trash/all');
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已删除 ${data.deleted.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已清空 ${data.deleted.length} 个项目`;
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '清空回收站失败';
  } finally {
    trashBusy.value = false;
  }
}

const wipeMsg = ref('');
const wipeOk = ref(false);

async function confirmWithPassword(actionLabel: string): Promise<string | null> {
  if (!confirm(`即将${actionLabel}，此操作不可撤销。确认继续？`)) return null;
  const password = prompt('请输入登录密码以确认：');
  if (password === null) return null;
  if (!password) {
    wipeOk.value = false;
    wipeMsg.value = '密码不能为空';
    return null;
  }
  if (!confirm(`最后一次确认：真的要${actionLabel}吗？`)) return null;
  return password;
}

async function wipe() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清除全部概念/实体/原始资料/归档/查询');
  if (!password) return;
  try {
    const { data } = await api.post('/api/settings/wipe', { password });
    wipeOk.value = true;
    wipeMsg.value = `已清除 ${data.fileCount} 个文件，索引已重置。`;
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清除失败';
  }
}

async function wipeAiLogs() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清空 AI 整理日志');
  if (!password) return;
  try {
    const { data } = await api.post('/api/settings/wipe-ai-logs', { password });
    wipeOk.value = true;
    wipeMsg.value = `已清空 ${data.fileCount} 个 AI 整理日志文件。`;
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清空失败';
  }
}

function parseEntries(raw: string): ModelEntry[] {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function load() {
  const [{ data: settingsData }, { data: tokenData }, { data: dreamData }] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/settings/mcp-tokens'),
    api.get('/api/dream/reports?status=open'),
  ]);
  chatModels.value = parseEntries(settingsData.settings.chat_models);
  embModels.value = parseEntries(settingsData.settings.embedding_models);
  activeChat.value = settingsData.settings.active_chat_model || chatModels.value[0]?.id || '';
  activeEmb.value = settingsData.settings.active_embedding_model || embModels.value[0]?.id || '';
  mcpTokens.value = tokenData.tokens;
  dreamEnabled.value = dreamData.enabled;
  dreamCron.value = dreamData.cron;
}

onMounted(() => {
  load();
  loadTrash();
});
</script>

<style scoped>
.settings-view {
  width: min(1100px, 100%);
  margin: 0 auto;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h2 { margin: 0 0 4px; }
section h3 { margin: 0; font-size: 15px; }
.sec-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 4px; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.ok { color: var(--success); }
.err { color: var(--danger); }

.model-section { padding: 18px; }
.model-section-head { align-items: flex-start; }
.section-copy { margin: 5px 0 0; }
.provider-catalog,
.unknown-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.provider-card,
.model-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.provider-card.active,
.model-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.provider-card-head,
.model-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.provider-title,
.extra-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.provider-title strong { font-size: 15px; }
.badge-group { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.status-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.status-badge.active { background: var(--accent); color: #fff; }
.status-badge.configured {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
}
.status-badge.empty { color: var(--text-faint); }
.config-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  color: var(--text-faint);
  font-size: 12px;
}
.config-summary > span:not(:first-child) {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-tertiary);
}
.model-sub {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 12px;
}
.model-card-actions,
.extra-actions,
.form-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.inline-result { margin: 0; overflow-wrap: anywhere; }

.config-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding-top: 11px;
  border-top: 1px solid var(--border);
}
.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
}
.field-wide { grid-column: 1 / -1; }
.field label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}
.field input,
.field select { width: 100%; min-width: 0; }
.field-help { color: var(--text-faint); font-size: 11px; }
.form-actions { justify-content: flex-end; }
.provider-hint { margin: 0; line-height: 1.5; }
.add-provider-config {
  align-self: flex-start;
  padding: 2px 0;
  border-radius: 0;
  color: var(--accent);
  font-size: 12px;
}
.add-provider-config:hover { text-decoration: underline; text-underline-offset: 2px; }

.extra-configs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.extra-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px 10px;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg);
}
.extra-actions,
.extra-config .inline-result { grid-column: 1 / -1; }
.unknown-configs { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.unknown-configs h4 { margin: 0; font-size: 13px; }
.model-card.compact { gap: 9px; }

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 15, 15, 0.38);
}
.modal {
  width: 620px;
  max-width: 100%;
  max-height: calc(100dvh - 40px);
  overflow-y: auto;
  box-shadow: var(--shadow);
}
.modal-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.modal-hint { margin: 12px 0 0; line-height: 1.5; }
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 16px;
}
.modal-actions-right { display: flex; gap: 8px; }

.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border);
}
.token {
  flex: 1;
  overflow: hidden;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
}
code { padding: 1px 6px; border-radius: 4px; background: var(--bg-tertiary); font-size: 12px; }

/* ---------- 回收站 ---------- */
.trash-section .sec-head { align-items: flex-start; }
.trash-summary { margin: 4px 0 0; }
.trash-tools {
  display: grid;
  grid-template-columns: auto minmax(150px, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.trash-select-all { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.trash-filter { min-width: 0; width: 100%; }
.trash-list {
  max-height: 390px;
  overflow-y: auto;
  margin-top: 10px;
  border-top: 1px solid var(--border);
}
.trash-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 58px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}
.trash-kind { color: var(--text-faint); }
.trash-main { min-width: 0; }
.trash-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.trash-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legacy-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 10px;
}
.trash-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 11px;
}
.trash-meta span:first-child { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trash-meta span:not(:first-child) { flex-shrink: 0; }
.trash-actions { display: flex; align-items: center; gap: 2px; }
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
}
.icon-btn:hover { background: var(--bg-hover); }
.danger-icon { color: var(--danger); }
.trash-empty { margin: 16px 0 4px; text-align: center; }
.trash-message { margin: 10px 0 0; }

.danger-zone {
  align-items: center;
  margin-top: 14px;
  padding: 12px;
  border: 1px dashed var(--danger);
  border-radius: 8px;
}
.danger-text { flex: 1; }
.danger-text strong { color: var(--danger); font-size: 14px; }
.danger-text p { margin: 4px 0 0; }

@media (max-width: 720px) {
  .settings-view { padding: 20px 14px; }
  .provider-catalog,
  .unknown-grid { grid-template-columns: 1fr; }
  .modal-form { grid-template-columns: 1fr; }
  .modal-form .field-wide { grid-column: auto; }
}

@media (max-width: 520px) {
  .model-section-head,
  .provider-card-head,
  .modal-actions { align-items: stretch; flex-direction: column; }
  .badge-group { justify-content: flex-start; }
  .config-form { grid-template-columns: 1fr; }
  .config-form .field-wide { grid-column: auto; }
  .modal-actions-right { justify-content: flex-end; }
  .extra-config { grid-template-columns: 1fr; }
  .extra-actions,
  .extra-config .inline-result { grid-column: auto; }

  .settings-view { padding: 20px 12px 80px; }
  .model-grid { grid-template-columns: 1fr; }
  .form { grid-template-columns: 1fr; }
  .provider-grid { grid-column: 1; }
  .trash-section .sec-head { flex-direction: column; gap: 8px; }
  .trash-section .sec-head .btn { width: 100%; justify-content: center; }
  .trash-tools { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .trash-select-all, .trash-filter { grid-column: 1 / -1; }
  .trash-tools .btn { width: 100%; min-width: 0; justify-content: center; padding-left: 8px; padding-right: 8px; }
  .trash-meta { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; }
  .trash-meta span:first-child { grid-column: 1 / -1; }
  .trash-row { grid-template-columns: auto auto minmax(0, 1fr); }
  .trash-actions { grid-column: 2 / -1; justify-content: flex-end; margin-top: -4px; }
  .danger-zone { align-items: stretch; }
  .danger-zone > .btn { width: 100%; justify-content: center; }
}

@media (prefers-reduced-motion: reduce) {
  .provider-card,
  .model-card { transition: none; }
}
</style>

<style scoped>
.settings-view {
  width: min(1220px, 100%);
  margin: 0 auto;
  padding: 30px 28px 72px;
}

.settings-page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 22px;
}

.settings-page-head h2 {
  margin: 0;
  font-size: 25px;
  line-height: 1.2;
  letter-spacing: 0;
}

.settings-page-head p,
.panel-head p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
}

.settings-shell {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.settings-nav {
  position: sticky;
  top: 22px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px;
}

.settings-nav button {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 8px 11px;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}

.settings-nav button:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.settings-nav button.active {
  background: var(--bg-tertiary);
  color: var(--text);
  font-weight: 600;
}

.settings-nav button:focus-visible,
.model-tabs button:focus-visible,
.text-action:focus-visible,
.add-provider-config:focus-visible,
.icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.settings-mobile-nav {
  display: none;
}

.settings-content {
  min-width: 0;
}

.settings-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px 20px;
  border-bottom: 1px solid var(--border);
}

.panel-head h3 {
  margin: 0;
  font-size: 17px;
  line-height: 1.35;
}

.panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.settings-panel .btn {
  min-height: 34px;
  justify-content: center;
}

.settings-panel .btn:active,
.model-dialog .btn:active {
  transform: translateY(1px);
}

.settings-group {
  display: flex;
  flex-direction: column;
}

.setting-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(180px, auto);
  align-items: center;
  gap: 18px;
  min-height: 76px;
  padding: 17px 24px;
  border-bottom: 1px solid var(--border);
}

.setting-row:last-child {
  border-bottom: 0;
}

.setting-row-form {
  align-items: start;
}

.setting-copy {
  min-width: 0;
}

.setting-copy strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
}

.setting-copy span {
  display: block;
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.setting-control {
  width: 170px;
}

.setting-control.wide {
  width: 250px;
}

.password-controls {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) minmax(130px, 1fr) auto;
  gap: 8px;
  width: min(530px, 100%);
}

.setting-message,
.workspace-message {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.setting-row .setting-message {
  grid-column: 2;
}

.model-panel-head {
  align-items: center;
}

.workspace-message {
  padding: 10px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.model-tabs {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(150px, 1fr));
  gap: 3px;
  margin: 18px 24px 0;
  padding: 3px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.model-tabs button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}

.model-tabs button.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 10%, transparent);
  font-weight: 600;
}

.tab-count {
  min-width: 30px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 500;
}

.model-section-body {
  padding: 18px 24px 26px;
}

.active-model-strip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 8px;
  background: var(--accent-soft);
}

.provider-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  overflow: hidden;
}

.active-mark {
  border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
  background: var(--bg);
  color: var(--accent);
}

.active-model-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 8px;
  align-items: baseline;
}

.active-model-copy > span {
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}

.active-model-copy strong {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.active-model-copy small {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-section-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 20px 0 10px;
}

.model-section-intro p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.model-section-intro > span,
.subsection-head > span {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.provider-catalog {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 0;
}

.provider-card {
  min-width: 0;
  min-height: 196px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 15px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.provider-card:hover {
  border-color: var(--border-strong);
}

.provider-card.active {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  background: var(--bg);
  box-shadow: inset 3px 0 0 var(--accent);
}

.provider-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.provider-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.provider-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.provider-title strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-title span {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}

.status-indicator::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
  content: "";
}

.status-indicator.configured {
  color: var(--success);
}

.status-indicator.configured::before {
  background: var(--success);
}

.status-indicator.active {
  color: var(--accent);
  font-weight: 600;
}

.status-indicator.active::before {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.config-details {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) repeat(2, minmax(54px, 0.7fr));
  gap: 10px;
  margin: 0;
  padding: 11px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.config-details > div {
  min-width: 0;
}

.config-details dt {
  margin-bottom: 3px;
  color: var(--text-faint);
  font-size: 10px;
}

.config-details dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
}

.model-card-actions .text-action {
  margin-left: auto;
}

.text-action {
  padding: 3px 2px;
  border-radius: 3px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.text-action:hover {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.text-action.accent {
  color: var(--accent);
}

.text-action.danger {
  color: var(--danger);
}

.text-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  text-decoration: none;
}

.provider-empty {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.provider-empty p {
  max-width: 34ch;
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
}

.inline-result {
  margin: -3px 0 0;
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.extra-configs {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.extra-configs-title {
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 600;
}

.extra-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
}

.extra-config:first-of-type {
  border-top: 0;
}

.extra-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.extra-title strong,
.extra-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extra-title strong {
  font-size: 12px;
}

.extra-title span {
  color: var(--text-faint);
  font-size: 10px;
}

.extra-actions {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 12px;
}

.extra-config .inline-result {
  grid-column: 1 / -1;
}

.add-provider-config {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 1px;
  border-radius: 3px;
  color: var(--accent);
  font-size: 11px;
}

.add-provider-config:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.unknown-configs {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}

.subsection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.subsection-head h4 {
  margin: 0;
  font-size: 13px;
}

.unknown-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 0;
  border-top: 1px solid var(--border);
}

.custom-model-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  min-height: 62px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}

.custom-model-row.active {
  background: var(--accent-soft);
}

.custom-model-copy {
  min-width: 0;
}

.custom-model-copy strong,
.custom-model-copy span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-model-copy strong {
  font-size: 12px;
}

.custom-model-copy span {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10px;
}

.custom-model-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.switch-control {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
}

.switch-control input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.switch-control > span {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 11px;
  background: var(--border-strong);
  transition: background 0.15s ease;
}

.switch-control > span::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
  content: "";
  transition: transform 0.15s ease;
}

.switch-control input:checked + span {
  background: var(--accent);
}

.switch-control input:checked + span::after {
  transform: translateX(16px);
}

.switch-control input:focus-visible + span {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.switch-control em {
  color: var(--text-secondary);
  font-size: 12px;
  font-style: normal;
}

.cron-input {
  width: 170px;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
}

.endpoint-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 22px 24px 12px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.endpoint-block > div {
  min-width: 0;
}

.endpoint-block span {
  display: block;
  margin-bottom: 5px;
  color: var(--text-faint);
  font-size: 11px;
}

.endpoint-block code {
  display: block;
  overflow: hidden;
  padding: 0;
  background: transparent;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.integration-note {
  margin: 0 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
}

.token-list {
  margin: 0 24px 24px;
  border-top: 1px solid var(--border);
}

.token-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.token-copy {
  min-width: 0;
}

.token-copy strong {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
}

.token {
  display: block;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.empty-panel {
  margin: 0 24px 24px;
  padding: 28px 16px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

.trash-tools {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  margin: 18px 24px 0;
}

.trash-select-all {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.trash-filter {
  min-width: 0;
  width: 100%;
}

.trash-list {
  max-height: 520px;
  overflow-y: auto;
  margin: 12px 24px 24px;
  border-top: 1px solid var(--border);
}

.trash-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}

.trash-kind {
  color: var(--text-faint);
}

.trash-main {
  min-width: 0;
}

.trash-name-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.trash-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legacy-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 7px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 9px;
}

.trash-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10px;
}

.trash-meta span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-meta span:not(:first-child) {
  flex-shrink: 0;
}

.trash-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
}

.icon-btn:hover {
  background: var(--bg-hover);
}

.danger-icon {
  color: var(--danger);
}

.trash-empty {
  margin: 24px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

.trash-section > .setting-message {
  margin: -12px 24px 22px;
}

.data-location {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 22px 24px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.data-location > svg {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.data-location strong {
  font-size: 13px;
}

.data-location p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.danger-section {
  margin: 0 24px 24px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
  border-radius: 8px;
  overflow: hidden;
}

.danger-section-head {
  padding: 13px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 22%, var(--border));
  background: color-mix(in srgb, var(--danger) 5%, var(--bg));
}

.danger-section-head h4 {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.danger-section-head span {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}

.danger-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}

.danger-row:last-child {
  border-bottom: 0;
}

.danger-row strong {
  font-size: 13px;
}

.danger-row p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.btn.danger.solid {
  background: var(--danger);
  color: #fff;
}

.btn.danger.solid:hover {
  opacity: 0.9;
}

.settings-panel > .setting-message {
  margin: 0 24px 22px;
}

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 22px;
  background: rgba(10, 12, 16, 0.5);
  backdrop-filter: blur(3px);
}

.model-dialog {
  width: min(680px, 100%);
  max-height: calc(100dvh - 44px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 20px 22px 16px;
  border-bottom: 1px solid var(--border);
}

.dialog-head span {
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}

.dialog-head h3 {
  margin: 3px 0 0;
  font-size: 17px;
}

.dialog-body {
  overflow-y: auto;
  padding: 20px 22px;
}

.modal-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 0;
}

.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-wide {
  grid-column: 1 / -1;
}

.field label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.field input,
.field select {
  width: 100%;
  min-width: 0;
}

.field-help {
  color: var(--text-faint);
  font-size: 10px;
}

.dialog-hint {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
}

.dialog-body .setting-message {
  margin-top: 12px;
}

.dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 22px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.dialog-actions > div {
  display: flex;
  gap: 8px;
}

.ok {
  color: var(--success);
}

.err {
  color: var(--danger);
}

@media (max-width: 1040px) {
  .settings-shell {
    grid-template-columns: 170px minmax(0, 1fr);
    gap: 18px;
  }

  .provider-catalog {
    grid-template-columns: 1fr;
  }

  .password-controls {
    grid-template-columns: 1fr 1fr;
  }

  .password-controls .btn {
    grid-column: 1 / -1;
    justify-self: end;
  }
}

@media (max-width: 760px) {
  .settings-view {
    padding: 20px 14px 72px;
  }

  .settings-page-head {
    margin-bottom: 14px;
  }

  .settings-page-head h2 {
    font-size: 22px;
  }

  .settings-mobile-nav {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .settings-mobile-nav label {
    color: var(--text-secondary);
    font-size: 12px;
  }

  .settings-mobile-nav select {
    width: 100%;
  }

  .settings-shell {
    display: block;
  }

  .settings-nav {
    display: none;
  }

  .panel-head {
    padding: 18px;
  }

  .model-panel-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .panel-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .setting-row {
    grid-template-columns: 1fr;
    gap: 12px;
    min-height: 0;
    padding: 16px 18px;
  }

  .setting-row .setting-message {
    grid-column: auto;
  }

  .setting-control,
  .setting-control.wide,
  .cron-input {
    width: 100%;
  }

  .password-controls {
    width: 100%;
  }

  .model-tabs {
    width: calc(100% - 36px);
    margin: 16px 18px 0;
  }

  .model-section-body {
    padding: 16px 18px 22px;
  }

  .active-model-strip {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .active-model-strip > .btn {
    grid-column: 1 / -1;
    width: 100%;
  }

  .custom-model-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .custom-model-actions {
    grid-column: 2 / -1;
    justify-content: flex-end;
  }

  .endpoint-block {
    margin: 18px 18px 10px;
  }

  .integration-note {
    margin: 0 18px 16px;
  }

  .token-list,
  .empty-panel {
    margin-right: 18px;
    margin-left: 18px;
  }

  .trash-tools {
    grid-template-columns: auto minmax(0, 1fr);
    margin: 16px 18px 0;
  }

  .trash-tools .btn {
    width: 100%;
  }

  .trash-list {
    margin: 12px 18px 20px;
  }

  .data-location,
  .danger-section {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (max-width: 520px) {
  .settings-view {
    padding-right: 12px;
    padding-left: 12px;
  }

  .settings-page-head p {
    max-width: 32ch;
  }

  .settings-panel {
    border-right: 0;
    border-left: 0;
    border-radius: 0;
  }

  .panel-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .panel-actions .btn {
    width: 100%;
  }

  .panel-actions .btn.primary {
    grid-column: 1 / -1;
  }

  .password-controls {
    grid-template-columns: 1fr;
  }

  .password-controls .btn {
    grid-column: auto;
    width: 100%;
  }

  .model-tabs {
    grid-template-columns: 1fr 1fr;
  }

  .model-tabs button {
    padding-right: 8px;
    padding-left: 8px;
  }

  .model-section-intro {
    align-items: flex-start;
  }

  .provider-card {
    min-height: 0;
  }

  .provider-card-head {
    align-items: flex-start;
  }

  .provider-mark {
    width: 32px;
    height: 32px;
    flex-basis: 32px;
  }

  .config-details {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .config-details > div:last-child {
    grid-column: 1 / -1;
  }

  .model-card-actions {
    flex-wrap: wrap;
  }

  .model-card-actions .text-action {
    margin-left: 0;
  }

  .provider-empty {
    align-items: stretch;
    flex-direction: column;
  }

  .provider-empty .btn {
    width: 100%;
  }

  .custom-model-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .custom-model-row > .status-indicator {
    grid-column: 2;
    justify-self: start;
  }

  .custom-model-actions {
    grid-column: 1 / -1;
  }

  .endpoint-block {
    grid-template-columns: 1fr;
  }

  .endpoint-block .btn {
    width: 100%;
  }

  .token-row {
    grid-template-columns: 1fr;
  }

  .token-actions {
    justify-content: flex-end;
  }

  .trash-tools {
    grid-template-columns: 1fr 1fr;
  }

  .trash-select-all,
  .trash-filter {
    grid-column: 1 / -1;
  }

  .trash-row {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  .trash-actions {
    grid-column: 2 / -1;
    justify-content: flex-end;
  }

  .trash-meta {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
  }

  .trash-meta span:first-child {
    grid-column: 1 / -1;
  }

  .danger-row {
    grid-template-columns: 1fr;
  }

  .danger-row .btn {
    width: 100%;
  }

  .modal-mask {
    align-items: flex-end;
    padding: 0;
  }

  .model-dialog {
    width: 100%;
    max-height: 92dvh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 8px 8px 0 0;
  }

  .dialog-head,
  .dialog-body,
  .dialog-actions {
    padding-right: 18px;
    padding-left: 18px;
  }

  .modal-form {
    grid-template-columns: 1fr;
  }

  .field-wide {
    grid-column: auto;
  }

  .dialog-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .dialog-actions > div {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-nav button,
  .provider-card,
  .switch-control > span,
  .switch-control > span::after {
    transition: none;
  }
}
</style>
