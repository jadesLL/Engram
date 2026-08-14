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
                <strong>当前会话</strong>
                <span>退出后需要重新输入密码。</span>
              </div>
              <button class="btn danger" type="button" @click="logout">退出登录</button>
            </div>

            <div class="setting-row">
              <div class="setting-copy">
                <strong>应用版本</strong>
                <span>当前安装的 ExampleProject 版本。</span>
              </div>
              <code class="app-version">{{ APP_VERSION }}</code>
            </div>
          </div>
        </section>

        <section v-show="activeSettingsSection === 'models'" class="settings-panel model-workspace">
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
                    : '等待新调用产生计量数据' }}
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
                  title="刷新模型用量"
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
              <div class="llm-usage-metrics">
                <div>
                  <span>缓存命中率</span>
                  <strong>{{ formatUsageRate(llmUsage.cacheHitRate) }}</strong>
                  <small>
                    {{ llmUsage.cacheRequests }}/{{ llmUsage.requests }} 次返回缓存计量
                    <template v-if="llmUsage.resultCacheHits"> · {{ llmUsage.resultCacheHits }} 次结果复用</template>
                  </small>
                </div>
                <div>
                  <span>缓存读取</span>
                  <strong>{{ formatTokenCount(llmUsage.cacheReadTokens) }}</strong>
                  <small>
                    未命中 {{ formatTokenCount(llmUsage.cacheMissTokens) }}
                    <template v-if="llmUsage.promptAmplification !== null">
                      · 放大 {{ formatUsageMultiplier(llmUsage.promptAmplification) }}
                    </template>
                  </small>
                </div>
                <div>
                  <span>输入 Token</span>
                  <strong>{{ formatTokenCount(llmUsage.promptTokens) }}</strong>
                  <small>含命中与未命中部分</small>
                </div>
                <div>
                  <span>输出 Token</span>
                  <strong>{{ formatTokenCount(llmUsage.completionTokens) }}</strong>
                  <small>
                    总计 {{ formatTokenCount(llmUsage.totalTokens) }}
                    <template v-if="llmUsage.retryRequests"> · 重试 {{ llmUsage.retryRequests }}</template>
                  </small>
                </div>
              </div>

              <div v-if="llmUsage.breakdown.length" class="llm-usage-breakdown">
                <div class="llm-usage-row llm-usage-row-head" aria-hidden="true">
                  <span>调用阶段</span>
                  <span>模型</span>
                  <span>输入</span>
                  <span>缓存命中</span>
                </div>
                <div
                  v-for="item in llmUsage.breakdown.slice(0, 6)"
                  :key="`${item.provider}-${item.model}-${item.tag}`"
                  class="llm-usage-row"
                >
                  <span>
                    <strong>{{ usageTagLabel(item.tag) }}</strong>
                    <small>
                      {{ item.requests }} 次
                      <template v-if="item.runs"> · {{ item.runs }} 个任务</template>
                      <template v-if="item.continuedRequests"> · {{ item.continuedRequests }} 次延续</template>
                      <template v-if="item.resultCacheHits"> · {{ item.resultCacheHits }} 次结果复用</template>
                    </small>
                  </span>
                  <span :title="`${item.provider} · ${item.model}`">{{ item.model }}</span>
                  <span>{{ formatTokenCount(item.promptTokens) }}</span>
                  <span>{{ formatUsageRate(item.cacheHitRate) }}</span>
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

              <div class="provider-list">
                <section
                  v-for="card in section.cards"
                  :key="`${section.kind}-${card.provider.id}`"
                  class="provider-row"
                  :class="{ active: card.entries.some((entry) => entry.id === section.activeId) }"
                >
                  <div class="provider-row-head">
                    <div class="provider-identity">
                      <div class="provider-mark" :class="{ 'has-logo': Boolean(card.provider.logo) }">
                        <span>{{ providerMark(card.provider.name) }}</span>
                        <img
                          v-if="card.provider.logo"
                          :src="card.provider.logo"
                          :alt="`${card.provider.name} Logo`"
                          @error="hideProviderLogo"
                        />
                      </div>
                      <div class="provider-title">
                        <strong>{{ card.provider.name }}</strong>
                        <span>{{ card.entries.length ? `${card.entries.length} 个配置` : '尚未配置' }}</span>
                      </div>
                    </div>
                    <button
                      class="provider-add-btn"
                      type="button"
                      @click="openForm(section.kind, undefined, card.provider.id)"
                    >
                      <Icon name="plus" :size="13" />
                      添加
                    </button>
                  </div>

                  <div class="model-chip-list">
                    <div
                      v-for="entry in card.entries"
                      :key="entry.id"
                      class="model-config-chip"
                      :class="{ active: entry.id === section.activeId }"
                    >
                      <button
                        class="model-chip-select"
                        type="button"
                        :title="entry.id === section.activeId ? '当前使用的模型' : '设为当前模型'"
                        @click="entry.id !== section.activeId && selectModel(section.kind, entry.id)"
                      >
                        <Icon v-if="entry.id === section.activeId" name="check" :size="12" class="model-chip-check" />
                        <span v-else class="model-chip-dot"></span>
                        <span class="model-chip-copy">
                          <strong>{{ entry.model }}</strong>
                        </span>
                        <span v-if="entry.id === section.activeId" class="model-chip-current">当前</span>
                      </button>
                      <div class="model-chip-actions">
                        <button
                          type="button"
                          title="测试连接"
                          :disabled="testingId === entry.id"
                          @click="testOne(section.kind, entry)"
                        >
                          <Icon name="activity" :size="13" />
                        </button>
                        <button type="button" title="编辑配置" @click="openForm(section.kind, entry)">
                          编辑
                        </button>
                        <button class="danger" type="button" title="删除配置" @click="removeModel(section.kind, entry.id)">
                          <Icon name="x" :size="13" />
                        </button>
                      </div>
                    </div>

                    <button
                      v-if="!card.entries.length"
                      class="empty-model-chip"
                      type="button"
                      @click="openForm(section.kind, undefined, card.provider.id)"
                    >
                      <Icon name="plus" :size="14" />
                      配置第一个模型
                    </button>
                  </div>

                </section>
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
                    <div
                      class="provider-mark"
                      :class="{ 'has-logo': Boolean(model.logo || providerLogo(model.provider)) }"
                    >
                      <span>{{ providerMark(providerName(model.provider)) }}</span>
                      <img
                        v-if="model.logo || providerLogo(model.provider)"
                        :src="model.logo || providerLogo(model.provider)"
                        :alt="`${providerName(model.provider)} Logo`"
                        @error="hideProviderLogo"
                      />
                    </div>
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

        <section v-if="activeSettingsSection === 'history'" class="settings-panel refinement-history-panel">
          <RefinementHistoryPanel />
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
                <span>选择运行周期与时间，默认每天 03:00。</span>
              </div>
              <div class="schedule-controls">
                <select
                  v-model="dreamScheduleFrequency"
                  class="schedule-select"
                  aria-label="Dream Cycle 运行周期"
                  @change="applyDreamSchedule"
                >
                  <option v-for="option in dreamScheduleOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
                <select
                  v-if="dreamScheduleFrequency !== 'custom'"
                  v-model="dreamScheduleTime"
                  class="schedule-select schedule-time-select"
                  aria-label="Dream Cycle 运行时间"
                  @change="applyDreamSchedule"
                >
                  <option v-for="option in dreamTimeOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
                <input
                  v-else
                  v-model="dreamCron"
                  class="cron-input"
                  aria-label="Dream Cycle 自定义 cron 表达式"
                  @change="saveDream"
                />
              </div>
            </div>
          </div>

          <div class="settings-group">
            <div class="setting-row">
              <div class="setting-copy">
                <strong>客户梳理模式</strong>
                <span>开启信捷模式后，标记为「客户」的实体页面在整页综合时按 ACS「助力客户成功」框架组织（五看洞察 / 决策链 / 三层关系 / 行动计划 / 缺失资料）。在侧边栏给实体页加上「客户」标签即视为客户。切换不触发批量重综合，模式在下次整理客户页面时生效。</span>
              </div>
              <div class="segmented-control" role="group" aria-label="客户梳理模式">
                <button type="button" class="segmented-btn" :class="{ active: acsMode === 'standard' }" @click="setAcsMode('standard')">标准模式</button>
                <button type="button" class="segmented-btn" :class="{ active: acsMode === 'acs' }" @click="setAcsMode('acs')">信捷模式</button>
              </div>
            </div>
            <p v-if="acsModeMsg" class="setting-message">{{ acsModeMsg }}</p>
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
                <p>清空 AIWorks/log、操作日志和关系库；待执行和运行中的 AI 任务会先停止，概念、实体和原始资料不受影响。</p>
              </div>
              <button
                class="btn danger"
                type="button"
                :disabled="Boolean(wipeBusy)"
                @click="wipeAiLogs"
              >
                {{ wipeBusy === 'ai-logs' ? '清空中...' : '清空日志' }}
              </button>
            </div>
            <div class="danger-row">
              <div>
                <strong>一键清除知识数据</strong>
                <p>先停止待执行和运行中的 AI 任务，再删除全部概念、实体、原始资料、归档和查询页面，并清空整理报告、入库记录与索引。</p>
              </div>
              <button
                class="btn danger solid"
                type="button"
                :disabled="Boolean(wipeBusy)"
                @click="wipe"
              >
                {{ wipeBusy === 'knowledge' ? '清除中...' : '一键清除' }}
              </button>
            </div>
          </div>
          <p v-if="wipeMsg" class="setting-message" :class="wipeOk ? 'ok' : 'err'">{{ wipeMsg }}</p>
        </section>
      </div>
    </div>

    <transition name="connection-toast">
      <div
        v-if="connectionNotice.show"
        class="connection-toast"
        :class="connectionNotice.ok ? 'success' : 'failure'"
        role="status"
        aria-live="polite"
      >
        <span class="connection-toast-icon">
          <Icon :name="connectionNotice.ok ? 'check' : 'x'" :size="16" />
        </span>
        <div class="connection-toast-copy">
          <strong>{{ connectionNotice.title }}</strong>
          <p>{{ connectionNotice.message }}</p>
        </div>
        <button type="button" title="关闭提示" @click="connectionNotice.show = false">
          <Icon name="x" :size="14" />
        </button>
      </div>
    </transition>

    <div v-if="form.show" class="modal-mask">
      <div
        class="model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-dialog-title"
      >
        <div class="dialog-head">
          <div>
            <span>{{ modelKindLabel(form.kind) }}</span>
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
            <div
              v-if="form.provider === 'custom' || !providerById(form.provider)"
              class="field field-wide"
            >
              <label>服务商 Logo</label>
              <div class="custom-logo-control">
                <span class="custom-logo-preview">
                  <img v-if="form.logo" :src="form.logo" alt="自定义服务商 Logo 预览" />
                  <Icon v-else name="image" :size="18" />
                </span>
                <button class="btn" type="button" @click="providerLogoInput?.click()">
                  {{ form.logo ? '更换图片' : '上传图片' }}
                </button>
                <button v-if="form.logo" class="text-action danger" type="button" @click="form.logo = ''">移除</button>
                <input
                  ref="providerLogoInput"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  hidden
                  @change="onProviderLogoUpload"
                />
              </div>
              <span class="field-help">支持 PNG、JPG、WebP 或 SVG，保存前会压缩为 96 × 96。</span>
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
            <div v-if="form.modelChoice === '__custom__'" class="field field-wide">
              <label for="custom-model-name">自定义模型名称</label>
              <input id="custom-model-name" v-model="form.model" placeholder="完整模型 ID 或 ep- 接入点" />
            </div>
            <div class="field field-wide">
              <label for="model-base-url">Base URL</label>
              <input id="model-base-url" v-model="form.baseUrl" placeholder="https://.../v1" @change="onFormBaseUrlChange" />
            </div>
            <div class="field field-wide">
              <label>模型目录</label>
              <div class="discovery-url-row">
                <span class="field-help">使用当前线路的官方地址自动获取，无需填写 API 地址。</span>
                <button class="btn" type="button" :disabled="discoveryBusy || !effectiveFormApiKey" @click="discoverFormModels()">
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
                {{ apiKeyRevealed ? '点击其他位置后重新隐藏；可直接编辑替换 Key。' : '中间字符已隐藏，点击输入框查看完整 Key。' }}
              </span>
              <span v-else-if="form.id" class="field-help">请为当前服务商和线路输入 API Key。</span>
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
          <p
            class="setting-message discovery-message"
            :class="currentFormModelUnavailable ? 'warn' : discoveryOk ? 'ok' : 'err'"
            :title="discoveryMessage"
          >{{ discoveryMessage || ' ' }}</p>
          <p v-if="formError" class="setting-message err">{{ formError }}</p>
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
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon.vue';
import RefinementHistoryPanel from '../components/RefinementHistoryPanel.vue';
import {
  PROVIDERS,
  modelById,
  providerById,
  type ApiLine,
  type ImageInputStatus,
  type ModelOption,
  type ProviderPreset,
} from '../presets';
import { APP_VERSION } from '../version';

