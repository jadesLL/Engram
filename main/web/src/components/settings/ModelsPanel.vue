<template>
  <section class="settings-panel settings-native model-workspace">
    <div class="panel-head model-panel-head">
      <div>
        <h3>模型配置</h3>
        <p>管理对话生成、语义检索与图片理解使用的服务商配置。</p>
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

    <div class="llm-usage-band" aria-labelledby="llm-usage-title">
      <div class="llm-usage-head">
        <div>
          <strong id="llm-usage-title">模型用量</strong>
          <span>
            {{ llmUsage.requests
              ? `${llmUsage.requests} 次调用 · 最近更新 ${formatUsageTime(llmUsage.latestAt)}`
              : '等待新调用产生计量数据'
            }}
          </span>
        </div>
        <div class="llm-usage-controls">
          <button
            class="btn small danger"
            type="button"
            :disabled="llmUsageLoading || llmUsageClearing || !llmUsage.requests"
            @click="clearLlmUsage"
          >
            {{ llmUsageClearing ? '清除中...' : '清除用量' }}
          </button>
          <select v-model.number="llmUsageDays" aria-label="模型用量统计范围" @change="loadLlmUsage">
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
            <option :value="90">近 90 天</option>
          </select>
          <button
            class="icon-btn"
            type="button"
            v-tooltip="'刷新模型用量'"
            aria-label="刷新模型用量"
            :disabled="llmUsageLoading"
            @click="loadLlmUsage"
          >
            <Icon name="rotate-right" :size="15" />
          </button>
        </div>
      </div>

      <p v-if="llmUsageError" class="setting-message err">{{ llmUsageError }}</p>
      <p v-else-if="llmUsageNotice" class="setting-message ok">{{ llmUsageNotice }}</p>
      <div v-else-if="llmUsageLoading && !llmUsage.requests" class="llm-usage-empty">正在读取用量...</div>
      <template v-else-if="llmUsage.requests">
        <div v-if="llmUsage.byOperation.length" class="llm-usage-ops">
          <div v-for="op in llmUsage.byOperation" :key="op.operation" class="llm-usage-op">
            <div class="llm-usage-op-head">
              <strong>{{ usageOperationLabel(op.operation) }}</strong>
              <small>{{ op.requests }} 次调用</small>
            </div>
            <div>
              <span>缓存命中</span>
              <strong>{{ formatUsageRate(op.cacheHitRate) }}</strong>
              <small v-if="op.cacheReadTokens > 0">读取 {{ formatTokenCount(op.cacheReadTokens) }}</small>
            </div>
            <div>
              <span>输入 Token</span>
              <strong>{{ formatTokenCount(op.promptTokens) }}</strong>
            </div>
            <div>
              <span>输出 Token</span>
              <strong>{{ formatTokenCount(op.completionTokens) }}</strong>
            </div>
          </div>
        </div>

        <div class="llm-usage-summary">
          <span>总缓存命中率 {{ formatUsageRate(llmUsage.combinedCacheHitRate) }}</span>
          <span>供应商前缀 {{ formatUsageRate(llmUsage.cacheHitRate) }}</span>
          <span>缓存读取 {{ formatTokenCount(llmUsage.cacheReadTokens) }}</span>
          <span>未命中 {{ formatTokenCount(llmUsage.cacheMissTokens) }}</span>
          <template v-if="llmUsage.promptAmplification !== null">
            <span>放大 {{ formatUsageMultiplier(llmUsage.promptAmplification) }}</span>
          </template>
          <span>总计 {{ formatTokenCount(llmUsage.totalTokens) }}</span>
          <template v-if="llmUsage.retryRequests">
            <span>重试 {{ llmUsage.retryRequests }}</span>
          </template>
          <template v-if="llmUsage.resultCacheHits">
            <span>结果复用 {{ llmUsage.resultCacheHits }}</span>
          </template>
        </div>

        <div v-if="llmUsage.breakdown.length" class="llm-usage-breakdown">
          <div class="llm-usage-row llm-usage-row-head" aria-hidden="true">
            <span>厂家 · 模型</span>
            <span>类型</span>
            <span>调用阶段</span>
            <span>输入</span>
            <span>输出</span>
            <span>缓存命中</span>
          </div>
          <div
            v-for="item in llmUsage.breakdown.slice(0, 8)"
            :key="`${item.provider}-${item.model}-${item.tag}`"
            class="llm-usage-row"
          >
            <span class="llm-usage-model-cell">
              <strong>{{ providerName(item.provider) }}</strong>
              <small>{{ item.model }}</small>
            </span>
            <span class="llm-usage-kind-tag">{{ usageOperationLabel(item.operation) }}</span>
            <span>
              <strong>{{ usageTagLabel(item.tag) }}</strong>
              <small>
                {{ item.requests }} 次
                <template v-if="item.runs"> · {{ item.runs }} 个任务</template>
                <template v-if="item.continuedRequests"> · {{ item.continuedRequests }} 次延续</template>
                <template v-if="item.resultCacheHits"> · {{ item.resultCacheHits }} 次结果复用</template>
              </small>
            </span>
            <span>{{ formatTokenCount(item.promptTokens) }}</span>
            <span>{{ formatTokenCount(item.completionTokens) }}</span>
            <span class="llm-usage-hit-cell">
              <strong>{{ formatUsageRate(item.combinedCacheHitRate) }}</strong>
              <small>前缀 {{ formatUsageRate(item.cacheHitRate) }}</small>
            </span>
          </div>
        </div>
      </template>
      <div v-else class="llm-usage-empty">
        当前统计范围内没有可用数据；更新后的新请求会在这里显示供应商返回的 token 与缓存计量。
      </div>
    </div>

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
        <span>{{ modelKindLabel(section.kind) }}</span>
        <span class="tab-count">{{ configuredProviderCount(section) }}/{{ section.cards.length }}</span>
      </button>
    </div>

    <template v-for="section in modelSections" :key="section.kind">
      <div v-show="activeModelKind === section.kind" class="model-section-body">
        <div
          v-if="section.kind === 'document'"
          class="vision-capability-note"
          :class="visionCapabilityTone"
          role="status"
          aria-live="polite"
        >
          <Icon :name="imageCapabilityChecking ? 'activity' : visionCapabilityIcon" :size="16" />
          <div>
            <strong>{{ visionCapabilityMessage }}</strong>
            <span v-if="imageCapabilityDetail">{{ imageCapabilityDetail }}</span>
          </div>
          <button
            v-if="!imageCapabilityChecking && activeModelFor('chat')?.apiKey"
            class="text-action"
            type="button"
            @click="refreshActiveChatImageCapability(true)"
          >
            重新检测
          </button>
        </div>

        <div class="model-section-intro">
          <div>
            <p>{{ section.copy }}</p>
            <span v-if="activeModelFor(section.kind)" class="current-model-line">
              当前：{{ providerName(activeModelFor(section.kind)!.provider) }} · {{ activeModelFor(section.kind)!.model }}
            </span>
          </div>
          <span>{{ section.cards.length }} 家服务商</span>
        </div>

        <div class="provider-split">
          <aside class="provider-nav" aria-label="服务商列表">
            <button
              v-for="card in section.cards"
              :key="card.provider.id"
              type="button"
              class="provider-nav-item"
              :class="{ active: selectedProviderId(section.kind) === card.provider.id }"
              @click="chooseProvider(section.kind, card.provider.id)"
            >
              <span>{{ card.provider.name }}</span>
              <em v-if="card.entries.length">{{ card.entries.length }}</em>
            </button>
            <template v-if="unknownGroups(section.kind).length">
              <div class="provider-nav-divider">自定义</div>
              <button
                v-for="group in unknownGroups(section.kind)"
                :key="group.provider.id"
                type="button"
                class="provider-nav-item"
                :class="{ active: selectedProviderId(section.kind) === group.provider.id }"
                @click="chooseProvider(section.kind, group.provider.id)"
              >
                <span>{{ group.provider.name }}</span>
                <em v-if="group.entries.length">{{ group.entries.length }}</em>
              </button>
            </template>
            <button type="button" class="provider-nav-add" @click="chooseProvider(section.kind, '__new-custom__')">
              <Icon name="plus" :size="12" />
              新增自定义配置
            </button>
          </aside>

          <div class="provider-detail">
            <!-- 新增自定义配置 -->
            <template v-if="selectedProvider[section.kind] === '__new-custom__'">
              <div class="detail-head">
                <div class="detail-title">
                  <strong>新增自定义配置</strong>
                  <span>为自建网关或中转端点建立独立配置，可与内置厂商并列使用</span>
                </div>
              </div>
              <div class="conn-form">
                <div class="conn-grid">
                  <label>
                    配置名称
                    <input v-model="conn.configName" placeholder="例如：我的 GLM 网关" />
                  </label>
                  <label>
                    Base URL
                    <input v-model="conn.baseUrl" placeholder="https://.../v1" @change="onConnBaseUrlChange" />
                  </label>
                  <label>
                    请求协议
                    <select v-model="conn.protocol" @change="onConnProtocolChange">
                      <option value="openai">OpenAI 兼容（/chat/completions + Bearer）</option>
                      <option value="anthropic">Anthropic 兼容（/v1/messages + x-api-key）</option>
                    </select>
                  </label>
                  <label>
                    API Key
                    <div class="conn-key-field">
                      <input
                        v-model="conn.apiKey"
                        type="password"
                        class="api-key-input"
                        placeholder="API Key"
                        autocomplete="new-password"
                        spellcheck="false"
                      />
                    </div>
                  </label>
                </div>
                <span class="field-help">保存后自动拉取该端点的全部模型；配置会出现在左侧导航，与内置厂商同级。</span>
                <p v-if="conn.message" class="conn-msg" :class="{ ok: conn.ok, err: !conn.ok }">{{ conn.message }}</p>
                <div class="conn-actions">
                  <button class="btn primary" type="button" :disabled="conn.busy" @click="saveConnection(section.kind)">
                    {{ conn.busy ? '拉取中...' : '保存并拉取全部模型' }}
                  </button>
                  <button class="btn" type="button" @click="cancelNewCustom(section.kind)">取消</button>
                </div>
              </div>
            </template>

            <!-- 自定义配置面板（与预设厂商同一套连接/拉取流程） -->
            <template v-else-if="detailCustomCard(section)">
              <div class="detail-head">
                <div class="detail-title">
                  <strong>{{ detailCustomCard(section)!.provider.name }}</strong>
                  <span>已配置 {{ detailCustomCard(section)!.entries.length }} 个模型</span>
                </div>
                <div class="provider-head-actions">
                  <button
                    class="icon-btn"
                    type="button"
                    v-tooltip="'重新拉取该端点的模型列表'"
                    aria-label="重新拉取模型"
                    :disabled="refreshingProvider === `${section.kind}:${detailCustomCard(section)!.provider.id}`"
                    @click="refreshProviderModels(section.kind, detailCustomCard(section)!)"
                  >
                    <Icon name="rotate-right" :size="14" />
                  </button>
                  <button
                    class="provider-add-btn"
                    type="button"
                    v-tooltip="'编辑名称 / 连接（API Key / 协议），保存后同步全部模型'"
                    @click="startEditConnection(section.kind, detailCustomCard(section)!)"
                  >
                    <Icon name="settings" :size="13" />
                    编辑连接
                  </button>
                  <button
                    class="provider-add-btn danger"
                    type="button"
                    v-tooltip="'删除此配置及其全部模型'"
                    @click="deleteCustomConfig(section.kind, detailCustomCard(section)!)"
                  >
                    <Icon name="x" :size="13" />
                    删除配置
                  </button>
                </div>
              </div>

              <div v-if="conn.open && conn.kind === section.kind && conn.providerId === detailCustomCard(section)!.provider.id" class="conn-form">
                <div class="conn-grid">
                  <label>
                    配置名称
                    <input v-model="conn.configName" placeholder="例如：我的 GLM 网关" />
                  </label>
                  <label>
                    Base URL
                    <input v-model="conn.baseUrl" placeholder="https://.../v1" @change="onConnBaseUrlChange" />
                  </label>
                  <label>
                    请求协议
                    <select v-model="conn.protocol" @change="onConnProtocolChange">
                      <option value="openai">OpenAI 兼容（/chat/completions + Bearer）</option>
                      <option value="anthropic">Anthropic 兼容（/v1/messages + x-api-key）</option>
                    </select>
                  </label>
                  <label>
                    API Key
                    <div class="conn-key-field">
                      <input
                        v-model="conn.apiKey"
                        :type="conn.showKey ? 'text' : 'password'"
                        class="api-key-input"
                        :placeholder="conn.mode === 'edit' ? '留空沿用已保存的 Key' : 'API Key'"
                        autocomplete="new-password"
                        spellcheck="false"
                      />
                      <button
                        class="conn-key-toggle"
                        type="button"
                        v-tooltip="conn.showKey ? '隐藏 Key' : '显示 Key'"
                        :aria-label="conn.showKey ? '隐藏 Key' : '显示 Key'"
                        @click="toggleConnKey(section.kind, detailCustomCard(section)!)"
                      >
                        <Icon :name="conn.showKey ? 'eye-off' : 'eye'" :size="14" />
                      </button>
                    </div>
                  </label>
                </div>
                <span class="field-help">修改名称后保存会同步更新该配置下的全部模型。</span>
                <p v-if="conn.message" class="conn-msg" :class="{ ok: conn.ok, err: !conn.ok }">{{ conn.message }}</p>
                <div class="conn-actions">
                  <button
                    class="btn primary"
                    type="button"
                    :disabled="conn.busy"
                    @click="saveConnection(section.kind)"
                  >
                    {{ conn.busy ? '拉取中...' : conn.mode === 'connect' ? '保存并拉取全部模型' : '保存修改' }}
                  </button>
                  <button v-if="conn.mode === 'edit'" class="btn" type="button" @click="conn.open = false">取消</button>
                </div>
              </div>

              <template v-else>
                <div class="model-catalog">
                  <div class="model-catalog-head">
                    <span>全部模型</span>
                    <span class="model-catalog-tip">点击模型切换使用</span>
                  </div>
                  <div
                    v-for="model in detailCustomCard(section)!.entries"
                    :key="model.id"
                    class="model-catalog-row"
                    :class="{ active: model.id === section.activeId }"
                    role="button"
                    tabindex="0"
                    v-tooltip="model.id === section.activeId ? '正在使用的模型' : '点击切换为该模型'"
                    @click="model.id !== section.activeId && selectModel(section.kind, model.id)"
                    @keydown.enter="model.id !== section.activeId && selectModel(section.kind, model.id)"
                  >
                    <span class="model-catalog-dot" :class="{ active: model.id === section.activeId }"></span>
                    <span class="model-catalog-name">{{ model.model }}</span>
                    <span v-if="section.kind === 'emb' && model.dim" class="model-catalog-dim">{{ model.dim }} 维</span>
                    <span v-if="model.id === section.activeId" class="model-catalog-current">使用中</span>
                    <button
                      class="model-catalog-remove"
                      type="button"
                      v-tooltip="'删除该配置'"
                      @click.stop="removeModel(section.kind, model.id)"
                    >
                      <Icon name="x" :size="12" />
                    </button>
                  </div>
                </div>
                <div class="custom-add-row">
                  <button class="text-action" type="button" @click="openManualAdd(section.kind, detailCustomCard(section)!)">
                    <Icon name="plus" :size="12" />
                    手动添加单个模型
                  </button>
                </div>
              </template>
            </template>

            <!-- 预设服务商面板 -->
            <template v-else-if="detailCardFor(section)">
              <div class="detail-head">
                <div class="detail-title">
                  <strong>{{ detailCardFor(section)!.provider.name }}</strong>
                  <span>
                    {{ detailCardFor(section)!.entries.length
                      ? `已配置 ${detailCardFor(section)!.entries.length} 个模型`
                      : '尚未配置 · 填入 API Key 自动拉取全部模型' }}
                  </span>
                </div>
                <div v-if="detailCardFor(section)!.entries.length" class="provider-head-actions">
                  <button
                    class="icon-btn"
                    type="button"
                    v-tooltip="'重新拉取该厂商的模型列表'"
                    aria-label="重新拉取模型"
                    :disabled="refreshingProvider === `${section.kind}:${detailCardFor(section)!.provider.id}`"
                    @click="refreshProviderModels(section.kind, detailCardFor(section)!)"
                  >
                    <Icon name="rotate-right" :size="14" />
                  </button>
                  <button
                    class="provider-add-btn"
                    type="button"
                    v-tooltip="'编辑连接（API Key / 线路），保存后同步全部模型'"
                    @click="startEditConnection(section.kind, detailCardFor(section)!)"
                  >
                    <Icon name="settings" :size="13" />
                    编辑连接
                  </button>
                </div>
              </div>

              <div
                v-if="conn.open && conn.kind === section.kind && conn.providerId === detailCardFor(section)!.provider.id"
                class="conn-form"
              >
                <div class="conn-grid">
                  <label>
                    线路
                    <select v-model="conn.line" @change="onConnLineChange(section.kind, detailCardFor(section)!.provider)">
                      <option v-for="line in linesFor(detailCardFor(section)!.provider, section.kind)" :key="line.id" :value="line.id">
                        {{ line.name }}
                      </option>
                    </select>
                  </label>
                  <label>
                    Base URL
                    <input v-model="conn.baseUrl" placeholder="https://.../v1" @change="onConnBaseUrlChange" />
                  </label>
                  <label>
                    API Key
                    <div class="conn-key-field">
                      <input
                        v-model="conn.apiKey"
                        :type="conn.showKey ? 'text' : 'password'"
                        class="api-key-input"
                        :placeholder="connKeyPlaceholder(section.kind)"
                        autocomplete="new-password"
                        spellcheck="false"
                      />
                      <button
                        class="conn-key-toggle"
                        type="button"
                        v-tooltip="conn.showKey ? '隐藏 Key' : '显示 Key'"
                        :aria-label="conn.showKey ? '隐藏 Key' : '显示 Key'"
                        @click="toggleConnKey(section.kind, detailCardFor(section)!)"
                      >
                        <Icon :name="conn.showKey ? 'eye-off' : 'eye'" :size="14" />
                      </button>
                    </div>
                  </label>
                </div>
                <span v-if="connHint(section.kind)" class="field-help">{{ connHint(section.kind) }}</span>
                <p v-if="conn.message" class="conn-msg" :class="{ ok: conn.ok, err: !conn.ok }">{{ conn.message }}</p>
                <div class="conn-actions">
                  <button
                    class="btn primary"
                    type="button"
                    :disabled="conn.busy"
                    @click="saveConnection(section.kind)"
                  >
                    {{ conn.busy ? '拉取中...' : conn.mode === 'connect' ? '保存并拉取全部模型' : '保存修改' }}
                  </button>
                  <button v-if="conn.mode === 'edit'" class="btn" type="button" @click="conn.open = false">取消</button>
                </div>
              </div>

              <div v-else-if="!detailCardFor(section)!.entries.length" class="conn-empty">
                <p>填入该厂商的 API Key，自动拉取全部模型；点击任意模型即可切换使用。</p>
                <button class="btn primary" type="button" @click="startConnect(section.kind, detailCardFor(section)!.provider)">
                  <Icon name="plus" :size="13" />
                  开始配置
                </button>
              </div>

              <div v-else class="model-catalog">
                <div class="model-catalog-head">
                  <span>全部模型</span>
                  <span class="model-catalog-tip">点击模型切换使用</span>
                </div>
                <button
                  v-for="entry in detailCardFor(section)!.entries"
                  :key="entry.id"
                  type="button"
                  class="model-catalog-row"
                  :class="{ active: entry.id === section.activeId }"
                  v-tooltip="entry.id === section.activeId ? '正在使用的模型' : '点击切换为该模型'"
                  @click="entry.id !== section.activeId && selectModel(section.kind, entry.id)"
                >
                  <span class="model-catalog-dot" :class="{ active: entry.id === section.activeId }"></span>
                  <span class="model-catalog-name">{{ entry.model }}</span>
                  <span v-if="entry.id === section.activeId" class="model-catalog-current">使用中</span>
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- 模型配置对话框（AppModal：Esc 关闭 + 焦点陷阱） -->
    <AppModal
      :open="form.show"
      v-tooltip="form.id ? '编辑模型配置' : '添加模型配置'"
      width="min(680px, 100%)"
      @close="form.show = false"
    >
      <template #subtitle>
        <p class="dialog-kind-label">{{ modelKindLabel(form.kind) }}</p>
      </template>

      <div class="modal-form">
        <div v-if="!batchPickAvailable" class="field">
          <label for="model-name">备注名</label>
          <input id="model-name" v-model="form.name" placeholder="例如：主力配置" />
        </div>
        <div class="field">
          <label for="model-provider">服务商</label>
          <select id="model-provider" v-model="form.provider" @change="pickProvider(form.provider)">
            <option v-if="!providerById(form.provider)" :value="form.provider">{{ providerDisplayName(form.provider) }}</option>
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
        <div v-if="!batchPickAvailable" class="field">
          <label for="model-choice">模型</label>
          <select id="model-choice" v-model="form.modelChoice" @change="onFormModelChange">
            <option value="" disabled>
              {{ discoveryBusy ? '正在拉取模型...' : modelDiscoveryCompleted ? '请选择模型' : '输入 API Key 后拉取模型' }}
            </option>
            <option v-for="model in formModelOptions" :key="model.id" :value="model.id">
              {{ modelOptionLabel(model) }}
            </option>
            <option value="__custom__">自定义模型名称</option>
          </select>
          <span v-if="currentFormModelUnavailable" class="field-help model-unavailable-help">
            当前账号的模型目录未返回此模型，配置已保留；请选择可用模型或继续手动使用。
          </span>
        </div>
        <div v-if="!batchPickAvailable && form.modelChoice === '__custom__'" class="field field-wide">
          <label for="custom-model-name">自定义模型名称</label>
          <input id="custom-model-name" v-model="form.model" placeholder="完整模型 ID 或 ep- 接入点" />
        </div>
        <div class="field field-wide">
          <label for="model-base-url">Base URL</label>
          <input id="model-base-url" v-model="form.baseUrl" placeholder="https://.../v1" @change="onFormBaseUrlChange" />
        </div>
        <div v-if="showProtocolSelect" class="field">
          <label for="model-protocol">请求协议</label>
          <select id="model-protocol" v-model="form.protocol">
            <option value="openai">OpenAI 兼容（/chat/completions + Bearer）</option>
            <option value="anthropic">Anthropic 兼容（/v1/messages + x-api-key）</option>
          </select>
          <span class="field-help">决定请求地址拼接、鉴权头与消息格式；预设服务商按线路自动确定。</span>
        </div>
        <div v-if="form.kind === 'chat' && !batchPickAvailable" class="field">
          <label for="model-thinking-level">思考等级</label>
          <select id="model-thinking-level" v-model="form.thinkingLevel">
            <option value="">自动（不显式指定）</option>
            <option value="low">低（low）</option>
            <option value="high">高（high）</option>
            <option value="max">最大（max）</option>
          </select>
          <span class="field-help">由模型条目控制；GLM-5.3 可选择 low / high / max，所有对话调用统一生效。</span>
        </div>
        <div class="field field-wide">
          <label>模型目录</label>
          <div class="discovery-url-row">
            <span class="field-help">使用当前线路的官方地址自动获取，无需填写 API 地址。</span>
            <button class="btn" type="button" :disabled="discoveryBusy || (!effectiveFormApiKey && !form.authOptional && !form.modelsAnonymous)" @click="discoverFormModels()">
              {{ discoveryBusy ? '拉取中...' : '拉取模型' }}
            </button>
          </div>
        </div>
        <div class="field">
          <label for="model-api-key">API Key</label>
          <input
            ref="apiKeyInput"
            id="model-api-key"
            class="api-key-input"
            type="text"
            :value="formApiKeyDisplayValue"
            :placeholder="formKeyPlaceholder"
            autocomplete="off"
            spellcheck="false"
            @focus="revealFormApiKey"
            @click="revealFormApiKey"
            @input="onFormApiKeyInput"
            @blur="onFormApiKeyBlur"
          />
          <span v-if="effectiveFormApiKey" class="field-help">
            {{ form.apiKey.trim()
              ? (apiKeyRevealed ? '点击其他位置后重新隐藏；可直接编辑替换 Key。' : '中间字符已隐藏，点击输入框查看完整 Key。')
              : '已保存的 Key 由服务端保留（此处显示掩码）；留空保存即沿用，输入新值则替换。' }}
          </span>
          <span v-else-if="form.authOptional" class="field-help">本地免鉴权线路，无需 API Key。</span>
          <span v-else-if="form.id" class="field-help">请为当前服务商和线路输入 API Key。</span>
        </div>
        <div v-if="batchPickAvailable" class="field field-wide batch-summary">
          <span class="field-help">
            已拉取该厂商 {{ batchModelOptions.length }} 个模型，保存后全部入库；在列表页点击任意模型即可切换使用。
          </span>
          <button class="text-action" type="button" @click="batchManual = true">手动模式</button>
        </div>
        <div v-if="form.kind === 'emb' && !batchPickAvailable" class="field">
          <label for="model-dimension">向量维度</label>
          <select v-if="formDimensionOptions.length" id="model-dimension" v-model.number="form.dim">
            <option v-for="dim in formDimensionOptions" :key="dim" :value="dim">{{ dim }}</option>
          </select>
          <input v-else id="model-dimension" v-model.number="form.dim" type="number" min="1" placeholder="1024" />
        </div>
      </div>
      <p v-if="formHint" class="dialog-hint">{{ formHint }}</p>
      <p
        class="setting-message discovery-message"
        :class="currentFormModelUnavailable ? 'warn' : discoveryOk ? 'ok' : 'err'"
        v-tooltip="discoveryMessage"
      >{{ discoveryMessage || ' ' }}</p>
      <p v-if="formError" class="setting-message err">{{ formError }}</p>

      <template #footer>
        <button class="btn" type="button" :disabled="formTesting || !effectiveFormApiKey" @click="testForm">
          {{ formTesting ? '测试中...' : '测试连接' }}
        </button>
        <div class="dialog-footer-right">
          <button class="btn" type="button" @click="form.show = false">取消</button>
          <button
            class="btn primary"
            type="button"
            :disabled="formSaving || (batchPickAvailable && !batchModelOptions.length)"
            @click="saveModel"
          >
            {{ formSaving ? '保存中...' : batchPickAvailable ? '保存并同步模型' : '保存配置' }}
          </button>
        </div>
      </template>
    </AppModal>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import AppModal from '../ui/AppModal.vue';