type ModelKind = 'chat' | 'emb' | 'document';
type SettingsSection = 'account' | 'models' | 'history' | 'automation' | 'mcp' | 'storage' | 'data';
type DraftField = 'model' | 'baseUrl' | 'modelsUrl' | 'apiKey' | 'dim';
type DreamScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  line?: string;
  baseUrl: string;
  modelsUrl?: string;
  logo?: string;
  model: string;
  apiKey: string;
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
  logo: string;
  model: string;
  modelChoice: string;
  apiKey: string;
  dim: number;
}

interface ProviderCard {
  provider: ProviderPreset;
  entries: ModelEntry[];
}

type FormModelOption = ModelOption & {
  unavailable?: boolean;
};

interface TrashEntry {
  id: string;
  kind: 'page' | 'file';
  name: string;
  originalPath: string;
  deletedAt: string;
  size: number;
  legacy: boolean;
}

interface LlmUsageBreakdown {
  provider: string;
  model: string;
  operation: string;
  tag: string;
  requests: number;
  runs: number;
  continuedRequests: number;
  maxHistoryMessages: number;
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
  latestAt: string | null;
  breakdown: LlmUsageBreakdown[];
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
    latestAt: null,
    breakdown: [],
  };
}

const app = useAppStore();
const auth = useAuthStore();

const activeSettingsSection = ref<SettingsSection>('account');
const activeModelKind = ref<ModelKind>('chat');
const settingsNavigation: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'account', label: '账户与外观', icon: 'settings' },
  { id: 'models', label: '模型配置', icon: 'ai' },
  { id: 'history', label: '提炼轨迹', icon: 'list-tree' },
  { id: 'automation', label: '自动化', icon: 'activity' },
  { id: 'mcp', label: 'MCP 集成', icon: 'link' },
  { id: 'storage', label: '存储空间', icon: 'archive' },
  { id: 'data', label: '数据管理', icon: 'trash' },
];

const chatModels = ref<ModelEntry[]>([]);
const embModels = ref<ModelEntry[]>([]);
const documentModels = ref<ModelEntry[]>([]);
const activeChat = ref('');
const activeEmb = ref('');
const activeDocument = ref('');
const llmUsageDays = ref(7);
const llmUsage = ref<LlmUsageSummary>(emptyLlmUsage());
const llmUsageLoading = ref(false);
const llmUsageClearing = ref(false);
const llmUsageError = ref('');
const llmUsageNotice = ref('');
const imageCapabilityChecking = ref(false);
const imageCapabilityDetail = ref('');
const checkedImageCapabilityIds = new Set<string>();
let imageCapabilityRequestId = 0;

function modelsRef(kind: ModelKind) {
  if (kind === 'chat') return chatModels;
  if (kind === 'emb') return embModels;
  return documentModels;
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

function providerMark(name: string): string {
  const compact = name.trim().replace(/\s+/g, '');
  return compact.slice(0, 2).toUpperCase() || 'AI';
}

function providerLogo(id: string): string {
  return providerById(id)?.logo || '';
}

function hideProviderLogo(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  const fallback = image.previousElementSibling as HTMLElement | null;
  image.style.display = 'none';
  if (fallback) fallback.style.visibility = 'visible';
  image.parentElement?.classList.remove('has-logo');
}

const testingId = ref('');
const testingAll = ref(false);
const connectionNotice = reactive({
  show: false,
  ok: true,
  title: '',
  message: '',
});
let connectionNoticeTimer: ReturnType<typeof setTimeout> | undefined;

function showConnectionNotice(ok: boolean, title: string, message: string) {
  if (connectionNoticeTimer) clearTimeout(connectionNoticeTimer);
  Object.assign(connectionNotice, { show: true, ok, title, message });
  connectionNoticeTimer = setTimeout(() => {
    connectionNotice.show = false;
  }, ok ? 3200 : 5200);
}

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
const dreamScheduleFrequency = ref<DreamScheduleFrequency>('daily');
const dreamScheduleTime = ref('03:00');
const acsMode = ref<'standard' | 'acs'>('standard');
const acsModeMsg = ref('');
const dreamScheduleOptions: Array<{ value: DreamScheduleFrequency; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周一' },
  { value: 'monthly', label: '每月 1 日' },
  { value: 'custom', label: '自定义' },
];
const defaultDreamTimeOptions = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? 0 : 30;
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { value, label: value };
});
const dreamTimeOptions = computed(() => {
  if (defaultDreamTimeOptions.some((option) => option.value === dreamScheduleTime.value)) {
    return defaultDreamTimeOptions;
  }
  return [...defaultDreamTimeOptions, { value: dreamScheduleTime.value, label: dreamScheduleTime.value }]
    .sort((a, b) => a.value.localeCompare(b.value));
});
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
  modelsUrl: '',
  logo: '',
  model: '',
  modelChoice: '__custom__',
  apiKey: '',
  dim: 1024,
});
const providerLogoInput = ref<HTMLInputElement>();
const apiKeyInput = ref<HTMLInputElement>();
const apiKeyRevealed = ref(false);
const formTesting = ref(false);
const formSaving = ref(false);
const formError = ref('');
const discoveredModels = ref<ModelOption[]>([]);
const modelDiscoveryCompleted = ref(false);
const discoveryBusy = ref(false);
const discoveryMessage = ref('');
const discoveryOk = ref(false);
let modelDiscoveryRequestId = 0;