import {
  catalogProviders,
  customPreset,
  modelById,
  providerById,
  setModelCatalog,
  type ApiLine,
  type ImageInputStatus,
  type ModelOption,
  type ProviderPreset,
  type ProviderProtocol,
} from '../../presets';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

type ModelKind = 'chat' | 'emb' | 'document';
type ThinkingLevel = 'low' | 'high' | 'max';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  line?: string;
  baseUrl: string;
  modelsUrl?: string;
  model: string;
  apiKey: string;
  protocol?: ProviderProtocol;
  modelsProtocol?: ProviderProtocol;
  authOptional?: boolean;
  modelsAnonymous?: boolean;
  thinkingLevel?: ThinkingLevel;
  dim?: number;
  supportsDimensions?: boolean;
  imageInput?: ImageInputStatus;
  imageInputSource?: 'stored' | 'catalog' | 'metadata' | 'probe';
  imageInputCheckedAt?: string;
}

interface ModelDraft {
  line: string;
  baseUrl: string;
  modelsUrl: string;
  model: string;
  modelChoice: string;
  apiKey: string;
  protocol: ProviderProtocol;
  modelsProtocol: ProviderProtocol;
  authOptional: boolean;
  modelsAnonymous: boolean;
  thinkingLevel: '' | ThinkingLevel;
  dim: number;
}

interface ProviderCard {
  provider: ProviderPreset;
  entries: ModelEntry[];
}

type FormModelOption = ModelOption & {
  unavailable?: boolean;
  /** 来自内置目录（非在线拉取） */
  fromCatalog?: boolean;
};

interface LlmUsageBreakdown {
  provider: string;
  model: string;
  operation: string;
  tag: string;
  requests: number;
  runs: number;
  continuedRequests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheReported: boolean;
  cacheHitRate: number | null;
  resultCacheHits: number;
  retryRequests: number;
  promptAmplification: number | null;
  combinedCacheHitRate: number | null;
}

interface OperationUsage {
  operation: string;
  requests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number | null;
  promptAmplification: number | null;
}

interface LlmUsageSummary {
  windowDays: number;
  from: string;
  requests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheReported: boolean;
  cacheHitRate: number | null;
  resultCacheHits: number;
  retryRequests: number;
  promptAmplification: number | null;
  combinedCacheHitRate: number | null;
  latestAt: string | null;
  breakdown: LlmUsageBreakdown[];
  byOperation: OperationUsage[];
}

function emptyLlmUsage(windowDays = 7): LlmUsageSummary {
  return {
    windowDays,
    from: '',
    requests: 0,
    cacheRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    cacheReported: false,
    cacheHitRate: null,
    resultCacheHits: 0,
    retryRequests: 0,
    promptAmplification: null,
    combinedCacheHitRate: null,
    latestAt: null,
    breakdown: [],
    byOperation: [],
  };
}

const activeModelKind = ref<ModelKind>('chat');
const chatModels = ref<ModelEntry[]>([]);
const embModels = ref<ModelEntry[]>([]);
const documentModels = ref<ModelEntry[]>([]);
const activeChat = ref('');
const activeEmb = ref('');
const activeDocument = ref('');

function modelsRef(kind: ModelKind) {
  if (kind === 'chat') return chatModels;
  if (kind === 'emb') return embModels;
  return documentModels;
}

function providerEntries(kind: ModelKind, providerId: string): ModelEntry[] {
  return modelsRef(kind).value.filter((model) => model.provider === providerId);
}

function activeIdFor(kind: ModelKind): string {
  if (kind === 'chat') return activeChat.value;
  if (kind === 'emb') return activeEmb.value;
  return activeDocument.value;
}

function setActiveId(kind: ModelKind, value: string) {
  if (kind === 'chat') activeChat.value = value;
  else if (kind === 'emb') activeEmb.value = value;
  else activeDocument.value = value;
}

function modelKindLabel(kind: ModelKind): string {
  if (kind === 'chat') return '对话模型';
  if (kind === 'emb') return '向量模型';
  return '视觉模型';
}

function activeModelFor(kind: ModelKind): ModelEntry | undefined {
  return modelsRef(kind).value.find((model) => model.id === activeIdFor(kind));
}

// ---------- 视觉能力提示 ----------
const imageCapabilityChecking = ref(false);
const imageCapabilityDetail = ref('');
const checkedImageCapabilityIds = new Set<string>();
let imageCapabilityRequestId = 0;

const activeChatImageStatus = computed<ImageInputStatus>(() =>
  activeModelFor('chat')?.imageInput || 'unknown'
);
const dedicatedVisionConfigured = computed(() => Boolean(activeModelFor('document')?.apiKey));
const visionCapabilityTone = computed(() => {
  if (imageCapabilityChecking.value) return 'checking';
  if (!activeModelFor('chat')?.apiKey) return 'warning';
  if (activeChatImageStatus.value === 'supported') return 'supported';
  if (activeChatImageStatus.value === 'unsupported') return 'warning';
  return 'neutral';
});
const visionCapabilityIcon = computed(() =>
  activeChatImageStatus.value === 'supported' ? 'check' : 'activity'
);
const visionCapabilityMessage = computed(() => {
  if (imageCapabilityChecking.value) return '正在检测当前对话模型的多模态能力...';
  if (!activeModelFor('chat')?.apiKey) return '尚未配置可用的对话模型，需要单独配置视觉模型。';
  if (activeChatImageStatus.value === 'supported') {
    return '当前对话模型已支持多模态，无需额外配置。';
  }
  if (activeChatImageStatus.value === 'unsupported') {
    return '当前对话模型不支持多模态，需要单独配置视觉模型。';
  }
  return '暂时无法确认当前对话模型是否支持多模态，可重新检测或单独配置视觉模型。';
});

function configuredProviderCount(section: { cards: ProviderCard[] }): number {
  return section.cards.filter((card) => card.entries.some((entry) => Boolean(entry.apiKey))).length;
}

// ---------- 连接测试（notify 替代局部 toast） ----------
const testingAll = ref(false);

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.message || fallback;
}

async function testAll() {
  testingAll.value = true;
  try {
    const { data } = await api.post('/api/settings/test-llm');
    const documentRequired = Boolean(activeModelFor('document'));
    const ok = Boolean(data.chat && data.embedding && (!documentRequired || data.document));
    if (ok) {
      notify.success(
        documentRequired
          ? '对话、向量与视觉模型均连接成功。'
          : '对话模型与向量模型均连接成功。'
      );
    } else {
      notify.error(data.error || (data.chat ? '向量或视觉模型连接失败。' : '对话模型连接失败。'));
    }
  } catch (error: any) {
    notify.error(errorMessage(error, '连接测试失败。'));
  } finally {
    testingAll.value = false;
  }
}

// ---------- 服务商列表（目录来自服务端，Logo 已在注入时补齐） ----------
const catalogList = computed(() => catalogProviders());
const fixedChatProviders = computed(() => catalogList.value.filter((provider) => provider.id !== 'custom'));
const fixedEmbeddingProviders = computed(() =>
  catalogList.value.filter((provider) => provider.id !== 'custom' && provider.embeddingModels.length > 0)
);
const fixedDocumentProviders = computed(() =>
  catalogList.value.filter((provider) => provider.id !== 'custom' && (provider.documentModels?.length || 0) > 0)
);

function cardsFor(kind: ModelKind): ProviderCard[] {
  const providers = kind === 'chat'
    ? fixedChatProviders.value
    : kind === 'emb'
      ? fixedEmbeddingProviders.value
      : fixedDocumentProviders.value;
  const list = modelsRef(kind).value;
  return providers.map((provider) => {
    const matches = list.filter((model) => model.provider === provider.id);
    return { provider, entries: matches };
  });
}

function unknownModels(kind: ModelKind): ModelEntry[] {
  const fixedIds = new Set(
    (kind === 'chat'
      ? fixedChatProviders.value
      : kind === 'emb'
        ? fixedEmbeddingProviders.value
        : fixedDocumentProviders.value
    ).map((provider) => provider.id)
  );
  const list = modelsRef(kind).value;
  return list.filter((model) => !fixedIds.has(model.provider));
}

const modelSections = computed(() => [
  {
    kind: 'chat' as const,
    copy: '配置一次 API Key 即自动拉取该厂商的全部模型，点击任意模型即可切换使用。',
    cards: cardsFor('chat'),
    unknown: unknownModels('chat'),
    activeId: activeChat.value,
  },
  {
    kind: 'emb' as const,
    copy: '配置后自动拉取该厂商的向量模型；切换模型或维度后会自动重建索引。',
    cards: cardsFor('emb'),
    unknown: unknownModels('emb'),
    activeId: activeEmb.value,
  },
  {
    kind: 'document' as const,
    copy: '配置后自动列出支持视觉的模型；作为可选覆盖项，仅处理图片和 PDF 中没有足够内嵌文字的页面。',
    cards: cardsFor('document'),
    unknown: unknownModels('document'),
    activeId: activeDocument.value,
  },
]);