const fixedChatProviders = computed(() => PROVIDERS.filter((provider) => provider.id !== 'custom'));
const fixedEmbeddingProviders = computed(() =>
  PROVIDERS.filter((provider) => provider.id !== 'custom' && provider.embeddingModels.length > 0)
);
const fixedDocumentProviders = computed(() =>
  PROVIDERS.filter((provider) => provider.id !== 'custom' && (provider.documentModels?.length || 0) > 0)
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
  return list.filter((model) => model.provider !== 'stepfun' && !fixedIds.has(model.provider));
}

const modelSections = computed(() => [
  {
    kind: 'chat' as const,
    title: '对话模型',
    copy: '同一厂商可以并列配置多个模型，点击其中一个即可切换使用。',
    cards: cardsFor('chat'),
    unknown: unknownModels('chat'),
    activeId: activeChat.value,
  },
  {
    kind: 'emb' as const,
    title: '向量模型（语义检索）',
    copy: '只显示提供文本向量模型的厂商。切换模型或维度后会自动重建索引。',
    cards: cardsFor('emb'),
    unknown: unknownModels('emb'),
    activeId: activeEmb.value,
  },
  {
    kind: 'document' as const,
    title: '视觉模型',
    copy: '专用视觉模型是可选覆盖项，仅处理图片和 PDF 中没有足够内嵌文字的页面。',
    cards: cardsFor('document'),
    unknown: unknownModels('document'),
    activeId: activeDocument.value,
  },
]);

const providerOptions = computed(() =>
  form.value.kind === 'emb'
    ? PROVIDERS.filter((provider) => provider.embeddingModels.length > 0 || provider.id === 'custom')
    : form.value.kind === 'document'
      ? PROVIDERS.filter((provider) => (provider.documentModels?.length || 0) > 0 || provider.id === 'custom')
      : PROVIDERS
);