// ---------- 配置对话框 ----------
const form = ref({
  show: false,
  kind: 'chat' as ModelKind,
  id: '',
  name: '',
  provider: 'custom',
  line: 'custom',
  baseUrl: '',
  modelsUrl: '',
  model: '',
  modelChoice: '__custom__',
  apiKey: '',
  protocol: 'openai' as ProviderProtocol,
  modelsProtocol: 'openai' as ProviderProtocol,
  authOptional: false,
  modelsAnonymous: false,
  thinkingLevel: '' as '' | ThinkingLevel,
  dim: 1024,
});
const apiKeyInput = ref<HTMLInputElement>();
const apiKeyRevealed = ref(false);
const revealedStoredKey = ref('');
const formTesting = ref(false);
const formSaving = ref(false);
const formError = ref('');
const discoveredModels = ref<ModelOption[]>([]);
const modelDiscoveryCompleted = ref(false);
const discoveryBusy = ref(false);
const discoveryMessage = ref('');
const discoveryOk = ref(false);
let modelDiscoveryRequestId = 0;

// ---------- 服务商详情（hermes 式：左选厂商，右列全部模型点选即用） ----------
const selectedProvider = ref<Record<ModelKind, string>>({ chat: '', emb: '', document: '' });
const batchManual = ref(false);
const refreshingProvider = ref('');
/** 在线拉取结果按线路白名单过滤（coding-plan 线路只允许白名单内模型） */
const batchModelOptions = computed<FormModelOption[]>(() => {
  const whitelist = formLine.value?.models?.length ? new Set(formLine.value.models) : null;
  return discoveredModels.value.filter((model) => !whitelist || whitelist.has(model.id));
});
const batchPickAvailable = computed(() => !batchManual.value && batchModelOptions.value.length > 0);

function selectedProviderId(kind: ModelKind): string {
  return selectedProvider.value[kind]
    || cardsFor(kind)[0]?.provider.id
    || unknownGroups(kind)[0]?.provider.id
    || '';
}

/** 左导航里的自定义分组：按 provider id 聚合非目录条目，显示名取条目上的配置名 */
function unknownGroups(kind: ModelKind): ProviderCard[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const model of unknownModels(kind)) {
    const list = groups.get(model.provider) || [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return [...groups.entries()].map(([id, entries]) => ({
    provider: { ...customPreset, id, name: entries[0]?.name?.trim() || (id === 'custom' ? '自定义配置' : id) },
    entries,
  }));
}

function detailCustomCard(section: { kind: ModelKind }): ProviderCard | null {
  const sel = selectedProvider.value[section.kind];
  if (!sel || sel === '__new-custom__') return null;
  return unknownGroups(section.kind).find((group) => group.provider.id === sel) || null;
}

function detailCardFor(section: { kind: ModelKind; cards: ProviderCard[] }): ProviderCard | null {
  if (selectedProvider.value[section.kind] === '__new-custom__') return null;
  if (detailCustomCard(section)) return null;
  return section.cards.find((card) => card.provider.id === selectedProviderId(section.kind)) || null;
}

const conn = ref({
  open: false,
  kind: 'chat' as ModelKind,
  providerId: '',
  mode: 'connect' as 'connect' | 'edit',
  configName: '',
  line: '',
  baseUrl: '',
  modelsUrl: '',
  apiKey: '',
  showKey: false,
  protocol: 'openai' as ProviderProtocol,
  modelsProtocol: 'openai' as ProviderProtocol,
  authOptional: false,
  modelsAnonymous: false,
  busy: false,
  message: '',
  ok: false,
});

function chooseProvider(kind: ModelKind, id: string) {
  selectedProvider.value = { ...selectedProvider.value, [kind]: id };
  conn.value.open = false;
  conn.value.message = '';
  if (id === '__new-custom__') {
    startConnectCustom(kind);
    return;
  }
  const customGroup = unknownGroups(kind).find((group) => group.provider.id === id);
  if (customGroup) {
    if (!customGroup.entries.length) startConnect(kind, customGroup.provider);
    return;
  }
  const card = cardsFor(kind).find((item) => item.provider.id === id);
  if (card && !card.entries.length) startConnect(kind, card.provider);
}

function startConnect(kind: ModelKind, provider: ProviderPreset) {
  const draft = createDraft(kind, provider, undefined);
  conn.value = {
    open: true,
    kind,
    providerId: provider.id,
    mode: 'connect',
    configName: '',
    line: draft.line,
    baseUrl: draft.baseUrl,
    modelsUrl: draft.modelsUrl,
    apiKey: '',
    showKey: false,
    protocol: draft.protocol,
    modelsProtocol: draft.modelsProtocol,
    authOptional: draft.authOptional,
    modelsAnonymous: draft.modelsAnonymous,
    busy: false,
    message: '',
    ok: false,
  };
}

function startEditConnection(kind: ModelKind, card: ProviderCard) {
  const source = card.entries.find((model) => model.apiKey || model.authOptional) || card.entries[0];
  if (!source) {
    startConnect(kind, card.provider);
    return;
  }
  conn.value = {
    open: true,
    kind,
    providerId: card.provider.id,
    mode: 'edit',
    configName: card.provider.id.startsWith('custom') ? card.provider.name : '',
    line: source.line || lineFor(card.provider, undefined, kind)?.id || '',
    baseUrl: source.baseUrl,
    modelsUrl: source.modelsUrl || '',
    apiKey: '',
    showKey: false,
    protocol: source.protocol || 'openai',
    modelsProtocol: source.modelsProtocol || source.protocol || 'openai',
    authOptional: Boolean(source.authOptional),
    modelsAnonymous: Boolean(source.modelsAnonymous),
    busy: false,
    message: '',
    ok: false,
  };
}

function startConnectCustom(kind: ModelKind) {
  startConnect(kind, { ...customPreset, id: '__new-custom__', name: '自定义' });
}

function cancelNewCustom(kind: ModelKind) {
  conn.value.open = false;
  selectedProvider.value = { ...selectedProvider.value, [kind]: selectedProviderId(kind) };
}

function onConnProtocolChange() {
  conn.value.modelsProtocol = conn.value.protocol;
}

function onConnLineChange(kind: ModelKind, provider: ProviderPreset) {
  const line = lineFor(provider, conn.value.line, kind);
  conn.value.baseUrl = line?.baseUrl || '';
  conn.value.modelsUrl = line ? (line.modelsUrl || inferredModelsUrl(line.baseUrl)) : '';
  conn.value.protocol = line?.protocol || 'openai';
  conn.value.modelsProtocol = line?.modelsProtocol || line?.protocol || 'openai';
  conn.value.authOptional = line?.authOptional || false;
  conn.value.modelsAnonymous = line?.modelsAnonymous || false;
  conn.value.message = '';
  conn.value.ok = false;
}

/** 手动修改 Base URL 后，模型目录地址跟随推导（否则会打到原线路的 models 接口） */
function onConnBaseUrlChange() {
  conn.value.modelsUrl = inferredModelsUrl(conn.value.baseUrl);
  conn.value.message = '';
  conn.value.ok = false;
}

function connKeyPlaceholder(kind: ModelKind): string {
  const provider = providerById(conn.value.providerId);
  const line = provider ? lineFor(provider, conn.value.line, kind) : undefined;
  return line?.apiKeyPlaceholder || 'API Key';
}

/** Key 默认密文显示；点击眼睛切换明文。编辑模式下输入框为空时，先取回已保存的完整 Key 再显示 */
async function toggleConnKey(kind: ModelKind, card: ProviderCard) {
  if (!conn.value.showKey && conn.value.mode === 'edit' && !conn.value.apiKey) {
    const source = providerEntries(kind, card.provider.id).find((model) => model.apiKey);
    if (source) {
      try {
        const { data } = await api.get(`/api/settings/models/${source.id}/key`);
        if (data.apiKey) conn.value.apiKey = data.apiKey;
      } catch {
        // 取回失败（如网络异常）时仅切换明文显示，不打断操作
      }
    }
  }
  conn.value.showKey = !conn.value.showKey;
}

function connHint(kind: ModelKind): string {
  const provider = providerById(conn.value.providerId);
  const line = provider ? lineFor(provider, conn.value.line, kind) : undefined;
  return line?.hint || provider?.hint || '';
}

/** 按当前 conn 配置拉取厂商目录并同步入库：更新既有条目连接、补齐新增模型；nameOverride 用于自定义配置改名 */
async function syncConnection(kind: ModelKind, provider: ProviderPreset, sourceEntryId?: string, nameOverride?: string): Promise<{ added: number; total: number }> {
  const keyless = conn.value.authOptional || conn.value.modelsAnonymous;
  const { data } = await api.post('/api/settings/discover-models', {
    baseUrl: conn.value.baseUrl,
    modelsUrl: conn.value.modelsUrl || undefined,
    modelsProtocol: conn.value.modelsProtocol === 'anthropic' ? 'anthropic' : 'openai',
    anonymous: keyless,
    apiKey: conn.value.apiKey.trim(),
    entryId: sourceEntryId,
    kind: kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document',
  });
  const line = providerById(provider.id)?.lines.find((item) => item.id === conn.value.line);
  const whitelist = line?.models?.length ? new Set(line.models) : null;
  const ids = (data.models || []).filter((id: string) => !whitelist || whitelist.has(id));
  if (!ids.length) throw new Error('厂商未返回可识别的模型列表');

  let apiKey = conn.value.apiKey.trim();
  if (!apiKey && !keyless) {
    const source = providerEntries(kind, provider.id).find((model) => model.apiKey);
    if (source) {
      const revealed = await api.get(`/api/settings/models/${source.id}/key`);
      apiKey = revealed.data.apiKey || '';
    }
  }

  const list = modelsRef(kind);
  let added = 0;
  for (const id of ids) {
    const draft: ModelDraft = {
      line: conn.value.line,
      baseUrl: conn.value.baseUrl,
      modelsUrl: conn.value.modelsUrl,
      model: id,
      modelChoice: id,
      apiKey,
      protocol: conn.value.protocol,
      modelsProtocol: conn.value.modelsProtocol,
      authOptional: conn.value.authOptional,
      modelsAnonymous: conn.value.modelsAnonymous,
      thinkingLevel: '',
      dim: 1024,
    };
    const existing = list.value.find((model) => model.provider === provider.id && model.model === id);
    const entry = entryFromDraft(kind, provider, draft, existing, nameOverride || existing?.name || provider.name, []);
    entry.apiKey = apiKey || existing?.apiKey || entry.apiKey;
    const index = list.value.findIndex((model) => model.id === entry.id);
    if (index >= 0) list.value[index] = entry;
    else {
      list.value.push(entry);
      added++;
    }
  }
  if (!activeIdFor(kind)) {
    const recommended = recommendedModelId(provider, kind);
    const preferred = recommended
      ? list.value.find((model) => model.provider === provider.id && model.model === recommended)
      : undefined;
    const target = preferred || list.value.find((model) => model.provider === provider.id);
    if (target) setActiveId(kind, target.id);
  }
  await persist();
  return { added, total: ids.length };
}

async function saveConnection(kind: ModelKind) {
  if (!normalizeUrl(conn.value.baseUrl)) {
    conn.value.ok = false;
    conn.value.message = '请填写 Base URL。';
    return;
  }
  let provider: ProviderPreset;
  let sourceEntryId: string | undefined;
  let nameOverride: string | undefined;
  if (conn.value.providerId === '__new-custom__') {
    const name = conn.value.configName.trim();
    if (!name) {
      conn.value.ok = false;
      conn.value.message = '请填写配置名称。';
      return;
    }
    if (!conn.value.apiKey.trim() && !conn.value.authOptional) {
      conn.value.ok = false;
      conn.value.message = '请填写 API Key。';
      return;
    }
    provider = { ...customPreset, id: `custom-${Math.random().toString(36).slice(2, 8)}`, name };
  } else if (conn.value.providerId === 'custom' || conn.value.providerId.startsWith('custom-')) {
    const group = unknownGroups(kind).find((item) => item.provider.id === conn.value.providerId);
    provider = group?.provider || { ...customPreset, id: conn.value.providerId, name: conn.value.configName.trim() || '自定义配置' };
    sourceEntryId = (group?.entries || []).find((model) => model.apiKey || model.authOptional)?.id;
    if (conn.value.configName.trim()) nameOverride = conn.value.configName.trim();
  } else {
    const card = cardsFor(kind).find((item) => item.provider.id === conn.value.providerId);
    if (!card) {
      conn.value.message = '配置不存在，请刷新页面后重试。';
      return;
    }
    provider = card.provider;
    sourceEntryId = card.entries.find((model) => model.apiKey || model.authOptional)?.id;
  }
  if (!conn.value.apiKey.trim() && !conn.value.authOptional && conn.value.mode === 'connect' && !sourceEntryId) {
    conn.value.ok = false;
    conn.value.message = '请填写 API Key。';
    return;
  }
  conn.value.busy = true;
  conn.value.ok = false;
  conn.value.message = '正在拉取模型列表...';
  try {
    const res = await syncConnection(kind, provider, sourceEntryId, nameOverride);
    conn.value.ok = true;
    conn.value.message = `已同步 ${res.total} 个模型（新增 ${res.added}），点击模型即可切换使用。`;
    notify.success(`已保存 · ${provider.name} · ${res.total} 个模型`);
    if (conn.value.providerId !== provider.id) {
      selectedProvider.value = { ...selectedProvider.value, [kind]: provider.id };
      conn.value.providerId = provider.id;
    }
    conn.value.open = false;
    if (kind === 'chat') void refreshActiveChatImageCapability();
  } catch (error: any) {
    conn.value.ok = false;
    conn.value.message = errorMessage(error, '拉取模型失败，请检查 API Key 与网络。');
  } finally {
    conn.value.busy = false;
  }
}

/** 删除整个自定义配置（含其全部模型条目） */
async function deleteCustomConfig(kind: ModelKind, card: ProviderCard) {
  const ok = await confirmDialog({
    title: '删除自定义配置',
    message: `删除「${card.provider.name}」及其全部 ${card.entries.length} 个模型配置？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  const list = modelsRef(kind);
  const previousList = list.value.map((model) => ({ ...model }));
  const previousActive = activeIdFor(kind);
  try {
    list.value = list.value.filter((model) => model.provider !== card.provider.id);
    if (previousActive && card.entries.some((entry) => entry.id === previousActive)) {
      setActiveId(kind, list.value[0]?.id || '');
    }
    await persist();
    selectedProvider.value = { ...selectedProvider.value, [kind]: '' };
    notify.success(`已删除自定义配置 · ${card.provider.name}`);
  } catch (error: any) {
    list.value = previousList;
    setActiveId(kind, previousActive);
    notify.error(errorMessage(error, '删除失败，请重试。'));
  }
}

/** 自定义配置里的手动添加：沿用该配置的连接，仅补录一个目录里没有的模型 */
function openManualAdd(kind: ModelKind, group: ProviderCard) {
  openForm(kind, undefined, group.provider.id);
  form.value.name = group.provider.name;
}

/** 目录外 provider 的显示名：优先取自定义分组名 */
function providerDisplayName(id: string): string {
  const preset = providerById(id);
  if (preset) return preset.name;
  for (const kind of ['chat', 'emb', 'document'] as ModelKind[]) {
    const group = unknownGroups(kind).find((item) => item.provider.id === id);
    if (group) return group.provider.name;
  }
  return providerName(id);
}

/** 批量入库用的完整 Key：优先取刚输入的明文；未输入时从服务端取该厂商已存条目的原值（新建条目无法依赖服务端掩码沿用） */
async function resolveBatchApiKey(): Promise<string> {
  const typed = form.value.apiKey.trim();
  if (typed) return typed;
  const list = modelsRef(form.value.kind).value;
  const source = list.find((model) => model.provider === form.value.provider && model.line === form.value.line && model.apiKey)
    || list.find((model) => model.provider === form.value.provider && model.apiKey);
  if (!source) return '';
  const { data } = await api.get(`/api/settings/models/${source.id}/key`);
  return data.apiKey || '';
}

const providerOptions = computed(() =>
  form.value.kind === 'emb'
    ? catalogList.value.filter((provider) => provider.embeddingModels.length > 0 || provider.id === 'custom')
    : form.value.kind === 'document'
      ? catalogList.value.filter((provider) => (provider.documentModels?.length || 0) > 0 || provider.id === 'custom')
      : catalogList.value
);

const currentFormProvider = computed<ProviderPreset>(() => {
  const preset = providerById(form.value.provider);
  if (preset) return preset;
  return { ...customPreset, id: form.value.provider, name: providerName(form.value.provider) };
});
/** 自定义/未知服务商需要显式选择协议；预设服务商由线路隐式决定 */
const showProtocolSelect = computed(() =>
  form.value.provider === 'custom' || !providerById(form.value.provider)
);
const existingFormEntry = computed(() => {
  if (!form.value.id) return undefined;
  const list = modelsRef(form.value.kind).value;
  return list.find((model) => model.id === form.value.id);
});
const formModelOptions = computed<FormModelOption[]>(() => {
  const options = new Map<string, FormModelOption>();
  for (const model of discoveredModels.value) options.set(model.id, model);

  // 目录兜底：该厂商该池的内置目录始终可见（Cherry Studio pull-reconcile 模式）——
  // 拉取失败或厂商无列表接口（如讯飞）时下拉不再只剩手填
  const kindKey = form.value.kind === 'chat'
    ? 'chat'
    : form.value.kind === 'emb'
      ? 'embedding'
      : 'document';
  const line = formLine.value;
  const catalogList = (kindKey === 'chat'
    ? currentFormProvider.value.chatModels
    : kindKey === 'embedding'
      ? currentFormProvider.value.embeddingModels
      : currentFormProvider.value.documentModels || []) as ModelOption[];
  const whitelist = line?.models?.length ? new Set(line.models) : null;
  for (const model of catalogList) {
    if (whitelist && !whitelist.has(model.id)) continue;
    if (!options.has(model.id)) options.set(model.id, { ...model, fromCatalog: true });
  }

  const current = modelValue(form.value);
  const existing = existingFormEntry.value;
  if (existing && current === existing.model && !options.has(current)) {
    const preset = modelById(currentFormProvider.value.id, current, kindKey);
    options.set(current, {
      id: current,
      name: preset?.name || current,
      ...preset,
      unavailable: modelDiscoveryCompleted.value,
    });
  }

  return [...options.values()];
});
const formDimensionOptions = computed(() =>
  dimensionOptionsForDraft(currentFormProvider.value, form.value, discoveredModels.value)
);
const formLine = computed(() => lineFor(currentFormProvider.value, form.value.line, form.value.kind));
const formKeyPlaceholder = computed(() => formLine.value?.apiKeyPlaceholder || 'API Key');
const formHint = computed(() => formLine.value?.hint || currentFormProvider.value.hint || '');
const currentFormModelUnavailable = computed(() => {
  if (!modelDiscoveryCompleted.value) return false;
  const existing = existingFormEntry.value;
  const current = modelValue(form.value);
  return Boolean(
    existing
    && current
    && current === existing.model
    && !discoveredModels.value.some((model) => model.id === current),
  );
});
/** 已存条目的 Key（服务端下发掩码）。保存时留空即沿用库中原值，前端不再持有明文。 */
const existingKeyMasked = computed(() => existingFormEntry.value?.apiKey || '');
const effectiveFormApiKey = computed(() =>
  form.value.apiKey.trim() || existingKeyMasked.value
);
const formApiKeyDisplayValue = computed(() => {
  if (revealedStoredKey.value) return revealedStoredKey.value;
  const typed = form.value.apiKey.trim();
  if (typed) return apiKeyRevealed.value ? typed : maskKey(typed);
  return existingKeyMasked.value;
});

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function inferredModelsUrl(baseUrl: string): string {
  const normalized = normalizeUrl(baseUrl);
  return normalized ? `${normalized}/models` : '';
}

function linesFor(provider: ProviderPreset, kind: ModelKind): ApiLine[] {
  if (kind !== 'chat') {
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

function modelOptionForDraft(
  kind: ModelKind,
  provider: ProviderPreset,
  draft: Pick<ModelDraft, 'model' | 'modelChoice'>,
  additionalModels: ModelOption[] = [],
) {
  if (draft.modelChoice === '__custom__') return undefined;
  const preset = modelById(
    provider.id,
    draft.modelChoice || draft.model,
    kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document'
  );
  const discovered = additionalModels.find((model) => model.id === (draft.modelChoice || draft.model));
  return discovered ? { ...preset, ...discovered } : preset;
}

function dimensionOptionsForDraft(
  provider: ProviderPreset,
  draft: Pick<ModelDraft, 'model' | 'modelChoice'>,
  additionalModels: ModelOption[] = [],
): number[] {
  return modelOptionForDraft('emb', provider, draft, additionalModels)?.dimensions || [];
}

function recommendedModelId(provider: ProviderPreset, kind: ModelKind): string | undefined {
  return kind === 'chat'
    ? provider.defaultChat
    : kind === 'emb'
      ? provider.defaultEmbedding
      : provider.defaultDocument;
}

function createDraft(kind: ModelKind, provider: ProviderPreset, existing?: ModelEntry): ModelDraft {
  const line = inferLine(provider, existing, kind);
  const existingOption = existing
    ? modelById(
        provider.id,
        existing.model,
        kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document',
      )
    : undefined;
  return {
    line,
    baseUrl: existing?.baseUrl || lineFor(provider, line, kind)?.baseUrl || '',
    modelsUrl: existing?.modelsUrl || lineFor(provider, line, kind)?.modelsUrl || '',
    model: existing?.model || '',
    modelChoice: existing?.model || '',
    apiKey: '',
    protocol: existing?.protocol || lineFor(provider, line, kind)?.protocol || 'openai',
    modelsProtocol: existing?.modelsProtocol
      || lineFor(provider, line, kind)?.modelsProtocol
      || lineFor(provider, line, kind)?.protocol
      || 'openai',
    authOptional: existing?.authOptional || lineFor(provider, line, kind)?.authOptional || false,
    modelsAnonymous: existing?.modelsAnonymous || lineFor(provider, line, kind)?.modelsAnonymous || false,
    thinkingLevel: existing?.thinkingLevel || '',
    dim: existing?.dim || existingOption?.dim || 1024,
  };
}

function providerName(id: string): string {
  return providerById(id)?.name || id || '自定义';
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function modelValue(draft: ModelDraft): string {
  return (draft.modelChoice === '__custom__' ? draft.model : draft.modelChoice).trim();
}

function validateDraft(draft: ModelDraft, kind: ModelKind, apiKey: string): string {
  if (!normalizeUrl(draft.baseUrl)) return '请填写 Base URL。';
  if (!modelValue(draft)) return '请填写模型名称。';
  if (!apiKey.trim() && !draft.authOptional) return '请填写 API Key。';
  if (kind === 'emb' && (!Number.isFinite(draft.dim) || draft.dim <= 0)) return '请填写有效的向量维度。';
  return '';
}

function entryFromDraft(
  kind: ModelKind,
  provider: ProviderPreset,
  draft: ModelDraft,
  existing?: ModelEntry,
  name?: string,
  additionalModels: ModelOption[] = [],
): ModelEntry {
  const model = modelValue(draft);
  const option = modelOptionForDraft(kind, provider, draft, additionalModels);
  const supportsDimensions = kind === 'emb'
    ? option?.supportsDimensions === true
      || (!option && existing?.model === model && existing.supportsDimensions === true)
    : undefined;
  const sameEndpoint = existing?.model === model
    && normalizeUrl(existing.baseUrl) === normalizeUrl(draft.baseUrl);
  const imageInput = kind !== 'emb'
    ? option?.imageInput
      || (sameEndpoint ? existing?.imageInput : undefined)
    : undefined;
  const imageInputSource = option?.imageInput
    ? 'catalog'
    : sameEndpoint
      ? existing?.imageInputSource
      : undefined;
  return {
    id: existing?.id || newId(),
    name: name?.trim() || existing?.name || provider.name,
    provider: provider.id,
    line: draft.line,
    baseUrl: normalizeUrl(draft.baseUrl),
    modelsUrl: normalizeUrl(draft.modelsUrl),
    model,
    // 留空保存 = 服务端沿用库中原 Key；新输入的明文原样提交
    apiKey: draft.apiKey.trim(),
    ...(draft.protocol === 'anthropic' ? { protocol: 'anthropic' as const } : {}),
    ...(draft.modelsProtocol === 'anthropic' ? { modelsProtocol: 'anthropic' as const } : {}),
    ...(draft.authOptional ? { authOptional: true } : {}),
    ...(draft.modelsAnonymous ? { modelsAnonymous: true } : {}),
    ...(kind === 'chat' && draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    ...(kind === 'emb' ? { dim: draft.dim || option?.dim || 1024, supportsDimensions } : {}),
    ...(imageInput ? { imageInput, imageInputSource } : {}),
    ...(sameEndpoint && existing?.imageInputCheckedAt
      ? { imageInputCheckedAt: existing.imageInputCheckedAt }
      : {}),
  };
}

function openForm(kind: ModelKind, existing?: ModelEntry, providerId?: string) {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  batchManual.value = false;
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
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
  if (existing?.apiKey) {
    queueMicrotask(() => void discoverFormModels());
  }
}

function pickProvider(id: string) {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  batchManual.value = false;
  const provider = providerById(id) || customPreset;
  const hasGeneratedName = !form.value.name || catalogList.value.some((item) => item.name === form.value.name);
  const draft = createDraft(form.value.kind, provider);
  form.value.line = draft.line;
  form.value.baseUrl = draft.baseUrl;
  form.value.modelsUrl = draft.modelsUrl;
  form.value.model = draft.model;
  form.value.modelChoice = draft.modelChoice;
  form.value.apiKey = '';
  form.value.protocol = draft.protocol;
  form.value.modelsProtocol = draft.modelsProtocol;
  form.value.authOptional = draft.authOptional;
  form.value.modelsAnonymous = draft.modelsAnonymous;
  form.value.thinkingLevel = draft.thinkingLevel;
  form.value.dim = draft.dim;
  if (hasGeneratedName) form.value.name = provider.name;
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
}

function applyLineToDraft(kind: ModelKind, provider: ProviderPreset, draft: ModelDraft, lineId: string) {
  draft.line = lineId;
  const line = lineFor(provider, lineId, kind);
  if (line) draft.baseUrl = line.baseUrl;
  if (line) draft.modelsUrl = line.modelsUrl || inferredModelsUrl(line.baseUrl);
  draft.protocol = line?.protocol || 'openai';
  draft.modelsProtocol = line?.modelsProtocol || line?.protocol || 'openai';
  draft.authOptional = line?.authOptional || false;
  draft.modelsAnonymous = line?.modelsAnonymous || false;
  draft.modelChoice = '';
  draft.model = '';
  if (kind === 'emb') draft.dim = 1024;
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

function onFormLineChange() {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  applyLineToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.line);
  form.value.protocol = form.value.protocol || 'openai';
  form.value.modelsProtocol = form.value.modelsProtocol || form.value.protocol;
  form.value.authOptional = form.value.authOptional || false;
  form.value.modelsAnonymous = form.value.modelsAnonymous || false;
  form.value.apiKey = '';
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
}

function onFormModelChange() {
  applyModelToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.modelChoice);
  formError.value = '';
}

function resetFormModelDiscovery(clearNewSelection = false) {
  modelDiscoveryRequestId++;
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
  if (clearNewSelection) {
    const existing = existingFormEntry.value;
    if (!existing || modelValue(form.value) !== existing.model) {
      form.value.modelChoice = '';
      form.value.model = '';
      if (form.value.kind === 'emb') form.value.dim = 1024;
    }
  }
}

function revealFormApiKey() {
  if (!effectiveFormApiKey.value) return;
  apiKeyRevealed.value = true;
  // 已存条目：从服务端拉取完整 Key 展示（列表通道只下发掩码）
  const existing = existingFormEntry.value;
  if (existing?.apiKey && !revealedStoredKey.value) {
    api.get(`/api/settings/models/${existing.id}/key`)
      .then(({ data }) => { revealedStoredKey.value = data.apiKey || ''; })
      .catch(() => { revealedStoredKey.value = ''; });
  }
  void nextTick(() => {
    const input = apiKeyInput.value;
    if (!input) return;
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function onFormApiKeyInput(event: Event) {
  const value = (event.currentTarget as HTMLInputElement).value;
  revealedStoredKey.value = '';
  form.value.apiKey = value;
  apiKeyRevealed.value = true;
  resetFormModelDiscovery(true);
}

function onFormApiKeyBlur() {
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  void discoverFormModels();
}

function modelOptionLabel(model: FormModelOption): string {
  if (model.unavailable) return `${model.name}（当前账号未返回）`;
  if (model.fromCatalog && !discoveredModels.value.length) return `${model.name}（目录）`;
  return model.name;
}

function selectDiscoveredModelId(
  modelIds: string[],
  recommendedId?: string,
  currentId?: string,
  preserveUnavailable = false,
): string {
  if (currentId && modelIds.includes(currentId)) return currentId;
  if (preserveUnavailable && currentId) return currentId;
  if (recommendedId && modelIds.includes(recommendedId)) return recommendedId;
  return modelIds[0] || '';
}

function onFormBaseUrlChange() {
  apiKeyRevealed.value = false;
  resetFormModelDiscovery(true);
  form.value.modelsUrl = inferredModelsUrl(form.value.baseUrl);
  if (form.value.apiKey.trim()) void discoverFormModels();
}

async function discoverFormModels(apiKeyOverride?: string) {
  const requestId = ++modelDiscoveryRequestId;
  // 已存条目未重输 Key 时传空：服务端按条目 id 补全库中原值，前端不经手明文
  const apiKey = apiKeyOverride && !apiKeyOverride.includes('*')
    ? apiKeyOverride
    : form.value.apiKey.trim();
  // 免鉴权线路（本地推理）或匿名模型目录：无 Key 也发起拉取
  const keylessAllowed = form.value.authOptional || form.value.modelsAnonymous;
  if (!apiKey && !keylessAllowed) {
    modelDiscoveryCompleted.value = false;
    discoveryBusy.value = false;
    discoveryOk.value = false;
    discoveryMessage.value = '输入 API Key 后会自动拉取可用模型。';
    return;
  }
  if (!normalizeUrl(form.value.baseUrl)) {
    modelDiscoveryCompleted.value = false;
    discoveryBusy.value = false;
    discoveryOk.value = false;
    discoveryMessage.value = '请先填写 Base URL。';
    return;
  }
  // 目录线路没有显式 modelsUrl 且厂商无列表接口（如讯飞）时，直接展示内置目录
  const lineHasModelsApi = Boolean(form.value.modelsUrl) || form.value.modelsAnonymous;
  discoveryBusy.value = true;
  discoveryMessage.value = '';
  try {
    const { data } = await api.post('/api/settings/discover-models', {
      baseUrl: form.value.baseUrl,
      modelsUrl: form.value.modelsUrl || undefined,
      modelsProtocol: form.value.modelsProtocol === 'anthropic' ? 'anthropic' : 'openai',
      anonymous: keylessAllowed,
      apiKey,
      entryId: existingFormEntry.value?.id || form.value.id || undefined,
      kind: form.value.kind === 'chat'
        ? 'chat'
        : form.value.kind === 'emb'
          ? 'embedding'
          : 'document',
    });
    if (requestId !== modelDiscoveryRequestId) return;
    form.value.modelsUrl = data.url || inferredModelsUrl(form.value.baseUrl);
    const kind = form.value.kind === 'chat' ? 'chat' : form.value.kind === 'emb' ? 'embedding' : 'document';
    discoveredModels.value = (data.models || []).map((id: string) => {
      const preset = modelById(currentFormProvider.value.id, id, kind);
      return {
        ...preset,
        id,
        name: preset?.name || id,
        ...(data.capabilities?.[id]
          ? { imageInput: data.capabilities[id] as ImageInputStatus }
          : {}),
      };
    });
    modelDiscoveryCompleted.value = true;
    discoveryOk.value = true;
    const current = form.value.modelChoice === '__custom__' ? form.value.model : form.value.modelChoice;
    const nextModelId = selectDiscoveredModelId(
      discoveredModels.value.map((model) => model.id),
      recommendedModelId(currentFormProvider.value, form.value.kind),
      current,
      Boolean(
        (existingFormEntry.value && current === existingFormEntry.value.model)
        || (form.value.modelChoice === '__custom__' && form.value.model.trim())
      ),
    );
    if (nextModelId && nextModelId !== current) {
      applyModelToDraft(form.value.kind, currentFormProvider.value, form.value, nextModelId);
    }
    discoveryMessage.value = currentFormModelUnavailable.value
      ? `已拉取 ${discoveredModels.value.length} 个可用模型；原配置未在当前账号目录中返回，已保留。`
      : `已自动拉取 ${discoveredModels.value.length} 个可用模型。`;
  } catch (error: any) {
    if (requestId !== modelDiscoveryRequestId) return;
    modelDiscoveryCompleted.value = false;
    discoveryOk.value = false;
    discoveryMessage.value = errorMessage(error, '自动拉取失败，可手动填写模型 ID。');
  } finally {
    if (requestId === modelDiscoveryRequestId) discoveryBusy.value = false;
  }
}

async function persist() {
  await api.put('/api/settings/models', {
    chat: chatModels.value,
    embedding: embModels.value,
    document: documentModels.value,
    activeChat: activeChat.value,
    activeEmbedding: activeEmb.value,
    activeDocument: activeDocument.value,
  });
}

function updateVisionCapabilityDetail(status: ImageInputStatus, detail = '') {
  if (status === 'supported') {
    imageCapabilityDetail.value = dedicatedVisionConfigured.value
      ? '已配置的专用视觉模型仍会优先使用。'
      : '需要处理图片时将自动复用当前对话模型。';
    return;
  }
  if (status === 'unsupported' && dedicatedVisionConfigured.value) {
    imageCapabilityDetail.value = '已配置专用视觉模型，图片解析会使用该配置。';
    return;
  }
  imageCapabilityDetail.value = detail;
}

async function refreshActiveChatImageCapability(force = false) {
  const requestId = ++imageCapabilityRequestId;
  const chat = activeModelFor('chat');
  if (!chat?.apiKey) {
    imageCapabilityChecking.value = false;
    imageCapabilityDetail.value = '';
    return;
  }
  if (!force && (chat.imageInput === 'supported' || chat.imageInput === 'unsupported')) {
    imageCapabilityChecking.value = false;
    updateVisionCapabilityDetail(chat.imageInput);
    return;
  }
  if (!force && checkedImageCapabilityIds.has(chat.id)) {
    imageCapabilityChecking.value = false;
    return;
  }

  imageCapabilityChecking.value = true;
  imageCapabilityDetail.value = '';
  checkedImageCapabilityIds.add(chat.id);
  try {
    // chat.apiKey 可能是掩码（列表通道脱敏）：服务端 probe 入口按条目 id 补全原值
    const { data } = await api.post('/api/settings/probe-image-input', { entry: chat, force });
    if (requestId !== imageCapabilityRequestId || activeChat.value !== chat.id) return;
    const status = (data.status || 'unknown') as ImageInputStatus;
    if (status === 'supported' || status === 'unsupported') {
      const index = chatModels.value.findIndex((entry) => entry.id === chat.id);
      if (index >= 0) {
        chatModels.value[index] = {
          ...chatModels.value[index],
          imageInput: status,
          imageInputSource: data.source || 'probe',
          imageInputCheckedAt: new Date().toISOString(),
        };
        await persist();
      }
    }
    updateVisionCapabilityDetail(status, data.detail || '');
  } catch (error: any) {
    if (requestId === imageCapabilityRequestId) {
      imageCapabilityDetail.value = errorMessage(error, '多模态能力检测失败，请稍后重试。');
    }
  } finally {
    if (requestId === imageCapabilityRequestId) imageCapabilityChecking.value = false;
  }
}

/** 批量保存：拉取到的模型全部入库（同一厂商+线路共用 Key），推荐模型优先设为当前 */
async function saveBatchModels() {
  formError.value = '';
  const kind = form.value.kind;
  const provider = currentFormProvider.value;
  const selected = [...batchModelOptions.value];
  if (!selected.length) {
    formError.value = '请先拉取模型列表。';
    return;
  }
  if (!normalizeUrl(form.value.baseUrl)) {
    formError.value = '请填写 Base URL。';
    return;
  }
  if (!effectiveFormApiKey.value && !form.value.authOptional) {
    formError.value = '请填写 API Key。';
    return;
  }
  formSaving.value = true;
  const list = modelsRef(kind);
  const previousList = list.value.map((model) => ({ ...model }));
  const previousActive = activeIdFor(kind);
  try {
    const apiKey = await resolveBatchApiKey();
    if (!apiKey && !form.value.authOptional) {
      throw new Error('无法获取完整 API Key，请重新输入后再保存。');
    }
    let firstEntryId = '';
    for (const option of selected) {
      const draft: ModelDraft = { ...form.value, model: option.id, modelChoice: option.id };
      const existing = list.value.find(
        (model) => model.provider === provider.id
          && model.model === option.id
          && normalizeUrl(model.baseUrl) === normalizeUrl(form.value.baseUrl),
      );
      const entry = entryFromDraft(kind, provider, draft, existing, existing?.name || provider.name, discoveredModels.value);
      entry.apiKey = apiKey;
      const index = list.value.findIndex((model) => model.id === entry.id);
      if (index >= 0) list.value[index] = entry;
      else list.value.push(entry);
      if (!firstEntryId) firstEntryId = entry.id;
    }
    if (!activeIdFor(kind)) {
      const recommended = recommendedModelId(provider, kind);
      const preferred = recommended
        ? list.value.find((model) => model.provider === provider.id && model.model === recommended)
        : undefined;
      setActiveId(kind, preferred?.id || firstEntryId);
    }
    await persist();
    form.value.show = false;
    notify.success(`已保存 ${selected.length} 个模型 · ${provider.name}`);
    if (kind === 'chat' && activeChat.value) {
      checkedImageCapabilityIds.delete(activeChat.value);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    list.value = previousList;
    setActiveId(kind, previousActive);
    formError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    formSaving.value = false;
  }
}

/** 批量模式下测试连接：测第一个模型（Key 掩码时先取完整原值） */
async function testBatchModel() {
  formError.value = '';
  const kind = form.value.kind;
  const provider = currentFormProvider.value;
  const option = batchModelOptions.value[0];
  if (!option) {
    formError.value = '请先拉取模型列表。';
    return;
  }
  formTesting.value = true;
  try {
    const apiKey = await resolveBatchApiKey();
    const entry = entryFromDraft(
      kind,
      provider,
      { ...form.value, model: option.id, modelChoice: option.id, apiKey },
      undefined,
      provider.name,
      discoveredModels.value,
    );
    const { data } = await api.post('/api/settings/test-llm', {
      entry,
      kind: kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document',
    });
    if (data.ok) notify.success(`连接成功 · ${provider.name} · ${entry.model}`);
    else notify.error(data.error || '模型连接测试失败。');
  } catch (error: any) {
    notify.error(errorMessage(error, '连接测试失败。'));
  } finally {
    formTesting.value = false;
  }
}

/** 「重新拉取」：沿用已存连接增量同步该厂商的模型列表（只新增，不自动删除） */
async function refreshProviderModels(kind: ModelKind, card: ProviderCard) {
  if (refreshingProvider.value) return;
  const source = card.entries.find((model) => model.apiKey || model.authOptional) || card.entries[0];
  if (!source) return;
  conn.value = {
    open: false,
    kind,
    providerId: card.provider.id,
    mode: 'edit',
    configName: '',
    line: source.line || '',
    baseUrl: source.baseUrl,
    modelsUrl: source.modelsUrl || '',
    apiKey: '',
    showKey: false,
    protocol: source.protocol || 'openai',
    modelsProtocol: source.modelsProtocol || source.protocol || 'openai',
    authOptional: Boolean(source.authOptional),
    modelsAnonymous: Boolean(source.modelsAnonymous),
    busy: true,
    message: '',
    ok: false,
  };
  refreshingProvider.value = `${kind}:${card.provider.id}`;
  try {
    const res = await syncConnection(kind, card.provider, source.id);
    notify.success(`已同步 ${res.total} 个模型（新增 ${res.added}）· ${card.provider.name}`);
  } catch (error: any) {
    notify.error(errorMessage(error, '拉取模型失败。'));
  } finally {
    refreshingProvider.value = '';
    conn.value.busy = false;
  }
}

async function saveModel() {
  if (batchPickAvailable.value) {
    // 刚填完 Key 直接点保存时，Key 的 blur 拉取可能还在路上：先等拉取完成再入库
    if (!modelDiscoveryCompleted.value && !discoveryBusy.value && form.value.apiKey.trim() && normalizeUrl(form.value.baseUrl)) {
      await discoverFormModels();
    }
    await saveBatchModels();
    return;
  }
  formError.value = '';
  const existing = existingFormEntry.value;
  const effectiveKey = effectiveFormApiKey.value;
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formSaving.value = true;
  const kind = form.value.kind;
  const list = modelsRef(kind);
  const previousList = list.value.map((model) => ({ ...model }));
  const previousActive = activeIdFor(kind);
  try {
    const entry = entryFromDraft(
      kind,
      currentFormProvider.value,
      form.value,
      existing,
      form.value.name,
      discoveredModels.value,
    );
    const index = list.value.findIndex((model) => model.id === entry.id);
    if (index >= 0) {
      // 服务端返回的条目带掩码 Key；未重输 Key 时保留掩码占位，保存时服务端沿用原值
      list.value[index] = { ...entry, apiKey: form.value.apiKey.trim() || existing?.apiKey || entry.apiKey };
    }
    else list.value.push(entry);
    if (!activeIdFor(kind)) setActiveId(kind, entry.id);
    await persist();
    form.value.show = false;
    notify.success(`已保存配置 · ${entry.model}`);
    if (kind === 'chat' && activeChat.value === entry.id) {
      checkedImageCapabilityIds.delete(entry.id);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    list.value = previousList;
    setActiveId(kind, previousActive);
    formError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    formSaving.value = false;
  }
}

async function selectModel(kind: ModelKind, id: string) {
  const previous = activeIdFor(kind);
  try {
    setActiveId(kind, id);
    await persist();
    if (kind === 'chat') {
      checkedImageCapabilityIds.delete(id);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    setActiveId(kind, previous);
    notify.error(errorMessage(error, '启用失败，请重试。'));
  }
}

async function removeModel(kind: ModelKind, id: string) {
  const ok = await confirmDialog({
    title: '删除模型配置',
    message: '删除该模型配置？',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  const listRef = modelsRef(kind);
  const previousList = [...listRef.value];
  const previousActive = activeIdFor(kind);
  try {
    listRef.value = listRef.value.filter((model) => model.id !== id);
    if (activeIdFor(kind) === id) setActiveId(kind, listRef.value[0]?.id || '');
    await persist();
    if (kind === 'chat' && previousActive === id) {
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    listRef.value = previousList;
    setActiveId(kind, previousActive);
    notify.error(errorMessage(error, '删除失败，请重试。'));
  }
}

async function testForm() {
  if (batchPickAvailable.value) {
    await testBatchModel();
    return;
  }
  formError.value = '';
  const existing = existingFormEntry.value;
  // 掩码 Key（已存条目未重输）也放行校验：服务端测试入口会按 id 补全原值；
  // 免鉴权线路（本地推理）无 Key 直接放行
  const effectiveKey = form.value.apiKey.trim() || existing?.apiKey || (form.value.authOptional ? 'local' : '');
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formTesting.value = true;
  try {
    const entry = entryFromDraft(
      form.value.kind,
      currentFormProvider.value,
      form.value,
      existing,
      form.value.name,
      discoveredModels.value,
    );
    const { data } = await api.post('/api/settings/test-llm', {
      entry,
      kind: form.value.kind === 'chat'
        ? 'chat'
        : form.value.kind === 'emb'
          ? 'embedding'
          : 'document',
    });
    if (data.ok) notify.success(`连接成功 · ${currentFormProvider.value.name} · ${entry.model}`);
    else notify.error(data.error || '模型连接测试失败。');
  } catch (error: any) {
    notify.error(errorMessage(error, '连接测试失败。'));
  } finally {
    formTesting.value = false;
  }
}

async function rebuild() {
  const ok = await confirmDialog({
    title: '重建索引',
    message: '将重新扫描并索引全部页面，可能需要几分钟。继续？',
    confirmText: '继续',
  });
  if (!ok) return;
  await api.post('/api/settings/rebuild-index');
  notify.success('索引重建已开始，任务正在后台运行。');
}

// ---------- 用量统计 ----------
const llmUsageDays = ref(7);
const llmUsage = ref<LlmUsageSummary>(emptyLlmUsage());
const llmUsageLoading = ref(false);
const llmUsageClearing = ref(false);
const llmUsageError = ref('');
const llmUsageNotice = ref('');

const LLM_USAGE_TAG_LABELS: Record<string, string> = {
  'ingest-map': '入库映射',
  'ingest-normalize': '入库归一化',
  'ingest-plan': '入库规划',
  'ingest-critic': '入库评审',
  'ingest-critic-review': '入库评审复核',
  'ingest-compose': '入库合成',
  'ingest-questions': '入库追问',
  'ingest-verify': '入库校验',
  'ingest-pipeline-cache': '入库结果复用',
  'entity-identity': '实体身份判断',
  entities: '页面实体抽取',
  'page-synthesis-compose': '页面综合合成',
  'page-synthesis-verify': '页面综合校验',
  'assistant-route': '助手路由',
  'assistant-tools': '助手工具决策',
  'assistant-answer': '助手回答',
  'search-answer': '知识问答',
  embedding: '向量化',
  'document-ocr': '图片识别',
  'image-capability-probe': '图片能力检测',
  'connection-test-chat': '对话连接测试',
  'connection-test-embedding': '向量连接测试',
};

function usageTagLabel(tag: string): string {
  if (LLM_USAGE_TAG_LABELS[tag]) return LLM_USAGE_TAG_LABELS[tag];
  if (tag.startsWith('writer-')) return `写作助手 · ${tag.slice('writer-'.length)}`;
  return tag;
}

const LLM_OPERATION_LABELS: Record<string, string> = {
  chat: '语言模型',
  embedding: '向量模型',
  document: '视觉模型',
};

function usageOperationLabel(operation: string): string {
  return LLM_OPERATION_LABELS[operation] || operation;
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
}

function formatUsageRate(value: number | null): string {
  return value === null ? '未报告' : `${(value * 100).toFixed(1)}%`;
}

function formatUsageMultiplier(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}×`;
}

function formatUsageTime(value: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadLlmUsage() {
  llmUsageLoading.value = true;
  llmUsageError.value = '';
  try {
    const { data } = await api.get('/api/settings/llm-usage', {
      params: { days: llmUsageDays.value },
    });
    llmUsage.value = data;
  } catch (error: any) {
    llmUsageError.value = errorMessage(error, '模型用量读取失败。');
  } finally {
    llmUsageLoading.value = false;
  }
}

async function clearLlmUsage() {
  const ok = await confirmDialog({
    title: '清除模型用量',
    message: '确定清除全部模型用量统计吗？此操作不会删除模型配置、知识内容或供应商侧缓存。',
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  llmUsageClearing.value = true;
  llmUsageError.value = '';
  llmUsageNotice.value = '';
  try {
    const { data } = await api.delete('/api/settings/llm-usage');
    llmUsage.value = emptyLlmUsage(llmUsageDays.value);
    llmUsageNotice.value = `已清除 ${data.deleted || 0} 条模型用量记录。`;
  } catch (error: any) {
    llmUsageError.value = errorMessage(error, '模型用量清除失败。');
  } finally {
    llmUsageClearing.value = false;
  }
}

watch(
  () => [activeModelKind.value, activeChat.value] as const,
  ([kind]) => {
    if (kind === 'document') void refreshActiveChatImageCapability();
  },
);

onMounted(async () => {
  const [{ data: catalogData }, { data: modelsData }] = await Promise.all([
    api.get('/api/settings/model-catalog'),
    api.get('/api/settings/models'),
  ]);
  setModelCatalog(catalogData.providers || []);
  chatModels.value = modelsData.chat || [];
  embModels.value = modelsData.embedding || [];
  documentModels.value = modelsData.document || [];
  activeChat.value = modelsData.activeChat || chatModels.value[0]?.id || '';
  activeEmb.value = modelsData.activeEmbedding || embModels.value[0]?.id || '';
  activeDocument.value = modelsData.activeDocument || documentModels.value[0]?.id || '';
  void loadLlmUsage();
  if (activeModelKind.value === 'document') void refreshActiveChatImageCapability();
});
</script>

<style scoped>
.model-panel-head {
  align-items: center;
}

.llm-usage-band {
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-secondary) 62%, var(--bg));
}
.llm-usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.llm-usage-head > div:first-child {
  min-width: 0;
}
.llm-usage-head strong,
.llm-usage-head span {
  display: block;
}
.llm-usage-head strong {
  font-size: 13px;
}
.llm-usage-head span {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.llm-usage-controls select {
  width: 104px;
  min-height: 32px;
}
.llm-usage-ops {
  margin-top: 16px;
  border-top: 1px solid var(--border);
}
.llm-usage-op {
  display: grid;
  grid-template-columns: minmax(120px, 0.9fr) repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--border);
}
.llm-usage-op-head {
  min-width: 0;
}
.llm-usage-op-head strong {
  display: block;
  font-size: 13px;
}
.llm-usage-op-head small {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-op > div:not(.llm-usage-op-head) {
  min-width: 0;
}
.llm-usage-op > div:not(.llm-usage-op-head) span {
  display: block;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-op > div:not(.llm-usage-op-head) strong {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  color: var(--text);
  font-size: 19px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-usage-op > div:not(.llm-usage-op-head) small {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-usage-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  margin-top: 12px;
  padding: 8px 2px;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-summary span {
  white-space: nowrap;
}
.llm-usage-breakdown {
  margin-top: 13px;
}
.llm-usage-row {
  display: grid;
  grid-template-columns: minmax(150px, 1.3fr) 56px minmax(110px, 1fr) 58px 58px 72px;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 6px 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  font-size: 11px;
}
.llm-usage-row > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-usage-model-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.3;
}
.llm-usage-model-cell strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
}
.llm-usage-model-cell small {
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
}
.llm-usage-kind-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}
.llm-usage-row > span:nth-child(3) {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.llm-usage-row strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
}
.llm-usage-row small {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 10px;
}
.llm-usage-hit-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.3;
}
.llm-usage-hit-cell strong {
  font-size: 11px;
  font-weight: 600;
}
.llm-usage-hit-cell small {
  color: var(--text-faint);
  font-size: 10px;
}
.llm-usage-row-head {
  min-height: 28px;
  color: var(--text-faint);
  font-size: 10px;
}
.llm-usage-empty {
  padding: 24px 0 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}
.llm-usage-band > .setting-message {
  margin-top: 12px;
}

.model-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  width: calc(100% - 48px);
  margin: 18px 24px 0;
  padding: 3px;
  border-radius: 8px;
  background: var(--bg-secondary);
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
  box-shadow: none;
  font-weight: 600;
}
.model-tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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

.vision-capability-note {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.vision-capability-note.supported {
  border-color: color-mix(in srgb, var(--success) 24%, var(--border));
  background: color-mix(in srgb, var(--success) 6%, var(--bg));
  color: var(--success);
}
.vision-capability-note.warning {
  border-color: color-mix(in srgb, var(--warn) 24%, var(--border));
  background: color-mix(in srgb, var(--warn) 6%, var(--bg));
  color: var(--warn);
}
.vision-capability-note.checking {
  color: var(--accent);
}
.vision-capability-note > div {
  min-width: 0;
}
.vision-capability-note strong,
.vision-capability-note span {
  display: block;
}
.vision-capability-note strong {
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.vision-capability-note span {
  margin-top: 2px;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.45;
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
.model-section-intro > span {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
}
.current-model-line {
  display: block;
  margin-top: 4px;
  color: var(--accent);
  font-size: 11px;
}

/* ---------- 服务商主从布局（左导航 + 右详情） ---------- */
.provider-split {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  overflow: hidden;
}
.provider-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
  overflow-y: auto;
  max-height: 560px;
}
.provider-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 7px 9px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
}
.provider-nav-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-nav-item em {
  flex-shrink: 0;
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 9px;
  font-style: normal;
  text-align: center;
}
.provider-nav-item:hover {
  background: var(--bg-tertiary);
  color: var(--text);
}
.provider-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.provider-nav-item.active em {
  background: var(--accent);
  color: #fff;
}
.provider-nav-divider {
  margin: 10px 6px 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 10px;
}
.provider-nav-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin: 8px 2px 0;
  padding: 7px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 11px;
}
.provider-nav-add:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.provider-detail {
  min-width: 0;
  padding: 16px 18px 18px;
}
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.detail-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.detail-title strong {
  font-size: 14px;
}
.detail-title span {
  color: var(--text-faint);
  font-size: 10px;
}
.provider-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.provider-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 4px 5px;
  border-radius: 5px;
  color: var(--accent);
  font-size: 10px;
}
.provider-add-btn:hover {
  background: var(--accent-soft);
}
.provider-add-btn.danger {
  color: var(--danger);
}
.provider-add-btn.danger:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

/* 连接表单（未配置 / 编辑连接） */
.conn-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.conn-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.conn-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.conn-grid input,
.conn-grid select {
  width: 100%;
  min-width: 0;
  font-weight: 400;
}
.conn-key-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.conn-key-field input {
  flex: 1;
  min-width: 0;
}
.conn-key-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--text-faint);
}
.conn-key-toggle:hover {
  background: var(--bg-tertiary);
  color: var(--text);
}
.conn-msg {
  margin: 0;
  font-size: 11px;
}
.conn-msg.ok {
  color: var(--accent);
}
.conn-msg.err {
  color: var(--danger);
}
.conn-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conn-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding: 26px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  text-align: center;
}
.conn-empty p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