const customPreset = providerById('custom')!;
const currentFormProvider = computed<ProviderPreset>(() => {
  const preset = providerById(form.value.provider);
  if (preset) return preset;
  return { ...customPreset, id: form.value.provider, name: providerName(form.value.provider) };
});
const existingFormEntry = computed(() => {
  if (!form.value.id) return undefined;
  const list = modelsRef(form.value.kind).value;
  return list.find((model) => model.id === form.value.id);
});
const formModelOptions = computed<FormModelOption[]>(() => {
  const options = new Map<string, FormModelOption>();
  for (const model of discoveredModels.value) options.set(model.id, model);

  const current = modelValue(form.value);
  const existing = existingFormEntry.value;
  if (existing && current === existing.model && !options.has(current)) {
    const preset = modelById(
      currentFormProvider.value.id,
      current,
      form.value.kind === 'chat' ? 'chat' : form.value.kind === 'emb' ? 'embedding' : 'document',
    );
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
const reusableExistingApiKey = computed(() => {
  const existing = existingFormEntry.value;
  return existing?.provider === form.value.provider
    && normalizeUrl(existing.baseUrl) === normalizeUrl(form.value.baseUrl)
    ? existing.apiKey
    : '';
});
const effectiveFormApiKey = computed(() =>
  form.value.apiKey.trim() || reusableExistingApiKey.value
);
const formApiKeyDisplayValue = computed(() => {
  const key = effectiveFormApiKey.value;
  return apiKeyRevealed.value ? key : maskKey(key);
});

function blankDraft(): ModelDraft {
  return { line: '', baseUrl: '', modelsUrl: '', logo: '', model: '', modelChoice: '__custom__', apiKey: '', dim: 1024 };
}

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
    logo: existing?.logo || '',
    model: existing?.model || '',
    modelChoice: existing?.model || '',
    apiKey: '',
    dim: existing?.dim || existingOption?.dim || 1024,
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
  if (line) draft.modelsUrl = line.modelsUrl || inferredModelsUrl(line.baseUrl);
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
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
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
    ...(draft.logo ? { logo: draft.logo } : {}),
    model,
    apiKey: draft.apiKey.trim()
      || (
        existing?.provider === provider.id
        && normalizeUrl(existing.baseUrl) === normalizeUrl(draft.baseUrl)
          ? existing.apiKey
          : ''
      ),
    ...(kind === 'emb' ? { dim: draft.dim || option?.dim || 1024, supportsDimensions } : {}),
    ...(imageInput ? { imageInput, imageInputSource } : {}),
    ...(sameEndpoint && existing?.imageInputCheckedAt
      ? { imageInputCheckedAt: existing.imageInputCheckedAt }
      : {}),
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
  const listRef = modelsRef(kind);
  const previousList = [...listRef.value];
  const previousActive = activeIdFor(kind);
  try {
    const entry = entryFromDraft(kind, provider, draft);
    listRef.value.push(entry);
    if (!activeIdFor(kind)) setActiveId(kind, entry.id);
    await persist();
    delete quickDrafts[key];
    if (kind === 'chat' && activeChat.value === entry.id) {
      checkedImageCapabilityIds.delete(entry.id);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    listRef.value = previousList;
    setActiveId(kind, previousActive);
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
  const list = modelsRef(kind);
  const index = list.value.findIndex((model) => model.id === existing.id);
  const previous = index >= 0 ? { ...list.value[index] } : undefined;
  try {
    const entry = entryFromDraft(kind, provider, inlineDraft, existing);
    if (index < 0) throw new Error('找不到要编辑的配置。');
    list.value[index] = entry;
    await persist();
    closeInlineEdit();
    if (kind === 'chat' && entry.id === activeChat.value) {
      checkedImageCapabilityIds.delete(entry.id);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    if (index >= 0 && previous) list.value[index] = previous;
    inlineError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    inlineSaving.value = false;
  }
}

function openForm(kind: ModelKind, existing?: ModelEntry, providerId?: string) {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
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
    queueMicrotask(() => void discoverFormModels(existing.apiKey));
  }
}

function pickProvider(id: string) {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  const provider = providerById(id) || customPreset;
  const hasGeneratedName = !form.value.name || PROVIDERS.some((item) => item.name === form.value.name);
  const draft = createDraft(form.value.kind, provider);
  form.value.line = draft.line;
  form.value.baseUrl = draft.baseUrl;
  form.value.modelsUrl = draft.modelsUrl;
  form.value.logo = draft.logo;
  form.value.model = draft.model;
  form.value.modelChoice = draft.modelChoice;
  form.value.apiKey = '';
  form.value.dim = draft.dim;
  if (hasGeneratedName) form.value.name = provider.name;
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
}

function onFormLineChange() {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  applyLineToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.line);
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

function onFormCredentialsInput() {
  resetFormModelDiscovery(true);
}

function revealFormApiKey() {
  if (!effectiveFormApiKey.value) return;
  apiKeyRevealed.value = true;
  void nextTick(() => {
    const input = apiKeyInput.value;
    if (!input) return;
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function onFormApiKeyInput(event: Event) {
  const value = (event.currentTarget as HTMLInputElement).value;
  form.value.apiKey = value === reusableExistingApiKey.value ? '' : value;
  apiKeyRevealed.value = true;
  onFormCredentialsInput();
}

function onFormApiKeyBlur() {
  apiKeyRevealed.value = false;
  void discoverFormModels();
}

function modelOptionLabel(model: FormModelOption): string {
  return model.unavailable ? `${model.name}（当前账号未返回）` : model.name;
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

async function onProviderLogoUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    formError.value = '请选择图片文件。';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    formError.value = 'Logo 图片不能超过 2 MB。';
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片无法读取'));
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持图片处理');
    const scale = Math.min(88 / image.naturalWidth, 88 / image.naturalHeight);
    const width = Math.max(1, image.naturalWidth * scale);
    const height = Math.max(1, image.naturalHeight * scale);
    context.drawImage(image, (96 - width) / 2, (96 - height) / 2, width, height);
    form.value.logo = canvas.toDataURL('image/png');
    formError.value = '';
  } catch (error: any) {
    formError.value = error?.message || 'Logo 处理失败。';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function onFormBaseUrlChange() {
  apiKeyRevealed.value = false;
  resetFormModelDiscovery(true);
  form.value.modelsUrl = inferredModelsUrl(form.value.baseUrl);
  if (form.value.apiKey.trim()) void discoverFormModels();
}

async function discoverFormModels(apiKeyOverride?: string) {
  const requestId = ++modelDiscoveryRequestId;
  const apiKey = apiKeyOverride || effectiveFormApiKey.value;
  if (!apiKey) {
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
  discoveryBusy.value = true;
  discoveryMessage.value = '';
  try {
    const { data } = await api.post('/api/settings/discover-models', {
      baseUrl: form.value.baseUrl,
      apiKey,
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
  await api.put('/api/settings', {
    chat_models: JSON.stringify(chatModels.value),
    active_chat_model: activeChat.value,
    embedding_models: JSON.stringify(embModels.value),
    active_embedding_model: activeEmb.value,
    document_models: JSON.stringify(documentModels.value),
    active_document_model: activeDocument.value,
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

async function saveModel() {
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
    if (index >= 0) list.value[index] = entry;
    else list.value.push(entry);
    if (!activeIdFor(kind)) setActiveId(kind, entry.id);
    await persist();
    form.value.show = false;
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
    showConnectionNotice(false, '切换失败', errorMessage(error, '启用失败，请重试。'));
  }
}

async function removeModel(kind: ModelKind, id: string) {
  if (!confirm('删除该模型配置？')) return;
  const listRef = modelsRef(kind);
  const previousList = [...listRef.value];
  const previousActive = activeIdFor(kind);
  try {
    listRef.value = listRef.value.filter((model) => model.id !== id);
    if (activeIdFor(kind) === id) setActiveId(kind, listRef.value[0]?.id || '');
    await persist();
    if (editingId.value === id) closeInlineEdit();
    if (kind === 'chat' && previousActive === id) {
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    listRef.value = previousList;
    setActiveId(kind, previousActive);
    showConnectionNotice(false, '删除失败', errorMessage(error, '删除失败，请重试。'));
  }
}

async function testOne(kind: ModelKind, model: ModelEntry) {
  if (!model.apiKey) return;
  testingId.value = model.id;
  try {
    const { data } = await api.post('/api/settings/test-llm', {
      entry: model,
      kind: kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document',
    });
    showConnectionNotice(
      Boolean(data.ok),
      data.ok ? '连接成功' : '连接失败',
      data.ok ? `${providerName(model.provider)} · ${model.model}` : (data.error || '模型连接测试失败。')
    );
  } catch (error: any) {
    showConnectionNotice(false, '连接失败', errorMessage(error, '连接测试失败。'));
  } finally {
    testingId.value = '';
  }
}

async function testForm() {
  formError.value = '';
  const existing = existingFormEntry.value;
  const effectiveKey = effectiveFormApiKey.value;
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
    showConnectionNotice(
      Boolean(data.ok),
      data.ok ? '连接成功' : '连接失败',
      data.ok ? `${currentFormProvider.value.name} · ${entry.model}` : (data.error || '模型连接测试失败。')
    );
  } catch (error: any) {
    showConnectionNotice(false, '连接失败', errorMessage(error, '连接测试失败。'));
  } finally {
    formTesting.value = false;
  }
}

async function testAll() {
  testingAll.value = true;
  try {
    const { data } = await api.post('/api/settings/test-llm');
    const documentRequired = Boolean(activeModelFor('document'));
    const ok = Boolean(data.chat && data.embedding && (!documentRequired || data.document));
    showConnectionNotice(
      ok,
      ok ? '全部连接正常' : '连接测试失败',
      ok
        ? documentRequired
          ? '对话、向量与视觉模型均连接成功。'
          : '对话模型与向量模型均连接成功。'
        : (data.error || (data.chat ? '向量或视觉模型连接失败。' : '对话模型连接失败。'))
    );
  } catch (error: any) {
    showConnectionNotice(false, '连接测试失败', errorMessage(error, '连接测试失败。'));
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
  showConnectionNotice(true, '索引重建已开始', '任务正在后台运行。');
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

async function setAcsMode(mode: 'standard' | 'acs') {
  if (acsMode.value === mode) return;
  const prev = acsMode.value;
  acsMode.value = mode;
  acsModeMsg.value = '';
  try {
    const { data } = await api.put('/api/settings', { acs_mode: mode });
    if (data?.acsModeChanged) {
      acsModeMsg.value = `已切换为${mode === 'acs' ? '信捷' : '标准'}模式，下次整理客户页面时生效`;
    }
  } catch {
    acsMode.value = prev;
    acsModeMsg.value = '保存失败，已还原';
  }
}

function dreamCronFor(frequency: Exclude<DreamScheduleFrequency, 'custom'>, time: string): string {
  const [hour = '3', minute = '0'] = time.split(':');
  const clock = `${Number(minute)} ${Number(hour)}`;
  if (frequency === 'weekdays') return `${clock} * * 1-5`;
  if (frequency === 'weekly') return `${clock} * * 1`;
  if (frequency === 'monthly') return `${clock} 1 * *`;
  return `${clock} * * *`;
}

function parseDreamSchedule(cron: string): { frequency: DreamScheduleFrequency; time: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: 'custom', time: '03:00' };
  const [minute, hour, day, month, weekday] = parts;
  const minuteValue = Number(minute);
  const hourValue = Number(hour);
  const hasFixedTime = Number.isInteger(minuteValue)
    && minuteValue >= 0
    && minuteValue < 60
    && Number.isInteger(hourValue)
    && hourValue >= 0
    && hourValue < 24;
  if (!hasFixedTime || month !== '*') return { frequency: 'custom', time: '03:00' };

  const time = `${String(hourValue).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}`;
  if (day === '*' && weekday === '*') return { frequency: 'daily', time };
  if (day === '*' && weekday === '1-5') return { frequency: 'weekdays', time };
  if (day === '*' && weekday === '1') return { frequency: 'weekly', time };
  if (day === '1' && weekday === '*') return { frequency: 'monthly', time };
  return { frequency: 'custom', time };
}

async function applyDreamSchedule() {
  if (dreamScheduleFrequency.value === 'custom') return;
  dreamCron.value = dreamCronFor(dreamScheduleFrequency.value, dreamScheduleTime.value);
  await saveDream();
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

const LLM_USAGE_TAG_LABELS: Record<string, string> = {
  'ingest-map': '入库 Map',
  'ingest-normalize': '入库 Normalize',
  'ingest-plan': '入库 Plan',
  'ingest-critic': '入库 Critic',
  'ingest-critic-review': '入库 Critic 复核',
  'ingest-compose': '入库 Compose',
  'ingest-questions': '入库追问',
  'ingest-verify': '入库 Verify',
  'ingest-pipeline-cache': '入库结果复用',
  'entity-identity': '实体身份判断',
  entities: '页面实体抽取',
  'page-synthesis-compose': '页面综合 Compose',
  'page-synthesis-verify': '页面综合 Verify',
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
const wipeBusy = ref<'' | 'knowledge' | 'ai-logs'>('');

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
  const password = await confirmWithPassword('清除全部知识数据、整理报告和入库记录');
  if (!password) return;
  wipeBusy.value = 'knowledge';
  try {
    const { data } = await api.post('/api/settings/wipe', { password });
    wipeOk.value = true;
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个 AI 任务` : '';
    wipeMsg.value = `已清除 ${data.fileCount} 个文件、${data.reportCount} 条整理报告${stopped}，索引已重置。`;
    app.openReportCount = 0;
    await app.refreshJobs();
    app.bumpSidebar();
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清除失败';
  } finally {
    wipeBusy.value = '';
  }
}

async function wipeAiLogs() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清空 AI 整理日志、操作日志和关系库');
  if (!password) return;
  wipeBusy.value = 'ai-logs';
  try {
    const { data } = await api.post('/api/settings/wipe-ai-logs', { password });
    wipeOk.value = true;
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个 AI 任务` : '';
    wipeMsg.value = `已清空 ${data.fileCount} 个 AI 整理日志文件，重置 ${data.relationCount} 条关系记录${stopped}。`;
    app.bumpSidebar();
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清空失败';
  } finally {
    wipeBusy.value = '';
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
  if (!confirm('确定清除全部模型用量统计吗？此操作不会删除模型配置、知识内容或供应商侧缓存。')) return;
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

async function load() {
  const [{ data: settingsData }, { data: tokenData }, { data: dreamData }] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/settings/mcp-tokens'),
    api.get('/api/dream/reports?status=open'),
  ]);
  chatModels.value = parseEntries(settingsData.settings.chat_models);
  embModels.value = parseEntries(settingsData.settings.embedding_models);
  documentModels.value = parseEntries(settingsData.settings.document_models);
  activeChat.value = settingsData.settings.active_chat_model || chatModels.value[0]?.id || '';
  activeEmb.value = settingsData.settings.active_embedding_model || embModels.value[0]?.id || '';
  activeDocument.value = settingsData.settings.active_document_model || documentModels.value[0]?.id || '';
  mcpTokens.value = tokenData.tokens;
  dreamEnabled.value = dreamData.enabled;
  dreamCron.value = dreamData.cron || '0 3 * * *';
  const schedule = parseDreamSchedule(dreamCron.value);
  dreamScheduleFrequency.value = schedule.frequency;
  dreamScheduleTime.value = schedule.time;
  acsMode.value = settingsData.settings.acs_mode === 'acs' ? 'acs' : 'standard';
}

watch(
  () => [activeModelKind.value, activeChat.value] as const,
  ([kind]) => {
    if (kind === 'document') void refreshActiveChatImageCapability();
  },
);

onMounted(async () => {
  await load();
  void loadLlmUsage();
  void loadTrash();
  if (activeModelKind.value === 'document') void refreshActiveChatImageCapability();
});

onUnmounted(() => {
  if (connectionNoticeTimer) clearTimeout(connectionNoticeTimer);
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
  z-index: var(--z-overlay);
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
.provider-row {
  grid-template-columns: 190px minmax(0, 1fr);
}

.provider-row .provider-title strong {
  max-width: none;
  overflow: visible;
  text-overflow: clip;
  white-space: nowrap;
}

.provider-row .provider-mark,
.custom-model-row .provider-mark {
  overflow: visible;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.provider-row .provider-mark img,
.custom-model-row .provider-mark img {
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 7px;
  background: transparent;
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.5),
    0 2px 5px rgba(0, 0, 0, 0.14);
}

:global(html.dark) .provider-row .provider-mark img,
:global(html.dark) .custom-model-row .provider-mark img {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.34),
    0 2px 6px rgba(0, 0, 0, 0.42);
}

.model-config-chip.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 28%, transparent);
}

.model-config-chip.active .model-chip-copy strong,
.model-config-chip.active .model-chip-check {
  color: #fff;
}

.model-config-chip.active .model-chip-actions {
  border-left-color: rgba(255, 255, 255, 0.28);
}

.model-config-chip.active .model-chip-actions button {
  color: rgba(255, 255, 255, 0.82);
}

.model-config-chip.active .model-chip-actions button:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

.model-chip-current {
  margin-left: 3px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 8px;
  font-weight: 700;
}

.connection-toast {
  position: fixed;
  top: 18px;
  right: 22px;
  z-index: var(--z-toast);
  width: min(360px, calc(100vw - 28px));
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 13px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(14px);
}

.connection-toast.success {
  border-left: 3px solid var(--success);
}

.connection-toast.failure {
  border-left: 3px solid var(--danger);
}

.connection-toast-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
}

.connection-toast.success .connection-toast-icon {
  background: color-mix(in srgb, var(--success) 14%, var(--bg));
  color: var(--success);
}

.connection-toast.failure .connection-toast-icon {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg));
  color: var(--danger);
}

.connection-toast-copy {
  min-width: 0;
}

.connection-toast-copy strong {
  display: block;
  font-size: 13px;
}

.connection-toast-copy p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.connection-toast > button {
  display: inline-flex;
  padding: 3px;
  color: var(--text-faint);
}

.connection-toast-enter-active,
.connection-toast-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.connection-toast-enter-from,
.connection-toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.custom-logo-control {
  display: flex;
  align-items: center;
  gap: 9px;
}

.custom-logo-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 8px;
  color: var(--text-faint);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.42),
    0 2px 6px rgba(0, 0, 0, 0.12);
}

.custom-logo-preview img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: contain;
}

:global(html.dark) .custom-logo-preview {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.32),
    0 2px 6px rgba(0, 0, 0, 0.38);
}

@media (max-width: 760px) {
  .provider-row {
    grid-template-columns: 1fr;
  }

  .connection-toast {
    top: 12px;
    right: 14px;
    left: 14px;
    width: auto;
  }
}

@media (max-width: 520px) {
  .custom-logo-control {
    align-items: stretch;
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .connection-toast-enter-active,
  .connection-toast-leave-active {
    transition: none;
  }
}
</style>

<style scoped>
.current-model-line {
  display: block;
  margin-top: 4px;
  color: var(--accent);
  font-size: 11px;
}

.provider-list {
  border-top: 0;
}

.provider-row {
  position: relative;
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
  padding: 10px 2px;
  border-bottom: 0;
}

.provider-row:not(:last-child)::after {
  position: absolute;
  right: 4px;
  bottom: 0;
  left: 42px;
  height: 1px;
  background: color-mix(in srgb, var(--border) 58%, transparent);
  content: '';
  pointer-events: none;
}

.provider-row.active {
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 3%, transparent);
}

.provider-row.active::after {
  opacity: 0;
}

.provider-row-head {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
}

.provider-row .provider-identity {
  gap: 8px;
}

.provider-row .provider-mark,
.custom-model-row .provider-mark {
  position: relative;
}

.provider-row .provider-mark {
  width: 28px;
  height: 28px;
  flex-basis: 28px;
  border-radius: 7px;
  font-size: 9px;
}

.provider-row .provider-mark img,
.custom-model-row .provider-mark img {
  position: absolute;
  inset: 2px;
  width: calc(100% - 4px);
  height: calc(100% - 4px);
  border-radius: 5px;
  background: #fff;
  object-fit: contain;
}

.provider-row .provider-title strong {
  font-size: 12px;
}

.provider-row .provider-title span {
  font-size: 9px;
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

.model-chip-list {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.model-config-chip {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, auto) auto;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg);
}

.model-config-chip:hover {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border-strong));
}

.model-config-chip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.model-chip-select {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px 6px 10px;
  border-radius: 999px 0 0 999px;
  text-align: left;
}

.model-chip-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--border-strong);
}

.model-config-chip.active .model-chip-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.model-chip-copy {
  min-width: 0;
}

.model-chip-copy strong,
.model-chip-copy small {
  display: block;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chip-copy strong {
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
}

.model-chip-copy small {
  margin-top: 1px;
  color: var(--text-faint);
  font-size: 8px;
}

.model-chip-actions {
  display: flex;
  align-items: center;
  align-self: stretch;
  border-left: 1px solid var(--border);
}

.model-chip-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 27px;
  height: 100%;
  padding: 0 6px;
  border-radius: 0;
  color: var(--text-faint);
  font-size: 9px;
}

.model-chip-actions button:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.model-chip-actions button.danger:hover {
  color: var(--danger);
}

.model-chip-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.model-chip-result {
  grid-column: 1 / -1;
  margin: -1px 10px 5px;
  font-size: 9px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.empty-model-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 34px;
  padding: 6px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 10px;
}

.empty-model-chip:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.provider-row-hint {
  grid-column: 2;
  margin: -3px 0 0;
  color: var(--text-faint);
  font-size: 9px;
  line-height: 1.4;
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

.discovery-message {
  margin-top: 10px;
}

@media (max-width: 760px) {
  .provider-row {
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 11px 0;
  }

  .provider-row-head {
    padding: 0 2px;
  }

  .provider-row-hint {
    grid-column: 1;
  }
}

@media (max-width: 520px) {
  .model-chip-list {
    align-items: stretch;
    flex-direction: column;
  }

  .model-config-chip,
  .empty-model-chip {
    width: 100%;
  }

  .model-config-chip {
    grid-template-columns: minmax(0, 1fr) auto;
    border-radius: 8px;
  }

  .model-chip-select {
    border-radius: 8px 0 0 8px;
  }

  .model-chip-copy strong,
  .model-chip-copy small {
    max-width: none;
  }

  .empty-model-chip {
    justify-content: center;
    border-radius: 8px;
  }

  .discovery-url-row {
    grid-template-columns: 1fr;
  }

  .discovery-url-row .btn {
    width: 100%;
  }
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

.app-version {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
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

.llm-usage-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 16px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.llm-usage-metrics > div {
  min-width: 0;
  padding: 13px 14px;
  border-left: 1px solid var(--border);
}

.llm-usage-metrics > div:first-child {
  border-left: 0;
}

.llm-usage-metrics span,
.llm-usage-metrics strong,
.llm-usage-metrics small {
  display: block;
}

.llm-usage-metrics span {
  color: var(--text-secondary);
  font-size: 11px;
}

.llm-usage-metrics strong {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text);
  font-size: 21px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.llm-usage-metrics > div:first-child strong {
  color: var(--success);
}

.llm-usage-metrics small {
  margin-top: 5px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.llm-usage-breakdown {
  margin-top: 13px;
}

.llm-usage-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.4fr) minmax(130px, 1fr) 80px 90px;
  align-items: center;
  gap: 12px;
  min-height: 36px;
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

.llm-usage-row > span:first-child {
  display: flex;
  align-items: baseline;
  gap: 7px;
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

.workspace-message {
  padding: 10px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
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

.provider-mark.has-logo > span {
  visibility: hidden;
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

.segmented-control {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
}

.segmented-btn {
  appearance: none;
  margin: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1;
  padding: 7px 16px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.segmented-btn + .segmented-btn {
  border-left: 1px solid var(--border-strong);
}

.segmented-btn:hover {
  color: var(--text-primary);
}

.segmented-btn.active {
  background: var(--accent);
  color: #fff;
}

.segmented-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.schedule-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 270px;
}

.schedule-select {
  width: 132px;
}

.schedule-time-select {
  width: 104px;
  font-variant-numeric: tabular-nums;
}

.schedule-controls .cron-input {
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
  z-index: var(--z-overlay);
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

.warn {
  color: var(--warn);
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

  .llm-usage-band {
    padding: 16px 18px;
  }

  .llm-usage-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .llm-usage-metrics > div:nth-child(3) {
    border-left: 0;
  }

  .llm-usage-metrics > div:nth-child(n + 3) {
    border-top: 1px solid var(--border);
  }

  .llm-usage-row {
    grid-template-columns: minmax(0, 1fr) 70px 82px;
  }

  .llm-usage-row > span:nth-child(2) {
    display: none;
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
  .setting-control.wide {
    width: 100%;
  }

  .schedule-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    width: 100%;
  }

  .schedule-select,
  .schedule-controls .cron-input {
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

  .vision-capability-note {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .vision-capability-note > .text-action {
    grid-column: 2;
    justify-self: start;
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

  .llm-usage-metrics strong {
    font-size: 18px;
  }

  .llm-usage-row {
    grid-template-columns: minmax(0, 1fr) 64px 76px;
    gap: 8px;
  }

  .password-controls {
    grid-template-columns: 1fr;
  }

  .password-controls .btn {
    grid-column: auto;
    width: 100%;
  }

  .model-tabs {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .model-tabs button {
    gap: 3px;
    padding-right: 4px;
    padding-left: 4px;
  }

  .model-tabs .tab-count {
    min-width: 0;
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

<style scoped>
.provider-row {
  grid-template-columns: 190px minmax(0, 1fr);
}

.provider-row .provider-title strong {
  max-width: none;
  overflow: visible;
  text-overflow: clip;
  white-space: nowrap;
}

.provider-row .provider-mark,
.custom-model-row .provider-mark {
  overflow: visible;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.provider-row .provider-mark img,
.custom-model-row .provider-mark img {
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 7px;
  background: transparent;
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.5),
    0 2px 5px rgba(0, 0, 0, 0.14);
}

:global(html.dark) .provider-row .provider-mark img,
:global(html.dark) .custom-model-row .provider-mark img {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.34),
    0 2px 6px rgba(0, 0, 0, 0.42);
}

.model-config-chip.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 28%, transparent);
}

.model-config-chip.active .model-chip-copy strong,
.model-config-chip.active .model-chip-check {
  color: #fff;
}

.model-config-chip.active .model-chip-actions {
  border-left-color: rgba(255, 255, 255, 0.28);
}

.model-config-chip.active .model-chip-actions button {
  color: rgba(255, 255, 255, 0.82);
}

.model-config-chip.active .model-chip-actions button:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

.discovery-message {
  min-height: 17px;
  overflow: hidden;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .provider-row {
    grid-template-columns: 1fr;
  }
}
</style>