/* 全部模型列表（点选即用） */
.model-catalog {
  margin-top: 14px;
}
.model-catalog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 10px;
}
.model-catalog-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  padding: 8px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 58%, transparent);
  color: var(--text);
  font-size: 12px;
  text-align: left;
}
.model-catalog-row:hover {
  background: var(--bg-secondary);
}
.model-catalog-row.active {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  box-shadow: inset 2.5px 0 0 var(--accent);
}
.model-catalog-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--border-strong);
}
.model-catalog-row:hover .model-catalog-dot {
  background: var(--text-faint);
}
.model-catalog-dot.active {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.model-catalog-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
}
.model-catalog-row.active .model-catalog-name {
  color: var(--accent);
  font-weight: 600;
}
.model-catalog-current {
  flex-shrink: 0;
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
}
.model-catalog-row.active .model-catalog-current + .model-catalog-remove {
  margin-left: 8px;
}
.model-catalog-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  margin-left: auto;
  border-radius: 5px;
  color: var(--text-faint);
  opacity: 0;
}
.model-catalog-row:hover .model-catalog-remove,
.model-catalog-remove:focus-visible {
  opacity: 1;
}
.model-catalog-remove:hover {
  background: var(--bg-tertiary);
  color: var(--danger);
}
.model-catalog-row.active .model-catalog-remove {
  margin-left: 0;
}
.model-catalog-dim {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 10px;
}
.custom-add-row {
  margin-top: 12px;
}

/* ---------- 模型对话框 ---------- */
.dialog-kind-label {
  margin: 5px 0 0;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}
.modal-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
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
.api-key-input {
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
}
.field-help {
  color: var(--text-faint);
  font-size: 10px;
}
.model-unavailable-help {
  color: var(--warn);
  line-height: 1.45;
}
.batch-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.connection-edit-hint {
  margin: -4px 0 0;
  color: var(--warn);
}
.discovery-url-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.discovery-url-row .btn {
  min-width: 88px;
}
.discovery-url-row > .field-help {
  align-self: center;
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
.discovery-message {
  margin-top: 10px;
  min-height: 17px;
  overflow: hidden;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dialog-footer-right {
  display: flex;
  gap: 8px;
}

/* ---------- 响应式 ---------- */
@media (max-width: 768px) {
  .model-panel-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .llm-usage-band {
    padding: 16px 18px;
  }
  .llm-usage-op {
    grid-template-columns: minmax(100px, 0.8fr) repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 11px 10px;
  }
  .llm-usage-op > div:not(.llm-usage-op-head) strong {
    font-size: 17px;
  }
  .llm-usage-row {
    grid-template-columns: minmax(120px, 1.2fr) minmax(80px, 1fr) 50px 50px 64px;
  }
  .llm-usage-kind-tag {
    display: none;
  }
  .model-tabs {
    width: calc(100% - 36px);
    margin: 16px 18px 0;
  }
  .model-section-body {
    padding: 16px 18px 22px;
  }
  .vision-capability-note {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .vision-capability-note > .text-action {
    grid-column: 2;
    justify-self: start;
  }
  .provider-split {
    grid-template-columns: 1fr;
  }
  .provider-nav {
    flex-direction: row;
    flex-wrap: wrap;
    max-height: none;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .provider-nav-divider {
    margin: 4px 6px;
    padding-top: 0;
    border-top: 0;
  }
  .provider-detail {
    padding: 14px;
  }
}

@media (max-width: 640px) {
  .llm-usage-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .llm-usage-controls {
    width: 100%;
  }
  .llm-usage-controls select {
    flex: 1;
    width: auto;
  }
  .llm-usage-op > div:not(.llm-usage-op-head) strong {
    font-size: 15px;
  }
  .llm-usage-op {
    grid-template-columns: 1fr 1fr;
  }
  .llm-usage-row {
    grid-template-columns: minmax(0, 1fr) 52px 64px;
    gap: 8px;
  }
  .llm-usage-row > span:nth-child(3),
  .llm-usage-row > span:nth-child(5) {
    display: none;
  }
  .model-section-intro {
    align-items: flex-start;
  }
  .conn-grid {
    grid-template-columns: 1fr;
  }
  .modal-form {
    grid-template-columns: 1fr;
  }
  .field-wide {
    grid-column: auto;
  }
  .discovery-url-row {
    grid-template-columns: 1fr;
  }
  .discovery-url-row .btn {
    width: 100%;
  }
}
</style>
