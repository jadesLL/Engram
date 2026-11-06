<template>
  <div class="mob-inbox" ref="rootEl" :style="shellStyle">
    <!-- 选择态顶栏：取消 / 已选 N 条 / 全选（长按卡片 500ms 进入） -->
    <header v-if="selectMode" class="mi-head mi-head-select">
      <button class="mi-select-cancel" type="button" :disabled="Boolean(batchBusy)" @click="exitSelectMode">取消</button>
      <div class="mi-head-main">
        <h1 class="mi-title">已选 {{ selectedPaths.length }} 条</h1>
        <p class="mi-sub">{{ selectSubline }}</p>
      </div>
      <button
        class="mi-select-all"
        type="button"
        :disabled="!selectableItems.length || Boolean(batchBusy)"
        @click="toggleSelectAll"
      >{{ allSelected ? '取消全选' : '全选' }}</button>
    </header>
    <header v-else class="mi-head">
      <div class="mi-head-main">
        <h1 class="mi-title">{{ view === 'groups' ? '按来源分组' : '收集箱' }}</h1>
        <p class="mi-sub">{{ view === 'groups' ? groupsSubline : subline }}</p>
      </div>
      <div class="mi-head-actions">
        <button class="mi-iconbtn" type="button" aria-label="收进收集箱" @click="intakeOpen = true">
          <Icon name="plus" :size="19" />
        </button>
        <button
          class="mi-iconbtn"
          type="button"
          :disabled="inbox.loading"
          aria-label="刷新收集箱"
          @click="refresh"
        >
          <Icon name="refresh" :size="18" />
        </button>
        <button
          v-if="view === 'stack'"
          class="mi-iconbtn"
          type="button"
          aria-label="按来源分组"
          @click="view = 'groups'"
        >
          <Icon name="list-tree" :size="18" />
        </button>
        <button v-else class="mi-iconbtn" type="button" aria-label="回到卡片台" @click="view = 'stack'">
          <Icon name="chevron-left" :size="19" />
        </button>
      </div>
    </header>

    <!-- 状态分类：未入库（= 待整理 + 已转换，与桌面「待整理 · 已转换」同一口径）/ 待整理 / 已转换 / 已入库。
         四档在手机上换行铺满，不靠横向滑动藏起分类；已入库的条目不再从手机界面消失——点这一档就能回看它进了知识库的哪一篇。 -->
    <nav v-if="!selectMode" class="mi-filters" role="radiogroup" aria-label="按状态筛选">
      <button
        v-for="option in filterOptions"
        :key="option.value"
        class="mi-filter"
        type="button"
        role="radio"
        :aria-checked="filter === option.value"
        :class="{ on: filter === option.value }"
        @click="setFilter(option.value)"
      >
        {{ option.label }}<span class="mi-filter-n">{{ option.count }}</span>
      </button>
    </nav>

    <div v-if="inbox.error" class="mi-banner error" role="alert">
      <Icon name="report" :size="14" />
      <span>{{ inbox.error }}</span>
      <button type="button" @click="refresh">重试</button>
    </div>
    <div v-else-if="actionHint" class="mi-banner" :class="actionHint.tone">
      <Icon :name="actionHint.tone === 'error' ? 'report' : 'activity'" :size="14" />
      <span>{{ actionHint.text }}</span>
      <button type="button" aria-label="收起提示" @click="actionHint = null">×</button>
    </div>

    <!-- 卡片台：最新一条在最上面，右滑主操作 / 左滑移入回收站 / 点按看详情；纵向滚动交还浏览器
         长按 500ms 进选择态：卡片堆只露三张，多选改成整列可见条目（见下面的选择态模板） -->
    <template v-if="view === 'stack' && !selectMode && stackView">
      <button v-if="filteredItems.length" class="mi-groups-entry" type="button" @click="view = 'groups'">
        <span class="mi-groups-ic"><Icon name="list-tree" :size="16" /></span>
        <span class="mi-groups-text">
          <b>按来源分组</b> · {{ filteredItems.length }} 条来自 {{ sourceCount }} 个来源
        </span>
        <span class="mi-groups-go">看看<Icon name="chevron-right" :size="14" /></span>
      </button>

      <div v-if="!inbox.loaded && inbox.loading" class="mi-loading">
        <AppSpinner :size="15" /> 正在读取收集箱…
      </div>

      <div v-else-if="!inbox.loaded" class="mi-empty">
        <div class="mi-zero"><Icon name="report" :size="30" /></div>
        <h2>收集箱读取失败</h2>
        <p>{{ inbox.error || '连接不上中枢，确认服务在线后再试。' }}</p>
        <button class="btn primary mi-empty-btn" type="button" :disabled="inbox.loading" @click="refresh">
          <Icon name="refresh" :size="15" />重试
        </button>
      </div>

      <div v-else-if="!filteredItems.length" class="mi-empty">
        <div class="mi-zero"><Icon :name="emptyIcon" :size="34" /></div>
        <h2>{{ emptyTitle }}</h2>
        <p>{{ emptyHint }}</p>
        <div class="mi-stats">
          <div class="mi-stat"><b>{{ inbox.counts.pending }}</b><span>待整理</span></div>
          <div class="mi-stat"><b>{{ inbox.counts.converted }}</b><span>已转换</span></div>
          <div class="mi-stat"><b>{{ inbox.counts.adopted }}</b><span>已入库</span></div>
        </div>
        <button
          v-if="inbox.counts.adopted"
          class="btn primary mi-empty-btn"
          type="button"
          @click="setFilter('adopted')"
        >查看已入库 {{ inbox.counts.adopted }} 条</button>
        <button v-else class="btn primary mi-empty-btn" type="button" @click="goHome">回到首页</button>
      </div>

      <template v-else>
        <div class="mi-stage">
          <div class="mi-stack" :class="{ 'is-dragging': dragging }">
            <article
              v-for="(item, index) in stackItems"
              :key="item.path"
              class="mi-card"
              :class="cardClasses(item, index)"
              :style="cardStyle(index)"
              :role="index === 0 ? 'button' : undefined"
              :tabindex="index === 0 ? 0 : undefined"
              :aria-label="index === 0 ? '整理 ' + cardTitle(item) : undefined"
              :aria-hidden="index === 0 ? undefined : 'true'"
              @pointerdown="onCardPointerDown"
              @pointermove="onCardPointerMove"
              @pointerup="onCardPointerUp"
              @pointercancel="onCardPointerCancel"
              @contextmenu.prevent
              @click="onCardClick"
              @keydown.enter.prevent="onCardEnter"
              @keydown.space.prevent="onCardEnter"
            >
              <div class="mi-cover" :class="coverClass(item)">
                <span class="mi-cover-kicker">{{ coverKicker(item) }}</span>
                <span class="mi-cover-big">{{ coverBig(item) }}</span>
                <span class="mi-cover-icon"><Icon :name="coverIcon(item)" :size="46" /></span>
                <span v-if="item.status === 'converting'" class="mi-cover-progress"><i /></span>
              </div>
              <div class="mi-card-body">
                <div class="mi-card-top">
                  <span class="mi-status" :class="statusChip(item)"><i />{{ statusLabel(item) }}</span>
                  <span v-if="isFresh(item)" class="mi-fresh">刚刚存入</span>
                  <span class="mi-time">{{ fromNow(item.mtime) }}</span>
                </div>
                <h2 class="mi-card-title">{{ cardTitle(item) }}</h2>
                <p class="mi-card-note" :class="{ error: item.status === 'failed' }">
                  <Icon :name="noteIcon(item)" :size="13" />
                  <span>{{ cardNote(item) }}</span>
                </p>
                <div class="mi-card-meta">
                  <span class="mi-meta-item">{{ metaLine(item) }}</span>
                </div>
              </div>
              <span v-if="index === 0 && stamp" class="mi-stamp" :class="'is-' + stamp.tone">
                <Icon :name="stamp.icon" :size="14" />{{ stamp.text }}
              </span>
            </article>
          </div>
          <div class="mi-gesture">
            <Icon name="move-diagonal" :size="14" />
            <span>右滑{{ mainLabel(front) }} · 左滑移入回收站 · 长按多选 · 点按看详情</span>
          </div>

          <!-- 其余条目：卡片堆只铺三张，剩下的整列列出来——转换完的条目不能再被三张卡挡住看不到 -->
          <section v-if="queueItems.length" class="mi-queue" aria-label="其余条目">
            <div class="mi-queue-head">
              <h2>其余 {{ queueItems.length }} 条</h2>
              <span>点开可看详情与操作</span>
            </div>
            <button
              v-for="item in queueItems"
              :key="item.path"
              class="mi-row"
              type="button"
              :aria-label="'查看 ' + cardTitle(item) + ' 的详情'"
              @click="openDetail(item)"
            >
              <span class="mi-row-thumb" :class="coverClass(item)"><Icon :name="coverIcon(item)" :size="18" /></span>
              <span class="mi-row-main">
                <b>{{ cardTitle(item) }}</b>
                <small>{{ statusLabel(item) }} · {{ sourceLabel(item) }} · {{ fromNow(item.mtime) }}</small>
                <small v-if="rowDest(item)" class="mi-row-dest" :title="rowDest(item)">{{ rowDest(item) }}</small>
              </span>
              <Icon class="mi-row-go" name="chevron-right" :size="16" />
            </button>
          </section>
        </div>

        <!-- 手势的无障碍替代：三个动作都做成可点按钮 -->
        <div class="mi-bar">
          <button
            class="mi-bar-main"
            type="button"
            :disabled="mainDisabled(front)"
            @click="runMain(front)"
          >
            <AppSpinner v-if="front && busyPath === front.path" :size="15" />
            <Icon v-else :name="mainIcon(front)" :size="17" />
            {{ mainLabel(front) }}
          </button>
          <button class="mi-bar-sub" type="button" :disabled="!front" @click="openDetail(front)">
            <Icon name="eye" :size="16" />详情
          </button>
          <button
            class="mi-bar-danger"
            type="button"
            :disabled="!front"
            aria-label="移入回收站"
            @click="removeItem(front)"
          >
            <Icon name="trash" :size="16" />回收站
          </button>
        </div>
      </template>
    </template>

    <!-- 已转换 / 已入库：整列列出全部条目（不再压成三张卡）。入库是复制动作，条目不会真的消失，
         以前手机界面把已入库条目整个藏起来，用户以为「存进知识库就没了」——现在固定留一档能回看。 -->
    <template v-else-if="view === 'stack' && !selectMode">
      <div v-if="!inbox.loaded && inbox.loading" class="mi-loading">
        <AppSpinner :size="15" /> 正在读取收集箱…
      </div>

      <div v-else-if="!inbox.loaded" class="mi-empty">
        <div class="mi-zero"><Icon name="report" :size="30" /></div>
        <h2>收集箱读取失败</h2>
        <p>{{ inbox.error || '连接不上中枢，确认服务在线后再试。' }}</p>
        <button class="btn primary mi-empty-btn" type="button" :disabled="inbox.loading" @click="refresh">
          <Icon name="refresh" :size="15" />重试
        </button>
      </div>

      <div v-else-if="!filteredItems.length" class="mi-empty">
        <div class="mi-zero"><Icon :name="emptyIcon" :size="34" /></div>
        <h2>{{ emptyTitle }}</h2>
        <p>{{ emptyHint }}</p>
        <button
          v-if="filter === 'adopted'"
          class="btn primary mi-empty-btn"
          type="button"
          @click="setFilter('converted')"
        >去看已转换的</button>
        <button v-else class="btn primary mi-empty-btn" type="button" @click="setFilter('pending')">
          去看待整理的
        </button>
      </div>

      <div v-else class="mi-list" aria-label="收集箱条目列表">
            <button
              v-for="item in filteredItems"
              :key="item.path"
              class="mi-row"
              type="button"
              :aria-label="'查看 ' + cardTitle(item) + ' 的详情'"
              @click="openDetail(item)"
            >
              <span class="mi-row-thumb" :class="coverClass(item)"><Icon :name="coverIcon(item)" :size="18" /></span>
              <span class="mi-row-main">
                <b>{{ cardTitle(item) }}</b>
                <small>{{ statusLabel(item) }} · {{ sourceLabel(item) }} · {{ fromNow(item.mtime) }}</small>
                <small v-if="rowDest(item)" class="mi-row-dest" :title="rowDest(item)">{{ rowDest(item) }}</small>
              </span>
              <Icon class="mi-row-go" name="chevron-right" :size="16" />
            </button>
      </div>
    </template>

    <!-- 选择态：长按卡片进入。勾选框在每行左侧（≥44dp 热区），底栏换成批量动作 -->
    <template v-else-if="selectMode">
      <div v-if="!selectableItems.length" class="mi-empty">
        <div class="mi-zero"><Icon name="check" :size="34" /></div>
        <h2>没有可选的条目</h2>
        <p>收集箱里没有待整理的条目了。</p>
        <button class="btn primary mi-empty-btn" type="button" @click="exitSelectMode">退出多选</button>
      </div>

      <div v-else class="mi-select-list" role="group" aria-label="选择要批量处理的条目">
        <button
          v-for="item in selectableItems"
          :key="item.path"
          class="mi-select-row"
          :class="{ 'is-on': isSelected(item.path) }"
          type="button"
          role="checkbox"
          :aria-checked="isSelected(item.path)"
          :disabled="Boolean(batchBusy)"
          @click="toggleSelect(item.path)"
        >
          <span class="mi-checkbox" :class="{ 'is-on': isSelected(item.path) }" aria-hidden="true">
            <Icon v-if="isSelected(item.path)" name="check" :size="14" />
          </span>
          <span class="mi-select-thumb" :class="coverClass(item)">
            <Icon :name="coverIcon(item)" :size="18" />
          </span>
          <span class="mi-select-main">
            <b>{{ cardTitle(item) }}</b>
            <small>{{ statusLabel(item) }} · {{ sourceLabel(item) }} · {{ fromNow(item.mtime) }}</small>
          </span>
        </button>
      </div>

      <p class="mi-select-note">
        <Icon name="lightbulb" :size="12" />
        打标签暂不可用：收集箱条目不是知识库页面；入库后到页面里打标签。
      </p>

      <div class="mi-bar mi-bar-select">
        <button
          class="mi-bar-main"
          type="button"
          :disabled="!selectedPaths.length || Boolean(batchBusy)"
          @click="batchAdopt"
        >
          <AppSpinner v-if="batchBusy === 'adopt'" :size="15" />
          <Icon v-else name="check" :size="17" />
          {{ batchBusy === 'adopt' ? '入库中 ' + batchProgress.done + '/' + batchProgress.total : '入库 ' + selectedPaths.length + ' 条' }}
        </button>
        <button class="mi-bar-sub" type="button" disabled title="暂不可用：收集箱条目不是知识库页面，入库后在知识库打标签">
          打标签
        </button>
        <button
          class="mi-bar-danger"
          type="button"
          :disabled="!selectedPaths.length || Boolean(batchBusy)"
          @click="batchTrash"
        >
          <AppSpinner v-if="batchBusy === 'trash'" :size="15" />
          <Icon v-else name="trash" :size="16" />
          {{ batchBusy === 'trash' ? '移入中 ' + batchProgress.done + '/' + batchProgress.total : '回收站' }}
        </button>
      </div>
    </template>

    <!-- 分组视图：按来源 / 类型归组，不做假 AI 建议 -->
    <template v-else>
      <p class="mi-groups-note">按来源和类型归在一起。转换与入库都由中枢执行，手机端只负责发任务、刷状态。</p>

      <div v-if="!filteredItems.length" class="mi-empty">
        <div class="mi-zero"><Icon :name="emptyIcon" :size="34" /></div>
        <h2>{{ emptyTitle }}</h2>
        <p>{{ emptyHint }}</p>
        <button class="btn primary mi-empty-btn" type="button" @click="goHome">回到首页</button>
      </div>

      <div v-else class="mi-groups">
        <article v-for="group in groups" :key="group.key" class="mi-group">
          <div class="mi-group-head">
            <span class="mi-group-ic"><Icon :name="group.icon" :size="16" /></span>
            <div class="mi-group-name">
              <h2>{{ group.label }}</h2>
              <p>{{ groupCaption(group) }}</p>
            </div>
            <span class="mi-group-count">{{ group.items.length }}</span>
          </div>
          <ul class="mi-group-items">
            <li v-for="sample in group.items.slice(0, 2)" :key="sample.path">{{ cardTitle(sample) }}</li>
            <li v-if="group.items.length > 2" class="mi-more">还有 {{ group.items.length - 2 }} 条</li>
          </ul>
          <div class="mi-group-foot">
            <span class="mi-group-note">{{ groupNote(group) }}</span>
            <div v-if="group.convertible.length || group.converted.length" class="mi-group-btns">
              <button
                v-if="group.convertible.length"
                class="mi-mini primary"
                type="button"
                :disabled="groupBusy === group.key"
                @click="convertGroup(group)"
              >
                {{ groupBusy === group.key ? '提交中…' : '全部转换' }}
              </button>
              <button
                v-if="group.converted.length"
                class="mi-mini success"
                type="button"
                :disabled="groupBusy === group.key"
                @click="adoptGroup(group)"
              >
                全部入库
              </button>
            </div>
          </div>
        </article>
      </div>

      <div class="mi-bar mi-bar-groups">
        <button class="mi-bar-main" type="button" @click="view = 'stack'">
          <Icon name="chevron-left" :size="16" />逐条看
        </button>
        <button class="mi-bar-sub" type="button" :disabled="inbox.loading" @click="refresh">
          <AppSpinner v-if="inbox.loading" :size="14" />
          <Icon v-else name="refresh" :size="16" />刷新
        </button>
      </div>
    </template>

    <Teleport to="body">
      <!-- 详情 sheet（点按卡片与「详情」按钮都落到这里） -->
      <template v-if="detailItem">
        <div class="mi-dim" @click="closeDetail" />
        <section
          class="mi-sheet mi-detail"
          role="dialog"
          aria-modal="true"
          :aria-label="cardTitle(detailItem) + ' 的详情'"
        >
          <div class="mi-sheet-grab" />
          <div class="mi-detail-head">
            <div class="mi-detail-head-main">
              <h2>{{ cardTitle(detailItem) }}</h2>
              <p>{{ sourceLabel(detailItem) }} · {{ typeLabel(detailItem) }} · {{ formatSize(detailItem.size) }}</p>
            </div>
            <button class="mi-iconbtn" type="button" aria-label="关闭详情" @click="closeDetail">
              <Icon name="x" :size="18" />
            </button>
          </div>
          <div class="mi-detail-rows">
            <div class="mi-detail-row">
              <span>状态</span>
              <b><span class="mi-status" :class="statusChip(detailItem)"><i />{{ statusLabel(detailItem) }}</span></b>
            </div>
            <div class="mi-detail-row">
              <span>收纳时间</span><b>{{ absoluteTime(detailItem.mtime) }}</b>
            </div>
            <div class="mi-detail-row">
              <span>原文件</span><b class="mi-wrap">{{ detailItem.path }}</b>
            </div>
            <div v-if="detailItem.derivedPath" class="mi-detail-row">
              <span>转换产物</span><b class="mi-wrap">{{ detailItem.derivedPath }}</b>
            </div>
            <div v-if="detailItem.adoptedPath" class="mi-detail-row">
              <span>已入库到</span><b class="mi-wrap">{{ detailItem.adoptedPath }}</b>
            </div>
            <div v-if="hasVideo(detailItem)" class="mi-detail-row">
              <span>视频平台</span><b>{{ videoPlatformOf(detailItem) }}</b>
            </div>
            <div v-if="videoLinkOf(detailItem)" class="mi-detail-row">
              <span>原始链接</span>
              <b class="mi-wrap">
                <a :href="videoLinkOf(detailItem)" target="_blank" rel="noopener noreferrer">{{ videoLinkOf(detailItem) }}</a>
              </b>
            </div>
            <div v-if="detailItem.hint" class="mi-detail-row">
              <span>说明</span><b class="mi-wrap">{{ detailItem.hint }}</b>
            </div>
            <div v-if="detailItem.error" class="mi-detail-row error">
              <span>失败原因</span><b class="mi-wrap">{{ detailItem.error }}</b>
            </div>
          </div>
          <div class="mi-detail-actions">
            <button
              class="btn primary mi-detail-primary"
              type="button"
              :disabled="mainDisabled(detailItem)"
              @click="detailRun(detailItem)"
            >
              <Icon :name="mainIcon(detailItem)" :size="16" />{{ mainLabel(detailItem) }}
            </button>
            <div class="mi-detail-grid">
              <button
                v-if="detailItem.assistantSessionId"
                class="btn"
                type="button"
                @click="detailProcess(detailItem)"
              >
                <Icon name="messages" :size="15" />查看过程
              </button>
              <button
                v-if="hasProduct(detailItem) && mainKind(detailItem) !== 'review'"
                class="btn"
                type="button"
                @click="detailReview(detailItem)"
              >
                <Icon name="eye" :size="15" />查看产物
              </button>
              <button class="btn" type="button" :disabled="busyPath === detailItem.path" @click="detailAgent(detailItem)">
                <Icon name="ai" :size="15" />让 Agent 处理
              </button>
              <button class="btn" type="button" @click="detailOriginal(detailItem)">
                <Icon :name="isDesktop ? 'external' : 'download'" :size="15" />{{ isDesktop ? '系统应用打开' : '下载原文件' }}
              </button>
              <button class="btn danger" type="button" @click="detailRemove(detailItem)">
                <Icon name="trash" :size="15" />移入回收站
              </button>
            </div>
          </div>
        </section>
      </template>

      <!-- 产物预览：入库前先看一眼；已入库的条目也能回看它最终写进知识库的内容 -->
      <template v-if="reviewItem">
        <div class="mi-dim" @click="closeReview" />
        <section class="mi-sheet mi-review" role="dialog" aria-modal="true" :aria-label="reviewTitle">
          <div class="mi-sheet-grab" />
          <div class="mi-detail-head">
            <div class="mi-detail-head-main">
              <h2>{{ reviewTitle }}</h2>
              <p>{{ reviewItem.derivedPath || '转换产物' }}</p>
            </div>
            <button class="mi-iconbtn" type="button" aria-label="关闭产物预览" @click="closeReview">
              <Icon name="x" :size="18" />
            </button>
          </div>
          <div class="mi-review-body">
            <div v-if="reviewLoading" class="mi-review-state">
              <AppSpinner :size="14" /> 正在读取产物…
            </div>
            <div v-else-if="reviewError" class="mi-review-state error">
              <Icon name="report" :size="14" />{{ reviewError }}
            </div>
            <div v-else class="mi-review-md" v-html="reviewHtml" />
          </div>
          <div class="mi-review-actions">
            <button class="btn" type="button" @click="closeReview">关闭</button>
            <button
              v-if="reviewCanAdopt"
              class="btn primary"
              type="button"
              :disabled="busyPath === reviewItem.path"
              @click="adoptFromReview"
            >
              <Icon name="check" :size="15" />入库
            </button>
          </div>
        </section>
      </template>

      <!-- 分享落袋回执：这是「保存之后」的回执，不是保存前确认 -->
      <template v-if="captureOpen">
        <div class="mi-dim" @click="dismissCapture('inbox')" />
        <section class="mi-sheet mi-receipt" role="dialog" aria-modal="true" aria-labelledby="mi-receipt-title">
          <div class="mi-sheet-grab" />
          <div class="mi-receipt-head">
            <span class="mi-check"><Icon name="check" :size="22" /></span>
            <div class="mi-receipt-title">
              <h2 id="mi-receipt-title">已先存入收集箱</h2>
              <p>{{ receiptSubline }}</p>
            </div>
            <button class="mi-iconbtn" type="button" aria-label="关闭回执" @click="dismissCapture('inbox')">
              <Icon name="x" :size="18" />
            </button>
          </div>

          <article v-if="captureItem" class="mi-receipt-card">
            <div class="mi-receipt-cover" :class="coverClass(captureItem)">{{ coverBig(captureItem) }}</div>
            <div class="mi-receipt-card-main">
              <b>{{ cardTitle(captureItem) }}</b>
              <span>{{ sourceLabel(captureItem) === typeLabel(captureItem) ? typeLabel(captureItem) : sourceLabel(captureItem) + ' · ' + typeLabel(captureItem) }} · {{ formatSize(captureItem.size) }}</span>
            </div>
            <span v-if="isFresh(captureItem)" class="mi-fresh">刚刚 +1</span>
          </article>
          <div v-else class="mi-receipt-waiting">
            <AppSpinner :size="14" /> 正在确认收集箱里的新条目…
          </div>

          <div class="mi-receipt-queue">
            <Icon name="inbox" :size="14" />
            <span>收集箱现有 <b>{{ inbox.activeItems.length }}</b> 条</span>
          </div>
          <p class="mi-receipt-note">摘要与标签待绑定中枢后补全；转换和入库都由中枢执行，这里只负责先落袋。</p>
          <div class="mi-receipt-actions">
            <button class="btn primary" type="button" @click="dismissCapture('inbox')">去清仓</button>
            <button class="btn ghost" type="button" @click="dismissCapture('home')">回到首页</button>
          </div>
          <button
            v-if="captureItem"
            class="mi-receipt-undo"
            type="button"
            :disabled="captureBusy"
            @click="undoCapture"
          >
            {{ captureBusy ? '正在撤销…' : '撤销这次保存' }}
          </button>
        </section>
      </template>

      <!-- 手动补录：分享之外的入口（相册 / 文件 / 粘贴链接），不打断卡片台 -->
      <template v-if="intakeOpen">
        <div class="mi-dim" @click="closeIntake" />
        <section class="mi-sheet mi-intake" role="dialog" aria-modal="true" aria-labelledby="mi-intake-title">
          <div class="mi-sheet-grab" />
          <div class="mi-intake-head">
            <h2 id="mi-intake-title">收进收集箱</h2>
            <button class="mi-iconbtn" type="button" aria-label="关闭" @click="closeIntake">
              <Icon name="x" :size="18" />
            </button>
          </div>
          <button class="mi-intake-file" type="button" :disabled="intakeBusy" @click="pickIntakeFiles">
            <span class="mi-intake-ic"><Icon name="file-plus" :size="19" /></span>
            <span class="mi-intake-file-text">
              <b>选择文件</b>
              <small>照片、PDF、Office、音视频都可以；单个上限 200 MB</small>
            </span>
            <Icon name="chevron-right" :size="16" />
          </button>
          <form class="mi-intake-url" @submit.prevent="submitIntakeUrl">
            <input
              v-model="intakeUrl"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="粘贴网页 / B站 / 抖音链接"
              :disabled="intakeBusy"
            />
            <button class="btn primary" type="submit" :disabled="intakeBusy || !intakeUrl.trim()">
              {{ intakeBusy ? '保存中…' : '保存' }}
            </button>
          </form>
          <p class="mi-intake-note">
            <Icon name="info" :size="12" />
            网页保存 HTML 原件；B站 / 抖音链接保存为占位稿，提炼时再取内容——B站有 CC 字幕时优先按字幕，拿不到字幕再取视频；抖音图文 / 实况笔记按多图理解。转换与入库仍由中枢执行。
          </p>
        </section>
      </template>
    </Teleport>
    <input ref="intakeFileInput" class="mi-file-input" type="file" multiple @change="onIntakePicked" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { useInboxStore, type InboxItem } from '../stores/inbox';
import { registerBackHandler } from '../lib/androidBack';
import { confirmDialog } from '../lib/confirm';
import { haptic } from '../lib/haptics';
import { isServerConvertible } from '../lib/inboxAgent';
import { renderMarkdown } from '../lib/markdown';
import { notify, pushToast } from '../lib/notify';
import Icon from './Icon.vue';
import AppSpinner from './ui/AppSpinner.vue';

/**
 * 手机端收集箱卡片台（对外零 props）。
 *
 * 桌面版收集箱是「行式台账」，窄屏这边换成一张一张的卡片：最新一条在最上面，
 * 右滑做主操作（转换 / 入库 / 让 Agent 处理 / 下载预览），左滑移入回收站（4 秒内可撤销），
 * 点按看详情；底部三个按钮是同一组动作的无障碍替代，不依赖手势也能用。
 *
 * 四条边界写在实现里：
 *  1. 卡片分组只按「来源 / 类型」归组，不做假的 AI 建议；转换与入库一律交给服务端中枢执行。
 *  2. /inbox?capture=<时间戳> 是原生分享落袋后推过来的「保存之后」回执，文案不能写成保存前确认。
 *  3. 动作失败/离线时把服务端的 error/hint 留在页面上（不只弹一条会消失的 toast）。
 *  4. 纵向滚动交还浏览器：只有横向位移明显大于纵向（|dx| > |dy|×1.3）的拖动才接管卡片；
 *     底部动作条贴在组件底边（=底栏上方），卡片区自己滚，按钮不跟着卡片走。
 *  5. 长按多选是独立模式：进入后卡片手势全部停用（避免误滑），列出的可见条目才可勾选；
 *     全选只作用于这份列表，批量动作串行调用既有单条接口，失败逐条记录。
 */

const inbox = useInboxStore();
const chat = useChatStore();
const app = useAppStore();
const route = useRoute();
const router = useRouter();

/** 桌面端（有 Electron 桥）：原文件用系统默认应用打开；Docker / 浏览器端直接下载 */
const isDesktop = Boolean((window as any).wikiDesktop);

/*
 * 底部动作条要压在底栏上方：组件高度吃满 Home .content 的内容盒，动作条就落在组件底边。
 * .content 的下内边距本来就等于「底栏高度 + 外边距 + 呼吸位」，两层是同一份口径；万一
 * 改版换了底栏高度而 .content 没跟着改，这里再按底栏实际位置补一段让位，避免动作条压在栏上。
 */
const rootEl = ref<HTMLElement | null>(null);
const shellExtra = ref(0);
const shellStyle = computed(() =>
  shellExtra.value ? '--mi-shell-extra: ' + shellExtra.value + 'px' : undefined
);

function syncShellInset(): void {
  const host = rootEl.value?.parentElement;
  const nav = document.querySelector('.bottom-nav') as HTMLElement | null;
  if (!host || !nav) {
    shellExtra.value = 0;
    return;
  }
  const rect = nav.getBoundingClientRect();
  if (!rect.height) {
    shellExtra.value = 0;
    return;
  }
  const reserved = parseFloat(getComputedStyle(host).paddingBottom) || 0;
  const need = Math.round(window.innerHeight - rect.top + 8 - reserved);
  const next = need > 0 ? need : 0;
  if (next !== shellExtra.value) shellExtra.value = next;
}

type ViewKind = 'stack' | 'groups';
type MainKind = 'convert' | 'retry' | 'adopt' | 'review' | 'process' | 'agent' | 'download' | 'none';
type StatusTone = 'pending' | 'converting' | 'converted' | 'failed' | 'adopted';
type StampTone = 'in' | 'drop';

interface ActionHint {
  tone: 'error' | 'info';
  text: string;
}

interface SourceGroup {
  key: string;
  label: string;
  icon: string;
  items: InboxItem[];
  /** 还能交给中枢转换 / 重新转换的（待整理 + 失败） */
  convertible: InboxItem[];
  /** 已有产物、可以入库的 */
  converted: InboxItem[];
  /** 已经入库的（在「已入库」分类里回看） */
  adopted: InboxItem[];
}

const view = ref<ViewKind>('stack');

/**
 * 状态分类（与桌面工作台同一口径）：未入库（默认，= 待整理 + 已转换）/ 待整理 / 已转换 / 已入库。
 *
 * 手机界面此前只有卡片台、没有分类：已入库条目被整片藏起来，用户以为「存进知识库就消失了」；
 * 卡片堆又只铺三张，排在后面的已转换条目也够不着。分类 + 整列列表把两头一起补上。
 */
type InboxFilter = 'active' | 'pending' | 'converted' | 'adopted';
const filter = ref<InboxFilter>('active');
const filterOptions = computed(() => [
  { value: 'active' as const, label: '未入库', count: Math.max(0, inbox.counts.all - inbox.counts.adopted) },
  { value: 'pending' as const, label: '待整理', count: inbox.counts.pending },
  { value: 'converted' as const, label: '已转换', count: inbox.counts.converted },
  { value: 'adopted' as const, label: '已入库', count: inbox.counts.adopted },
]);

/** 卡片台只给还没收尾的分类；已转换 / 已入库改用整列列表，全部条目可见 */
const stackView = computed(() => filter.value === 'active' || filter.value === 'pending');

/* ===== 分类与来源 ===== */

const CATEGORY_LABELS: Record<string, string> = {
  document: 'Word 文档',
  spreadsheet: 'Excel 表格',
  presentation: 'PPT 演示',
  pdf: 'PDF 文档',
  image: '图片',
  text: '文本',
  web: '网页',
  audio: '音频',
  video: '视频',
  archive: '压缩包',
  other: '其他文件',
};

const PLATFORM_LABELS: Record<string, string> = {
  bilibili: 'B站',
  douyin: '抖音',
  upload: '本地视频',
};

/** 平台名：未知平台不硬猜，退回「视频」 */
function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || '视频';
}

function categoryLabel(item: InboxItem | null): string {
  if (!item) return '文件';
  return CATEGORY_LABELS[item.category] || '文件';
}

/** 卡片上的「来源」：视频看平台，其余按类型 */
function sourceLabel(item: InboxItem | null): string {
  if (!item) return '';
  if (item.capability === 'video') return platformLabel(item.video?.platform || '');
  return categoryLabel(item);
}

/* ===== 列表口径 ===== */

/** 当前分类下的条目，按收纳时间倒序（active = 待整理 + 转换中 + 已转换 + 失败，不含已入库） */
const filteredItems = computed<InboxItem[]>(() => {
  const list = filter.value === 'active'
    ? inbox.items.filter((item) => item.status !== 'adopted')
    : inbox.items.filter((item) => item.status === filter.value);
  return [...list].sort((a, b) => b.mtime - a.mtime);
});

/** 卡片堆只铺三张：最上面一张完整，后面两张露边；其余条目整列列在下面（不能藏在三张卡后面） */
const stackItems = computed(() => filteredItems.value.slice(0, 3));
const queueItems = computed(() => filteredItems.value.slice(3));
const front = computed<InboxItem | null>(() => filteredItems.value[0] || null);

/** 切换分类：选择态不能跨分类延续，提示条也清掉 */
function setFilter(next: InboxFilter): void {
  if (filter.value === next) return;
  if (selectMode.value) exitSelectMode();
  filter.value = next;
  actionHint.value = null;
  haptic('tap');
}

/* ===== 长按多选（选择态） =====
 * 卡片堆只露三张，多选改成整列可见条目：长按卡片 500ms 进选择态，每行左侧一个勾选框，
 * 顶栏换成「取消 / 已选 N 条 / 全选」，底栏换成批量动作。全选只作用于这份可见列表
 * （已入库的条目本来就不在收集箱界面里）。 */
const LONG_PRESS_MS = 500;
/** 长按期间允许的手指位移：超过就当成滑动，取消长按 */
const LONG_PRESS_MOVE_PX = 10;

const selectMode = ref(false);
/** 已选条目的 path：按 path 记而不是对象引用，刷新/重排后选中不丢 */
const selectedPaths = ref<string[]>([]);
/** 长按触发后开启的短守卫：卡片在按住时被换成列表，松手那次 click 可能落到列表行上 */
let selectGuardUntil = 0;
let selectGuardCleanup: (() => void) | null = null;
const batchBusy = ref<'' | 'adopt' | 'trash'>('');
const batchProgress = ref({ done: 0, total: 0 });

/** 选择态列出的条目 = 当前分类可见的条目（全选只作用于这份列表） */
const selectableItems = computed<InboxItem[]>(() => filteredItems.value);
const selectablePaths = computed(() => selectableItems.value.map((item) => item.path));
const allSelected = computed(
  () =>
    selectablePaths.value.length > 0 &&
    selectablePaths.value.every((path) => selectedPaths.value.includes(path)),
);
const selectSubline = computed(() => {
  if (batchBusy.value) {
    const action = batchBusy.value === 'adopt' ? '入库' : '移入回收站';
    return '正在' + action + ' ' + batchProgress.value.done + '/' + batchProgress.value.total;
  }
  return '共 ' + selectableItems.value.length + ' 条可多选 · 点按勾选';
});

function isSelected(path: string): boolean {
  return selectedPaths.value.includes(path);
}

function toggleSelect(path: string): void {
  if (batchBusy.value) return;
  // 长按松手那次 click 可能落到刚渲染出来的列表行上：刚进选择态的几百毫秒内忽略
  if (Date.now() < selectGuardUntil) return;
  const next = selectedPaths.value.slice();
  const index = next.indexOf(path);
  if (index >= 0) next.splice(index, 1);
  else next.push(path);
  selectedPaths.value = next;
}

function toggleSelectAll(): void {
  if (batchBusy.value) return;
  // 全选只对当前可见列表生效：不把已入库或当前视图之外的条目算进来
  selectedPaths.value = allSelected.value ? [] : selectablePaths.value.slice();
}

const converting = computed(() => inbox.items.some((item) => item.status === 'converting'));

const freshCount = computed(() => filteredItems.value.filter(isFresh).length);

const subline = computed(() => {
  if (!inbox.loaded) return inbox.loading ? '正在读取收集箱…' : '读取失败，可点刷新重试';
  if (filter.value === 'adopted') {
    return '已入库 ' + inbox.counts.adopted + ' 条 · 产物已在知识库，原件仍留在收集箱';
  }
  if (filter.value === 'converted') {
    return '已转换 ' + inbox.counts.converted + ' 条 · 点条目看产物、确认入库';
  }
  const parts = ['待整理 ' + inbox.counts.pending];
  if (inbox.counts.converted) parts.push('已转换 ' + inbox.counts.converted);
  if (inbox.counts.converting) parts.push(inbox.counts.converting + ' 个转换中');
  if (freshCount.value) parts.push('刚刚存入 ' + freshCount.value + ' 条');
  return parts.join(' · ');
});

const groupsSubline = computed(() => {
  if (!inbox.loaded) return inbox.loading ? '正在读取收集箱…' : '读取失败，可点刷新重试';
  const parts = [filteredItems.value.length + ' 条 · ' + sourceCount.value + ' 个来源分组'];
  if (inbox.counts.converting) parts.push(inbox.counts.converting + ' 个转换中');
  return parts.join(' · ');
});

/** 空态跟着当前分类说话：已入库是「知识库那边」，其余是「收集箱这边」 */
const emptyIcon = computed(() => (filter.value === 'adopted' ? 'check' : 'file'));

const emptyTitle = computed(() => {
  if (filter.value === 'adopted') return '还没有已入库的条目';
  if (filter.value === 'converted') return '还没有已转换的条目';
  if (filter.value === 'pending') return '没有待整理的条目';
  return '收集箱清空了';
});

const emptyHint = computed(() => {
  if (filter.value === 'adopted') {
    return '转换产物确认入库后会出现在这里，方便回头查它进了知识库的哪一篇。';
  }
  if (filter.value === 'converted') {
    return '点「待整理」里的条目转换或提炼视频；产物出来后在这里确认入库。';
  }
  if (inbox.counts.adopted) {
    return '没有待整理的条目；已入库的 ' + inbox.counts.adopted + ' 条在「已入库」分类里，知识库那边也能检索。';
  }
  return '通过分享或拖入保存的内容会先落到这里；转换、入库都由中枢执行。';
});

/* ===== 按来源 / 类型分组（不做 AI 建议） ===== */

function groupKey(item: InboxItem): string {
  if (item.capability === 'video') {
    const platform = item.video?.platform || 'upload';
    return 'video:' + platform;
  }
  if (item.category === 'web') return 'web';
  return 'cat:' + item.category;
}

function groupLabel(item: InboxItem): string {
  if (item.capability === 'video') return platformLabel(item.video?.platform || '');
  return categoryLabel(item);
}

function groupIcon(item: InboxItem): string {
  if (item.capability === 'video' || item.category === 'audio') return 'play';
  const icons: Record<string, string> = {
    document: 'word',
    spreadsheet: 'excel',
    presentation: 'ppt',
    pdf: 'pdf',
    image: 'image',
    text: 'markdown',
    web: 'globe',
    archive: 'archive',
    other: 'file',
  };
  return icons[item.category] || 'file';
}

const groups = computed<SourceGroup[]>(() => {
  const map = new Map<string, SourceGroup>();
  for (const item of filteredItems.value) {
    const key = groupKey(item);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        label: groupLabel(item),
        icon: groupIcon(item),
        items: [],
        convertible: [],
        converted: [],
        adopted: [],
      };
      map.set(key, group);
    }
    group.items.push(item);
    if (item.status === 'adopted') group.adopted.push(item);
    else if (item.status === 'converted') group.converted.push(item);
    else if (isServerConvertible(item.capability) && item.status !== 'converting') group.convertible.push(item);
  }
  return [...map.values()].sort(
    (a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label, 'zh-CN')
  );
});

const sourceCount = computed(() => groups.value.length);

function groupCaption(group: SourceGroup): string {
  const parts: string[] = [];
  const waiting = group.items.filter((item) => item.status === 'pending' || item.status === 'failed').length;
  if (waiting) parts.push('待整理 ' + waiting);
  if (group.converted.length) parts.push('已转换 ' + group.converted.length);
  if (group.adopted.length) parts.push('已入库 ' + group.adopted.length);
  if (group.items.some((item) => item.status === 'converting')) parts.push('转换中');
  return parts.join(' · ') || '已处理';
}

function groupNote(group: SourceGroup): string {
  if (group.convertible.length) return '可转换 ' + group.convertible.length + ' 条 · 由中枢执行';
  if (group.converted.length) return '已转换 ' + group.converted.length + ' 条 · 入库后进知识库';
  if (group.adopted.length) return '已入库 ' + group.adopted.length + ' 条 · 产物已在知识库';
  if (group.items.some((item) => item.status === 'converting')) return '中枢正在处理，完成后自动刷新';
  return '这个格式需逐条交给 Agent 或下载原文件';
}

/* ===== 状态与主操作 ===== */

const STATUS_STYLE: Record<InboxItem['status'], { label: string; tone: StatusTone }> = {
  pending: { label: '待整理', tone: 'pending' },
  converting: { label: '转换中', tone: 'converting' },
  converted: { label: '已转换', tone: 'converted' },
  adopted: { label: '已入库', tone: 'adopted' },
  failed: { label: '转换失败', tone: 'failed' },
};

function statusLabel(item: InboxItem | null): string {
  if (!item) return '';
  return STATUS_STYLE[item.status]?.label || item.status;
}

function statusChip(item: InboxItem | null): StatusTone {
  if (!item) return 'pending';
  return STATUS_STYLE[item.status]?.tone || 'pending';
}

/** 主操作按状态切换：转换中=查看过程 / 失败=重试 / 已转换=入库 / 已入库=查看产物 / 待整理=可转就转、Agent-only 交 Agent、其余下载 */
function mainKind(item: InboxItem | null): MainKind {
  if (!item) return 'none';
  if (item.status === 'converting') return 'process';
  if (item.status === 'failed') {
    if (isServerConvertible(item.capability)) return 'retry';
    return item.capability === 'agent-only' ? 'agent' : 'download';
  }
  if (item.status === 'converted') return 'adopt';
  if (item.status === 'adopted') return item.derivedPath ? 'review' : 'none';
  if (isServerConvertible(item.capability)) return 'convert';
  if (item.capability === 'agent-only') return 'agent';
  return 'download';
}

function mainLabel(item: InboxItem | null): string {
  if (!item) return '';
  const kind = mainKind(item);
  if (kind === 'convert') return item.capability === 'video' ? '提炼视频' : '转换';
  if (kind === 'retry') return item.capability === 'video' ? '重新提炼' : '重新转换';
  if (kind === 'adopt') return '入库';
  if (kind === 'review') return '查看产物';
  if (kind === 'process') return item.assistantSessionId ? '查看过程' : '转换中…';
  if (kind === 'agent') return '让 Agent 处理';
  if (kind === 'download') return isDesktop ? '打开原文件' : '下载原文件';
  return '暂无操作';
}

function mainIcon(item: InboxItem | null): string {
  if (!item) return 'file';
  const kind = mainKind(item);
  if (kind === 'convert' || kind === 'retry' || kind === 'agent') return 'ai';
  if (kind === 'adopt') return 'check';
  if (kind === 'review') return 'eye';
  if (kind === 'process') return 'messages';
  if (kind === 'download') return isDesktop ? 'external' : 'download';
  return 'file';
}

function mainDisabled(item: InboxItem | null): boolean {
  if (!item) return true;
  if (busyPath.value === item.path) return true;
  const kind = mainKind(item);
  if (kind === 'none') return true;
  if (kind === 'process' && !item.assistantSessionId) return true;
  return false;
}

/* ===== 时间 / 大小 / 文本 ===== */

const FRESH_WINDOW_MS = 10 * 60 * 1000;

/** 最近 10 分钟内收纳的条目：卡片打「刚刚存入」徽标 */
function isFresh(item: InboxItem | null): boolean {
  if (!item) return false;
  const diff = Date.now() - item.mtime;
  return diff > -60 * 1000 && diff < FRESH_WINDOW_MS;
}

function fromNow(mtime: number): string {
  const diff = Date.now() - mtime;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' 小时前';
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + ' 天前';
  return new Date(mtime).toLocaleDateString('zh-CN');
}

function absoluteTime(mtime: number): string {
  return new Date(mtime).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatSize(size: number): string {
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** 卡片标题：视频用识别出的标题，文件去掉扩展名（扩展名在封面大字上） */
function cardTitle(item: InboxItem | null): string {
  if (!item) return '';
  const videoTitle = item.video?.title?.trim();
  if (item.capability === 'video' && videoTitle) {
    return item.video?.platform === 'upload' ? videoTitle.replace(/\.[^.]+$/, '') || videoTitle : videoTitle;
  }
  return item.name.replace(/\.[^.]+$/, '') || item.name;
}

function typeLabel(item: InboxItem | null): string {
  if (!item) return '';
  if (item.capability === 'video') return platformLabel(item.video?.platform || '');
  const ext = (item.ext || '').toUpperCase();
  return ext || categoryLabel(item);
}

/** 卡片元信息：类型 / 大小 */
function metaLine(item: InboxItem | null): string {
  if (!item) return '';
  const parts = [typeLabel(item), formatSize(item.size)];
  return parts.join(' · ');
}

/** 封面颜色按类型 / 平台走 CSS 渐变（不引外部图片） */
function coverClass(item: InboxItem | null): string {
  if (!item) return 'cov-other';
  if (item.capability === 'video') {
    const platform = item.video?.platform || 'upload';
    if (platform === 'bilibili') return 'cov-bili';
    if (platform === 'douyin') return 'cov-douyin';
    return 'cov-video';
  }
  const byCategory: Record<string, string> = {
    document: 'cov-doc',
    spreadsheet: 'cov-sheet',
    presentation: 'cov-slide',
    pdf: 'cov-pdf',
    image: 'cov-image',
    text: 'cov-article',
    web: 'cov-web',
    audio: 'cov-audio',
    archive: 'cov-archive',
    other: 'cov-other',
  };
  return byCategory[item.category] || 'cov-other';
}

/** 封面左上小字：来源 / 平台 */
function coverKicker(item: InboxItem | null): string {
  if (!item) return '';
  if (item.capability === 'video') return '视频 · ' + platformLabel(item.video?.platform || '');
  return categoryLabel(item);
}

/** 封面大字：文件扩展名或平台名（一眼能认出这是什么） */
function coverBig(item: InboxItem | null): string {
  if (!item) return '';
  if (item.capability === 'video') {
    const platform = item.video?.platform;
    if (platform === 'bilibili') return 'B站';
    if (platform === 'douyin') return '抖音';
    return '视频';
  }
  const ext = (item.ext || '').toUpperCase();
  if (!ext) return 'FILE';
  return ext.length <= 4 ? ext : 'FILE';
}

function coverIcon(item: InboxItem | null): string {
  if (!item) return 'file';
  if (item.capability === 'video') return 'play';
  const byCategory: Record<string, string> = {
    document: 'word',
    spreadsheet: 'excel',
    presentation: 'ppt',
    pdf: 'pdf',
    image: 'image',
    text: 'markdown',
    web: 'globe',
    audio: 'play',
    archive: 'archive',
    other: 'file',
  };
  return byCategory[item.category] || 'file';
}

function noteIcon(item: InboxItem | null): string {
  if (!item) return 'file';
  if (item.status === 'failed') return 'report';
  if (item.status === 'converting') return 'activity';
  if (item.status === 'converted' || item.status === 'adopted') return 'check';
  if (item.capability === 'agent-only') return 'messages';
  if (item.capability === 'unsupported') return 'alert';
  return 'file';
}

/** 卡面说明：状态、能力与下一步都说清楚，失败原因不藏 */
function cardNote(item: InboxItem | null): string {
  if (!item) return '';
  if (item.status === 'failed') return item.error || '转换失败，可以重试';
  if (item.status === 'converting') {
    return item.capability === 'video' ? '中枢正在提炼，完成后自动刷新' : '中枢正在转换，完成后自动刷新';
  }
  if (item.status === 'converted') {
    return item.derivedPath ? '产物：' + fileName(item.derivedPath) : '已生成 Markdown 产物，可入库';
  }
  if (item.status === 'adopted') {
    return item.adoptedPath ? '已入库：' + item.adoptedPath : '已入库';
  }
  if (isServerConvertible(item.capability)) {
    if (item.hint) return item.hint;
    return item.capability === 'video'
      ? '由中枢提炼成 Markdown 纪要：B站优先用 CC 字幕，抖音图文按多图理解'
      : '由中枢按语义转成 Markdown，产物仍留在收集箱';
  }
  if (item.capability === 'agent-only') return item.hint || '服务端不能直接转换，交给 Agent 读原件';
  return item.hint || '这个格式暂不支持转换，可下载原文件';
}

/* ===== 提示条与错误 ===== */

const actionHint = ref<ActionHint | null>(null);
const busyPath = ref('');
const groupBusy = ref('');

function setHint(tone: ActionHint['tone'], text: string) {
  actionHint.value = { tone, text };
}

function errText(error: any): string {
  return error?.response?.data?.error || error?.message || '请求失败，请稍后重试';
}

/* ===== 转换 / 入库 / Agent / 下载 / 移除 ===== */

/** 转换排队后先把轮询挂上：服务端可能还没把任务挂到列表上，只等 converting 会漏掉头几百毫秒 */
const POLL_MS = 2000;
const CONVERT_GRACE_MS = 10000;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let graceUntil = 0;
let disposed = false;

function pollingNeeded(): boolean {
  return converting.value || Date.now() < graceUntil;
}

function syncPolling() {
  if (disposed) return;
  if (pollingNeeded() && !pollTimer) {
    pollTimer = setInterval(pollTick, POLL_MS);
  } else if (!pollingNeeded() && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function pollTick() {
  if (inbox.loading) return;
  void inbox.load().then(syncPolling);
}

function expectConversion() {
  graceUntil = Date.now() + CONVERT_GRACE_MS;
  syncPolling();
}

watch(converting, syncPolling);

/* 刷新/轮询更新条目后：被别处处理掉的选中项要跟着消失；列表空了直接退出多选 */
watch(selectableItems, (list) => {
  if (!selectMode.value) return;
  const alive = new Set(list.map((item) => item.path));
  const next = selectedPaths.value.filter((path) => alive.has(path));
  if (next.length !== selectedPaths.value.length) selectedPaths.value = next;
  // 批量操作进行中列表可能被 adopt/remove 清空：等批量收尾自己退出，别把进度状态提前洗掉
  if (!list.length && !batchBusy.value) exitSelectMode();
});

async function refresh(): Promise<void> {
  await inbox.load();
  syncPolling();
}

/** 打开一条 Agent 会话：与 InboxView 的 openConversionChat 同一套做法 */
async function openSession(sessionId: string): Promise<void> {
  try {
    await chat.loadSessions();
    await chat.selectSession(sessionId);
    app.toggleChat(true);
  } catch {
    notify.error('操作已受理，但暂时无法打开 Agent 对话');
  }
}

async function convertItem(item: InboxItem | null): Promise<void> {
  if (!item || item.status === 'converting' || !isServerConvertible(item.capability)) return;
  if (busyPath.value === item.path) return;
  busyPath.value = item.path;
  actionHint.value = null;
  try {
    const result = await inbox.convert([item.path]);
    if (result.queued.length) {
      notify.success(item.capability === 'video' ? '已交给中枢提炼视频' : '已交给中枢转换');
      setHint(
        'info',
        item.capability === 'video'
          ? '已交给中枢提炼，完成后自动刷新'
          : '已交给中枢转换，完成后自动刷新'
      );
      expectConversion();
    } else if (result.skipped.length) {
      const reason = result.skipped[0].reason;
      setHint('error', '无法转换：' + reason);
      notify.error('无法转换：' + reason);
    }
  } catch (error: any) {
    const message = errText(error);
    setHint('error', '转换失败：' + message);
    notify.error(message);
  } finally {
    busyPath.value = '';
  }
}

async function adoptItem(item: InboxItem | null): Promise<void> {
  if (!item || busyPath.value === item.path) return;
  if (item.status !== 'converted') return;
  const ok = await confirmDialog({
    title: '入库',
    message:
      '「' + cardTitle(item) + '」转换出的 Markdown 会进入知识库：入库后成为可检索、可引用的内容。原件仍留在收集箱。',
    confirmText: '入库',
  });
  if (!ok) return;
  busyPath.value = item.path;
  actionHint.value = null;
  try {
    const result = await inbox.adopt(item.path);
    app.bumpSidebar();
    haptic('success');
    // 入库后条目会离开「待整理 · 已转换」：必须说清它去了「已入库」分类，用户才不会以为内容丢了
    notify.success('已入库到 ' + result.pagePath + '（可在「已入库」分类回看）');
  } catch (error: any) {
    const message = errText(error);
    setHint('error', '入库失败：' + message);
    notify.error(message);
  } finally {
    busyPath.value = '';
  }
}

async function startAgent(item: InboxItem | null): Promise<void> {
  if (!item || busyPath.value === item.path) return;
  busyPath.value = item.path;
  actionHint.value = null;
  try {
    const { sessionId } = await inbox.agentTask(item.path);
    notify.success('已让 Agent 开始处理…');
    await openSession(sessionId);
  } catch (error: any) {
    const message = errText(error);
    setHint('error', '无法让 Agent 处理：' + message);
    notify.error(message);
  } finally {
    busyPath.value = '';
  }
}

/** 服务端 DELETE 回执不带回收站 id：删完按原路径到回收站里找这次删除的条目，撤销要用 */
async function trashIdFor(path: string): Promise<string> {
  try {
    const { data } = await api.get('/api/trash');
    const list: any[] = Array.isArray(data?.items) ? data.items : [];
    const matches = list
      .filter((entry) => entry?.originalPath === path && typeof entry?.id === 'string')
      .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
    return matches.length ? String(matches[0].id) : '';
  } catch {
    return '';
  }
}

async function undoTrash(trashId: string): Promise<void> {
  try {
    await api.post('/api/trash/restore', { ids: [trashId] });
    await inbox.load();
    haptic('success');
    notify.success('已恢复到收集箱');
  } catch (error: any) {
    notify.error('撤销失败：' + errText(error) + '（可到 设置 → 存储空间 → 回收站 恢复）');
  }
}

/**
 * 移入回收站 + 可撤销提示。左滑是加速动作，误滑的兜底交给同一屏的 Snackbar（4 秒内可撤销）；
 * 按钮 / 详情路径仍保留确认框，两条路最终都走这里。
 */
async function trashItem(item: InboxItem): Promise<void> {
  if (busyPath.value === item.path) return;
  busyPath.value = item.path;
  actionHint.value = null;
  try {
    await inbox.remove(item.path);
    haptic('warning');
    const trashId = await trashIdFor(item.path);
    if (!trashId) {
      notify.success('已移入回收站');
      return;
    }
    pushToast({
      kind: 'success',
      text: '已移入回收站',
      duration: 4000,
      // 整条 toast 可点 = 点「撤销」按钮之外的任意位置也撤销（手机上小按钮热区不够大的兜底）
      clickable: true,
      actions: [{ label: '撤销', primary: true, onClick: () => { void undoTrash(trashId); } }],
    });
  } catch (error: any) {
    const message = errText(error);
    setHint('error', '移入回收站失败：' + message);
    notify.error(message);
  } finally {
    busyPath.value = '';
  }
}

async function removeItem(item: InboxItem | null): Promise<void> {
  if (!item || busyPath.value === item.path) return;
  const ok = await confirmDialog({
    title: '移入回收站',
    message: '「' + cardTitle(item) + '」将被移入回收站，可随时恢复。',
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok) return;
  await trashItem(item);
}

/** 左滑：不做二次确认，直接进回收站，用 Snackbar 的撤销兜底 */
function removeBySwipe(item: InboxItem): void {
  void trashItem(item);
}

/* ===== 批量操作（选择态底栏） =====
 * 服务端只提供了批量转换（/api/inbox/convert 收 paths 数组）与单条入库/删除，
 * 所以批量入库 =「已转换的逐条 adopt + 待整理的整批 convert」，批量回收站逐条 remove；
 * 每一步都记失败原因，结束时统一 toast + 页内提示，不让一条失败默默吞掉整批。 */

/** 当前选中的条目（按 path 从可见列表里取，避免刷新后对象引用失效） */
function selectedItems(): InboxItem[] {
  const selected = new Set(selectedPaths.value);
  return selectableItems.value.filter((item) => selected.has(item.path));
}

/** 一次把本次删除的 path 对应到回收站条目 id（批量撤销用；DELETE 回执不带 id） */
async function trashIdsFor(paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  try {
    const { data } = await api.get('/api/trash');
    const list: any[] = Array.isArray(data?.items) ? data.items : [];
    const wanted = new Set(paths);
    return list
      .filter((entry) => wanted.has(entry?.originalPath) && typeof entry?.id === 'string')
      .map((entry) => String(entry.id));
  } catch {
    return [];
  }
}

async function undoTrashMany(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await api.post('/api/trash/restore', { ids });
    await inbox.load();
    haptic('success');
    notify.success('已恢复 ' + ids.length + ' 条');
  } catch (error: any) {
    notify.error('撤销失败：' + errText(error) + '（可到 设置 → 存储空间 → 回收站 恢复）');
  }
}

/** 批量入库：已转换的串行入库，待整理的整批交给中枢转换，其余留待逐条处理 */
async function batchAdopt(): Promise<void> {
  if (batchBusy.value) return;
  const items = selectedItems();
  if (!items.length) return;
  const adoptable = items.filter((item) => item.status === 'converted');
  const convertible = items.filter(
    (item) =>
      item.status !== 'converted' &&
      item.status !== 'converting' &&
      item.status !== 'adopted' &&
      isServerConvertible(item.capability),
  );
  const skipped = items.length - adoptable.length - convertible.length;
  if (!adoptable.length && !convertible.length) {
    setHint('info', '选中的 ' + items.length + ' 条都不能直接入库：需要逐条打开详情（让 Agent 处理 / 下载 / 等转换完成）');
    return;
  }
  batchBusy.value = 'adopt';
  actionHint.value = null;
  batchProgress.value = { done: 0, total: adoptable.length + convertible.length };
  const failures: string[] = [];
  let adopted = 0;
  let queued = 0;
  for (const item of adoptable) {
    try {
      await inbox.adopt(item.path);
      adopted += 1;
    } catch (error: any) {
      failures.push(cardTitle(item) + '：' + errText(error));
    }
    batchProgress.value = { done: batchProgress.value.done + 1, total: batchProgress.value.total };
  }
  if (convertible.length) {
    try {
      const result = await inbox.convert(convertible.map((item) => item.path));
      queued = result.queued.length;
      if (result.skipped.length) {
        failures.push('转换跳过 ' + result.skipped.length + ' 条：' + result.skipped[0].reason);
      }
      if (result.queued.length) expectConversion();
    } catch (error: any) {
      failures.push('提交转换失败：' + errText(error));
    }
    batchProgress.value = { done: batchProgress.value.done + convertible.length, total: batchProgress.value.total };
  }
  batchBusy.value = '';
  if (adopted) {
    app.bumpSidebar();
    haptic('success');
  }
  const parts: string[] = [];
  if (adopted) parts.push('已入库 ' + adopted + ' 条');
  if (queued) parts.push('已交给中枢转换 ' + queued + ' 条');
  if (skipped) parts.push(skipped + ' 条留待逐条处理');
  if (failures.length) parts.push(failures.length + ' 条失败');
  if (parts.length) {
    if (failures.length) notify.error(failures.length + ' 条失败：' + parts.join(' · '));
    else notify.success(parts.join(' · '));
  }
  if (failures.length) {
    setHint('error', '批量入库有失败：' + failures.slice(0, 3).join('；') + (failures.length > 3 ? '…' : ''));
  }
  exitSelectMode();
}

/** 批量回收站：逐条移入（服务端没有批量删除接口），删除后一次找回 id 供 Snackbar 撤销 */
async function batchTrash(): Promise<void> {
  if (batchBusy.value) return;
  const items = selectedItems();
  if (!items.length) return;
  const ok = await confirmDialog({
    title: '批量移入回收站',
    message: '选中的 ' + items.length + ' 条将移入回收站，可随时恢复。',
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok) return;
  batchBusy.value = 'trash';
  actionHint.value = null;
  batchProgress.value = { done: 0, total: items.length };
  const removed: string[] = [];
  const failures: string[] = [];
  for (const item of items) {
    try {
      await inbox.remove(item.path);
      removed.push(item.path);
    } catch (error: any) {
      failures.push(cardTitle(item) + '：' + errText(error));
    }
    batchProgress.value = { done: batchProgress.value.done + 1, total: batchProgress.value.total };
  }
  batchBusy.value = '';
  if (removed.length) {
    haptic('warning');
    const ids = await trashIdsFor(removed);
    if (ids.length) {
      pushToast({
        kind: 'success',
        text: '已移入回收站 ' + removed.length + ' 条',
        duration: 4000,
        clickable: true,
        actions: [{ label: '撤销', primary: true, onClick: () => { void undoTrashMany(ids); } }],
      });
    } else {
      notify.success('已移入回收站 ' + removed.length + ' 条');
    }
  }
  if (failures.length) {
    setHint('error', '批量移入回收站有失败：' + failures.slice(0, 3).join('；') + (failures.length > 3 ? '…' : ''));
    notify.error(failures.length + ' 条移入回收站失败');
  }
  exitSelectMode();
}

function downloadUrl(item: InboxItem): string {
  return '/api/inbox/download?path=' + encodeURIComponent(item.path);
}

async function openOriginal(item: InboxItem | null): Promise<void> {
  if (!item) return;
  const bridge = (window as any).wikiDesktop;
  if (bridge?.openInboxFile) {
    try {
      const result = await bridge.openInboxFile(item.path);
      if (result && result.ok === false) notify.error('打不开：' + (result.error || '系统程序调用失败'));
    } catch (error: any) {
      notify.error(error?.message || '打不开：系统程序调用失败');
    }
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = downloadUrl(item);
  anchor.download = item.name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  notify.success('已开始下载原文件');
}

async function runMain(item: InboxItem | null): Promise<void> {
  if (!item) return;
  const kind = mainKind(item);
  if (kind === 'convert' || kind === 'retry') {
    await convertItem(item);
  } else if (kind === 'adopt') {
    await adoptItem(item);
  } else if (kind === 'review') {
    await openReview(item);
  } else if (kind === 'process') {
    if (item.assistantSessionId) await openSession(item.assistantSessionId);
  } else if (kind === 'agent') {
    await startAgent(item);
  } else if (kind === 'download') {
    await openOriginal(item);
  }
}

/* ===== 分组批量操作 ===== */

async function convertGroup(group: SourceGroup): Promise<void> {
  if (groupBusy.value) return;
  const paths = group.convertible.map((item) => item.path);
  if (!paths.length) return;
  groupBusy.value = group.key;
  actionHint.value = null;
  try {
    const result = await inbox.convert(paths);
    if (result.queued.length) {
      notify.success('已交给中枢处理 ' + result.queued.length + ' 条');
      setHint('info', result.queued.length + ' 条已交给中枢处理，完成后自动刷新。');
      expectConversion();
    }
    if (result.skipped.length) {
      const first = result.skipped[0];
      const message = '跳过 ' + result.skipped.length + ' 条：' + first.path + '（' + first.reason + '）';
      setHint('error', message);
      notify.error(message);
    }
  } catch (error: any) {
    const message = errText(error);
    setHint('error', '批量转换失败：' + message);
    notify.error(message);
  } finally {
    groupBusy.value = '';
  }
}

async function adoptGroup(group: SourceGroup): Promise<void> {
  if (groupBusy.value) return;
  const targets = group.converted.slice();
  if (!targets.length) return;
  const ok = await confirmDialog({
    title: '全部入库',
    message:
      '「' + group.label + '」里的 ' + targets.length + ' 条已转换产物会进入知识库，成为可检索、可引用的内容；原件仍留在收集箱。',
    confirmText: '全部入库',
  });
  if (!ok) return;
  groupBusy.value = group.key;
  actionHint.value = null;
  let saved = 0;
  let failed = 0;
  for (const item of targets) {
    try {
      await inbox.adopt(item.path);
      saved += 1;
    } catch {
      failed += 1;
    }
  }
  groupBusy.value = '';
  app.bumpSidebar();
  if (saved) {
    haptic('success');
    notify.success('已入库 ' + saved + ' 条');
  }
  if (failed) {
    setHint('error', failed + ' 条入库失败，可逐条重试');
    notify.error(failed + ' 条入库失败');
  }
}

/* ===== 手势：右滑主操作 / 左滑移入回收站；纵向滚动交还浏览器 ===== */

const SWIPE_X = 64;
/** 轴锁：横向位移要明显大于纵向（1.3 倍）才接管，否则判成纵向滚动交给浏览器 */
const AXIS_LOCK_RATIO = 1.3;
const DRAG_START_PX = 8;

/** x = 已接管横向拖动；scroll = 判成纵向滚动，后续 move 一律放行 */
type DragAxis = '' | 'x' | 'scroll';

const dragging = ref(false);
const dragAxis = ref<DragAxis>('');
const dragX = ref(0);
const flyOut = ref<'' | 'main'>('');
const stamp = computed<{ tone: StampTone; icon: string; text: string } | null>(() => {
  if (!dragging.value || dragAxis.value !== 'x' || !front.value) return null;
  if (dragX.value > 24) return { tone: 'in', icon: 'check', text: mainLabel(front.value) };
  if (dragX.value < -24) return { tone: 'drop', icon: 'trash', text: '移入回收站' };
  return null;
});

let pointerStart: { x: number; y: number; id: number } | null = null;
let suppressClick = false;
/** 长按计时的 handler / 是否已经触发过长按 / 按下的是哪一条 */
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
let longPressPath = '';
/** 安卓返回键：弹层开着时先关弹层，别让一次返回直接退到后台 */
let stopBackHandler: (() => void) | null = null;

function onCardPointerDown(event: PointerEvent): void {
  // 选择态与手势互斥：多选列表里不做滑动，避免误触把条目滑走
  if (selectMode.value) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a')) return;
  if (busyPath.value) return;
  pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  dragging.value = false;
  dragAxis.value = '';
  dragX.value = 0;
  flyOut.value = '';
  suppressClick = false;
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    /* 个别 WebView 不支持指针捕获：不捕获也能用，只是拖出卡片后事件可能中断 */
  }
  startLongPress();
}

function onCardPointerMove(event: PointerEvent): void {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  // 已经判成纵向滚动：不再干预，让浏览器/卡片区自己滚
  if (dragAxis.value === 'scroll') return;
  const dx = event.clientX - pointerStart.x;
  const dy = event.clientY - pointerStart.y;
  // 手指一移动就说明不是「按住不动」：长按取消，避免滑一半掉进选择态
  if (Math.abs(dx) > LONG_PRESS_MOVE_PX || Math.abs(dy) > LONG_PRESS_MOVE_PX) cancelLongPress();
  if (!dragAxis.value) {
    if (Math.abs(dx) < DRAG_START_PX && Math.abs(dy) < DRAG_START_PX) return;
    // 纵向（含上滑）一律放行：卡片不跟手，手指按在卡片上也能上下滚页面
    if (Math.abs(dx) <= Math.abs(dy) * AXIS_LOCK_RATIO) {
      dragAxis.value = 'scroll';
      suppressClick = true;
      return;
    }
    dragAxis.value = 'x';
    dragging.value = true;
  }
  dragX.value = dx;
}

function releaseCardPointer(event: PointerEvent): void {
  try {
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  } catch {
    /* 捕获早已释放时忽略 */
  }
}

function resetDrag(): void {
  dragging.value = false;
  dragAxis.value = '';
  dragX.value = 0;
}

function cancelLongPress(): void {
  if (!longPressTimer) return;
  clearTimeout(longPressTimer);
  longPressTimer = null;
}

/** 按下即起计时；移动超过 LONG_PRESS_MOVE_PX、抬手或 pointercancel 都会清掉 */
function startLongPress(): void {
  cancelLongPress();
  longPressFired = false;
  longPressPath = front.value?.path || '';
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const path = longPressPath;
    if (!path || !pointerStart || dragging.value || busyPath.value) return;
    const item = inbox.items.find((entry) => entry.path === path) || front.value;
    if (!item) return;
    longPressFired = true;
    suppressClick = true;
    enterSelectMode(item);
  }, LONG_PRESS_MS);
}

/** 长按松手后的 spurious click 守卫：pointerup/cancel 后再多等 400ms */
function armSelectClickGuard(): void {
  selectGuardUntil = Date.now() + 400;
  selectGuardCleanup?.();
  const release = () => {
    selectGuardUntil = Date.now() + 400;
    selectGuardCleanup?.();
  };
  const remove = () => {
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', release, true);
    if (selectGuardCleanup === remove) selectGuardCleanup = null;
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  selectGuardCleanup = remove;
}

/** 进入选择态：轻振一下 + 默认选中长按的那条；卡片堆换成整列可见条目 */
function enterSelectMode(item: InboxItem): void {
  cancelLongPress();
  armSelectClickGuard();
  resetDrag();
  pointerStart = null;
  suppressClick = true;
  batchProgress.value = { done: 0, total: 0 };
  selectedPaths.value = [item.path];
  selectMode.value = true;
  actionHint.value = null;
  haptic('tap');
}

/** 退出选择态：清空选中与批量进度，卡片台原样回来 */
function exitSelectMode(): void {
  if (!selectMode.value) return;
  selectMode.value = false;
  selectedPaths.value = [];
  batchBusy.value = '';
  batchProgress.value = { done: 0, total: 0 };
}

function onCardPointerUp(event: PointerEvent): void {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  releaseCardPointer(event);
  cancelLongPress();
  const item = front.value;
  const wasDragging = dragging.value;
  const dx = dragX.value;
  pointerStart = null;
  // 已经进过选择态：这次抬手只是长按结束，不触发滑动/点按
  if (longPressFired) {
    longPressFired = false;
    resetDrag();
    suppressClick = true;
    return;
  }
  if (!wasDragging || !item) {
    resetDrag();
    return;
  }
  suppressClick = true;
  resetDrag();
  if (dx >= SWIPE_X) {
    const kind = mainKind(item);
    if (kind === 'adopt') {
      void adoptItem(item);
      return;
    }
    if (kind === 'none') {
      setHint('error', '这条没有可直接执行的主操作，点开详情处理');
      return;
    }
    if (kind === 'process' && !item.assistantSessionId) {
      setHint('info', '中枢正在处理，完成后会自动刷新');
      return;
    }
    flyOut.value = 'main';
    window.setTimeout(() => {
      flyOut.value = '';
      void runMain(item);
    }, 280);
    return;
  }
  if (dx <= -SWIPE_X) {
    removeBySwipe(item);
  }
}

function onCardPointerCancel(): void {
  cancelLongPress();
  longPressFired = false;
  pointerStart = null;
  resetDrag();
  suppressClick = false;
}

function onCardClick(): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (selectMode.value) return;
  openDetail(front.value);
}

function onCardEnter(): void {
  openDetail(front.value);
}

function cardClasses(item: InboxItem, index: number): Record<string, boolean> {
  if (index === 0) return { front: true, 'is-converting': item.status === 'converting' };
  return index === 1 ? { 'back-1': true } : { 'back-2': true };
}

function cardStyle(index: number) {
  if (index !== 0) return undefined;
  if (dragging.value) {
    return {
      transform: 'translate(' + dragX.value + 'px, 0) rotate(' + dragX.value * 0.035 + 'deg)',
      transition: 'none',
    };
  }
  if (flyOut.value === 'main') {
    return {
      transform: 'translate(130%, -10px) rotate(10deg)',
      opacity: '0',
      transition: 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.28s ease',
    };
  }
  return undefined;
}

/* ===== 详情 sheet ===== */

const detailPath = ref('');
const detailItem = computed<InboxItem | null>(() => {
  if (!detailPath.value) return null;
  return inbox.items.find((item) => item.path === detailPath.value) || null;
});

function openDetail(item: InboxItem | null): void {
  if (!item) return;
  detailPath.value = item.path;
}

function closeDetail(): void {
  detailPath.value = '';
}

function detailAction(action: () => void | Promise<void>): void {
  closeDetail();
  void action();
}

function detailRun(item: InboxItem | null): void {
  detailAction(() => runMain(item));
}

function detailProcess(item: InboxItem | null): void {
  const sessionId = item?.assistantSessionId;
  if (!sessionId) return;
  detailAction(() => openSession(sessionId));
}

function detailAgent(item: InboxItem | null): void {
  detailAction(() => startAgent(item));
}

function detailOriginal(item: InboxItem | null): void {
  detailAction(() => openOriginal(item));
}

function detailRemove(item: InboxItem | null): void {
  detailAction(() => removeItem(item));
}

/** 详情里的视频字段单独取：模板里不做「可选属性套可选属性」的收窄 */
function hasVideo(item: InboxItem | null): boolean {
  return Boolean(item?.video);
}

function videoPlatformOf(item: InboxItem | null): string {
  return item?.video ? platformLabel(item.video.platform) : '';
}

function videoLinkOf(item: InboxItem | null): string {
  return item?.video?.link || '';
}

/* ===== 转换产物预览 =====
 * 已转换 / 已入库的条目都要能看见「提炼出来的是什么」：手机此前只有一行路径文字，没有入口。
 * 正文走 /api/inbox/derived（Android 本地服务窄代理到中枢），渲染用零依赖的 renderMarkdown。 */
const reviewItem = ref<InboxItem | null>(null);
const reviewLoading = ref(false);
const reviewError = ref('');
const reviewHtml = ref('');
/** 快速连点两份产物时只认最后一次请求的结果 */
let reviewSeq = 0;

const reviewTitle = computed(() => reviewItem.value?.derivedPath?.split('/').pop() || '转换产物');
const reviewCanAdopt = computed(
  () => Boolean(reviewItem.value && reviewItem.value.status === 'converted' && !busyPath.value)
);

/** 有没有可看的产物（已转换 / 已入库都要能在详情里打开） */
function hasProduct(item: InboxItem | null): boolean {
  return Boolean(item?.derivedPath);
}

/** 列表行第二行：入库写清落到知识库哪一篇，已转换写清产物文件名（不再只有一句「已处理」） */
function rowDest(item: InboxItem): string {
  if (item.status === 'adopted') return item.adoptedPath ? '已入库到 ' + item.adoptedPath : '已入库，可在知识库检索';
  if (item.status === 'converted') return item.derivedPath ? '产物：' + fileName(item.derivedPath) : '已生成 Markdown 产物，可入库';
  return '';
}

/** 产物正文去掉 YAML frontmatter：来源 / 日期 / id 这些元信息详情里已经写了，正文里再铺一遍只是噪音 */
function stripFrontmatter(markdown: string): string {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return text;
  const rest = text.slice(end + 4);
  return rest.startsWith('\n') ? rest.slice(1) : rest;
}

async function openReview(item: InboxItem | null): Promise<void> {
  if (!item || !item.derivedPath || busyPath.value === item.path) return;
  const seq = ++reviewSeq;
  reviewItem.value = item;
  reviewHtml.value = '';
  reviewError.value = '';
  reviewLoading.value = true;
  try {
    const derived = await inbox.loadDerived(item.path);
    if (seq !== reviewSeq) return;
    reviewHtml.value = renderMarkdown(stripFrontmatter(derived.markdown || ''));
    reviewLoading.value = false;
  } catch (error: any) {
    if (seq !== reviewSeq) return;
    reviewLoading.value = false;
    reviewError.value = errText(error);
  }
}

function closeReview(): void {
  reviewSeq += 1;
  reviewItem.value = null;
  reviewHtml.value = '';
  reviewError.value = '';
  reviewLoading.value = false;
}

function detailReview(item: InboxItem | null): void {
  detailAction(() => openReview(item));
}

function adoptFromReview(): void {
  const item = reviewItem.value;
  if (!item) return;
  closeReview();
  void adoptItem(item);
}

/* ===== 分享落袋回执（/inbox?capture=<时间戳>，由原生分享桥推入） ===== */

const captureOpen = ref(false);
const captureItem = ref<InboxItem | null>(null);
const captureBusy = ref(false);

/* ===== 手动补录（分享之外的入口） ===== */
const intakeOpen = ref(false);
const intakeBusy = ref(false);
const intakeUrl = ref('');
const intakeFileInput = ref<HTMLInputElement | null>(null);

function closeIntake(): void {
  intakeOpen.value = false;
}

function pickIntakeFiles(): void {
  intakeFileInput.value?.click();
}

async function onIntakePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (!files || !files.length) return;
  intakeBusy.value = true;
  actionHint.value = null;
  try {
    const result = await inbox.upload(files);
    if (result.saved) notify.success('已收入收集箱 ' + result.saved + ' 项');
    if (result.skipped.length) setHint('error', '部分文件没存进去：' + result.skipped[0]);
    else intakeOpen.value = false;
  } catch (error: any) {
    setHint('error', '保存失败：' + errText(error));
  } finally {
    intakeBusy.value = false;
    input.value = '';
  }
}

async function submitIntakeUrl(): Promise<void> {
  const url = intakeUrl.value.trim();
  if (!url) return;
  intakeBusy.value = true;
  actionHint.value = null;
  try {
    await inbox.fetchUrl(url);
    intakeUrl.value = '';
    intakeOpen.value = false;
    notify.success('已收入收集箱');
  } catch (error: any) {
    setHint('error', '保存失败：' + errText(error));
  } finally {
    intakeBusy.value = false;
  }
}

const receiptSubline = computed(() => {
  const item = captureItem.value;
  if (!item) return '分享已收到，正在同步收集箱…';
  const source = sourceLabel(item);
  const type = typeLabel(item);
  const kind = source === type ? source : source + ' · ' + type;
  return (isFresh(item) ? '刚刚' : fromNow(item.mtime)) + ' · ' + kind;
});

function captureQueryOn(): boolean {
  // 分享桥用时间戳而不是固定 1：已经停在 /inbox 时再次分享也能触发一次回执
  return route.query.capture !== undefined;
}

async function openCaptureReceipt(forceLoad: boolean): Promise<void> {
  captureOpen.value = true;
  if (forceLoad || !inbox.loaded) await inbox.load();
  const list = [...inbox.activeItems].sort((a, b) => b.mtime - a.mtime);
  captureItem.value = list[0] || null;
}

function clearCaptureQuery(): void {
  if (route.query.capture === undefined) return;
  const query = { ...route.query };
  delete query.capture;
  void router.replace({ path: route.path, query });
}

function dismissCapture(where: 'inbox' | 'home'): void {
  captureOpen.value = false;
  clearCaptureQuery();
  if (where === 'home') void router.push('/');
}

async function undoCapture(): Promise<void> {
  const item = captureItem.value;
  if (!item || captureBusy.value) return;
  captureBusy.value = true;
  try {
    await inbox.remove(item.path);
    notify.success('已撤销这次保存');
    captureOpen.value = false;
    clearCaptureQuery();
  } catch (error: any) {
    const message = errText(error);
    setHint('error', '撤销失败：' + message);
    notify.error('撤销失败，请稍后重试');
  } finally {
    captureBusy.value = false;
  }
}

function goHome(): void {
  void router.push('/');
}

/* ===== 生命周期 ===== */

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (captureOpen.value) {
    dismissCapture('inbox');
    return;
  }
  if (reviewItem.value) {
    closeReview();
    return;
  }
  if (detailPath.value) {
    closeDetail();
    return;
  }
  // 选择态是页面级模式：Esc 先退出多选，不顺手把人踢回首页
  if (selectMode.value && !batchBusy.value) exitSelectMode();
}

watch(
  () => route.query.capture,
  (value) => {
    if (value !== undefined) void openCaptureReceipt(true);
    else captureOpen.value = false;
  }
);

onMounted(async () => {
  document.addEventListener('keydown', onDocKeydown);
  window.addEventListener('resize', syncShellInset);
  window.visualViewport?.addEventListener('resize', syncShellInset);
  stopBackHandler = registerBackHandler(() => {
    if (intakeOpen.value) {
      closeIntake();
      return true;
    }
    if (captureOpen.value) {
      dismissCapture('inbox');
      return true;
    }
    if (reviewItem.value) {
      closeReview();
      return true;
    }
    if (detailPath.value) {
      closeDetail();
      return true;
    }
    if (selectMode.value) {
      // 批量请求还在飞时不退出：否则界面切回卡片台，操作结果没地方展示
      if (!batchBusy.value) exitSelectMode();
      return true;
    }
    return false;
  });
  await inbox.load();
  syncPolling();
  syncShellInset();
  if (captureQueryOn()) await openCaptureReceipt(false);
});

onBeforeUnmount(() => {
  disposed = true;
  cancelLongPress();
  selectGuardCleanup?.();
  selectGuardCleanup = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  stopBackHandler?.();
  stopBackHandler = null;
  window.removeEventListener('resize', syncShellInset);
  window.visualViewport?.removeEventListener('resize', syncShellInset);
  document.removeEventListener('keydown', onDocKeydown);
});
</script>

<style scoped>
/*
 * 手机端收集箱卡片台。视觉沿用 Engram 设计令牌：暖纸底、纯白卡片、Engram Blue，
 * 不引外部图片；封面全部用 CSS 渐变 + 线性图标。
 *
 * 尺寸自查：宽度 360px（360×640 机）下卡片、底部三个 48px 按钮、分组卡不换行错位；
 * 高度按 360×640 的约 504px 可用区压缩——封面 96、卡片错位 32、留白收紧，保证
 * 「三个动作按钮 + 手势提示」首屏完整可见。卡片区自己滚，动作条钉在底栏上方。
 *
 * 多选：长按卡片 500ms 进选择态（卡片堆换成整列条目），选中行背景用 --accent-soft；
 * 勾选框视觉 24px、::after 补到 44px 命中区；批量动作条沿用 48px 按钮高度。
 */
.mob-inbox {
  position: relative;
  display: flex;
  flex-direction: column;
  /*
   * 高度吃满 Home .content 的内容盒（.content 已经让开底栏）：底部动作条因此天然落在
   * 底栏上方，只有卡片区（.mi-stage）自己滚，动作条不跟着卡片走。--mi-shell-extra 是
   * 底栏实际高度比 .content 下内边距更高时由脚本补的让位（脚本见 syncShellInset）。
   */
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 8px 14px calc(4px + var(--mi-shell-extra, 0px));
  color: var(--text);
  background-color: var(--bg);
  background-image:
    radial-gradient(520px 260px at 92% -8%, var(--accent-soft), transparent 70%),
    radial-gradient(420px 240px at -8% 6%, var(--warn-soft), transparent 72%);
  font-size: 14px;
  line-height: 1.5;
}

/* ===== 头部 ===== */
.mi-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: none;
  padding: 0 2px;
}

.mi-head-main {
  flex: 1;
  min-width: 0;
}

.mi-title {
  margin: 0;
  font-size: 23px;
  line-height: 1.18;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.mi-sub {
  margin: 3px 0 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.mi-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.mi-iconbtn {
  width: 44px;
  height: 44px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
  color: var(--text-secondary);
  transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease;
}

.mi-iconbtn:active {
  transform: scale(0.94);
  background: var(--bg-secondary);
  color: var(--text);
}

.mi-iconbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== 提示条 ===== */
.mi-banner {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  flex: none;
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 11px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.5;
}

.mi-banner svg {
  flex: none;
  margin-top: 1px;
}

.mi-banner span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.mi-banner button {
  position: relative;
  flex: none;
  min-height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: inherit;
}

/* 视觉尺寸不动，::after 把命中区补到 44px（触屏最小热区） */
.mi-banner button::after {
  content: '';
  position: absolute;
  left: -8px;
  right: -8px;
  top: -10px;
  bottom: -10px;
}

.mi-banner.error {
  background: var(--danger-soft);
  color: var(--danger);
}

.mi-banner.info {
  background: var(--accent-soft);
  color: var(--text-secondary);
}

.mi-banner.info svg {
  color: var(--accent);
}

/* ===== 分组入口 ===== */
.mi-groups-entry {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  width: 100%;
  margin-top: 8px;
  padding: 5px 10px 5px 8px;
  border: 1px solid var(--accent-border, rgba(43, 92, 230, 0.3));
  border-radius: 12px;
  background: var(--accent-soft);
  text-align: left;
  transition: background 0.14s ease;
}

/* 一行 38px 高：用伪元素把热区补到 44px */
.mi-groups-entry::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -4px;
  bottom: -4px;
}

.mi-groups-entry:active {
  background: var(--bg-tertiary);
}

.mi-groups-ic {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
}

.mi-groups-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text);
}

.mi-groups-text b {
  color: var(--accent);
  font-weight: 650;
}

.mi-groups-go {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
}

/* ===== 卡片堆 ===== */
.mi-stage {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 卡片区自己滚：纵向手势（touch-action: pan-y）滚这里，底部动作条不跟着走 */
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 2px;
}

.mi-stack {
  position: relative;
  display: block;
  width: 100%;
  /* 空间富余时（412×915）卡片整体竖向居中；溢出时 auto 外边距归零、顶部对齐 */
  margin-top: auto;
  /* 后面两张卡向下错开露边，这里给它们留出高度（与 back-2 的 30px 错位对齐） */
  margin-bottom: 32px;
  /* 纵向滚动交还浏览器（pan-y）；横向拖动由卡片自己接管 */
  touch-action: pan-y;
}

.mi-card {
  position: relative;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}

.mi-card.front {
  z-index: 3;
  cursor: pointer;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  animation: mi-deal 0.36s cubic-bezier(0.22, 1, 0.36, 1);
}

.mi-card.back-1 {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100%;
  z-index: 2;
  transform: translateY(16px) scale(0.96);
  transform-origin: top center;
  box-shadow: var(--shadow-raised);
  pointer-events: none;
}

.mi-card.back-2 {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100%;
  z-index: 1;
  transform: translateY(30px) scale(0.925);
  transform-origin: top center;
  box-shadow: var(--shadow-raised);
  pointer-events: none;
}

@keyframes mi-deal {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 背面卡只当"厚度"用：正文隐藏，露出的始终是同一条白色圆角边 */
.mi-card.back-1 .mi-card-body,
.mi-card.back-2 .mi-card-body {
  visibility: hidden;
}

/* 封面：类型渐变色 + 大号扩展名 / 平台名 + 线性图标，全部本地绘制 */
.mi-cover {
  position: relative;
  height: 96px;
  flex: none;
  background: var(--cov-bg, var(--bg-tertiary));
  color: var(--cov-fg, var(--text));
}

.mi-cover::after,
.mi-receipt-cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.16) 0 1px, transparent 1px 12px),
    radial-gradient(120% 90% at 82% 8%, rgba(255, 255, 255, 0.3), transparent 62%);
  opacity: 0.9;
  pointer-events: none;
}

.mi-cover-kicker {
  position: absolute;
  left: 13px;
  top: 11px;
  z-index: 2;
  max-width: calc(100% - 96px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cov-kicker, var(--cov-fg, var(--text)));
}

.mi-cover-big {
  position: absolute;
  left: 12px;
  bottom: 9px;
  z-index: 2;
  max-width: calc(100% - 96px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 30px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.mi-cover-icon {
  position: absolute;
  right: 12px;
  bottom: 8px;
  z-index: 2;
  opacity: var(--cov-icon-opacity, 0.5);
}

.mi-cover-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  height: 3px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.35);
}

.mi-cover-progress i {
  display: block;
  width: 42%;
  height: 100%;
  background: var(--accent);
  animation: mi-progress 1.4s ease-in-out infinite;
}

@keyframes mi-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(320%);
  }
}

/* 封面配色：每类只给两个自定义属性，卡片与回执小封面共用 */
.cov-article {
  --cov-bg: linear-gradient(150deg, #f3e8d5, #dcc9ad 55%, #c6ad8a);
  --cov-fg: #4b3a24;
}

.cov-doc {
  --cov-bg: linear-gradient(145deg, #e2ebfb, #aec9ef 55%, #6e9bd8);
  --cov-fg: #1e3d66;
}

.cov-sheet {
  --cov-bg: linear-gradient(145deg, #e0f0e6, #a9d6bb 55%, #5aa97e);
  --cov-fg: #14472c;
}

.cov-slide {
  --cov-bg: linear-gradient(145deg, #fbe9dc, #f2c3a0 55%, #d98a5c);
  --cov-fg: #5a2d12;
}

.cov-pdf {
  --cov-bg: linear-gradient(145deg, #fbe3df, #eeb0a9 55%, #d06a60);
  --cov-fg: #5a1913;
}

.cov-image {
  --cov-bg: linear-gradient(145deg, #ddf1ee, #a9d6d0 55%, #5aa9a4);
  --cov-fg: #14463f;
}

.cov-web {
  --cov-bg: linear-gradient(145deg, #e2e8ff, #b9c8f7 55%, #7d99e8);
  --cov-fg: #1e3a78;
}

.cov-audio {
  --cov-bg: linear-gradient(145deg, #e9e2f7, #c4b3e6 55%, #8f74c4);
  --cov-fg: #3a2260;
}

.cov-bili {
  --cov-bg: linear-gradient(145deg, #ffd9e3, #f6a2ba 52%, #d94a72);
  --cov-fg: #5c1631;
}

.cov-douyin {
  --cov-bg: linear-gradient(160deg, #2a2c3a, #161823 58%, #3a2530);
  --cov-fg: #ffffff;
  --cov-kicker: rgba(255, 255, 255, 0.78);
  --cov-icon-opacity: 0.34;
}

.cov-video {
  --cov-bg: linear-gradient(160deg, #2e2740, #1b1726 58%, #3a2f52);
  --cov-fg: #f2ecff;
  --cov-kicker: rgba(242, 236, 255, 0.78);
  --cov-icon-opacity: 0.36;
}

.cov-archive {
  --cov-bg: linear-gradient(145deg, #eceae6, #d6d2ca 55%, #b3ada2);
  --cov-fg: #3d3a34;
}

.cov-other {
  --cov-bg: linear-gradient(145deg, #f0eeeb, #e0dcd6 55%, #c9c3ba);
  --cov-fg: #3d3a34;
}

/* 卡面 */
.mi-card-body {
  display: flex;
  flex-direction: column;
  padding: 8px 14px 10px;
}

.mi-card-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.mi-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.mi-status i {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}

.mi-status.pending {
  background: var(--warn-soft);
  /* --warn 在 warn-soft 上约 4.35:1，小字换深一档的 --warning */
  color: var(--warning);
}

.mi-status.converting {
  background: var(--accent-soft);
  color: var(--accent);
}

.mi-status.converting i {
  animation: mi-pulse 1.2s ease-in-out infinite;
}

.mi-status.converted {
  background: var(--success-soft);
  color: var(--success);
}

.mi-status.adopted {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.mi-status.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

@keyframes mi-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.75);
  }
}

.mi-fresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 650;
  white-space: nowrap;
}

.mi-time {
  margin-left: auto;
  flex: none;
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.mi-card-title {
  margin: 5px 0 0;
  font-size: 16.5px;
  line-height: 1.35;
  font-weight: 650;
  letter-spacing: -0.01em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.mi-card-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.mi-card-note svg {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}

.mi-card-note span {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.mi-card-note.error {
  color: var(--danger);
}

.mi-card-note.error svg {
  color: var(--danger);
}

.mi-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.mi-meta-item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 拖拽时的印章：右滑主操作 / 左滑回收站两种语气 */
.mi-stamp {
  position: absolute;
  left: 16px;
  top: 16px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border: 2px solid currentColor;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
  transform: rotate(-10deg);
  box-shadow: 0 6px 18px rgba(29, 27, 23, 0.16);
}

.mi-stamp.is-in {
  color: var(--success);
}

.mi-stamp.is-drop {
  color: var(--danger);
}

.mi-gesture {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  margin-bottom: auto;
  padding: 0 4px;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--text-secondary);
  text-align: center;
}

.mi-gesture svg {
  flex: none;
}

/* ===== 长按多选：选择态列表 + 批量动作条 =====
 * 勾选框视觉 24px（行高 64px，整行可点），::after 再把命中区补到 44px；
 * 选中即变，不给背景加过渡（动效克制）。 */
.mi-head-select {
  align-items: center;
  gap: 10px;
}

.mi-head-select .mi-title {
  font-size: 19px;
}

.mi-select-cancel,
.mi-select-all {
  flex: none;
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border-radius: 12px;
  color: var(--accent);
  font-size: 14px;
  font-weight: 600;
}

.mi-select-cancel:active,
.mi-select-all:active {
  background: var(--accent-soft);
}

.mi-select-cancel:disabled,
.mi-select-all:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mi-select-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 2px 6px;
}

.mi-select-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 64px;
  padding: 10px 12px;
  border-radius: 14px;
  color: var(--text);
  text-align: left;
}

.mi-select-row + .mi-select-row {
  margin-top: 6px;
}

/* 选中态行背景用 accent-soft（设计稿 batch-row.is-on） */
.mi-select-row.is-on {
  background: var(--accent-soft);
}

.mi-select-row:active {
  background: var(--bg-hover);
}

.mi-select-row:disabled {
  opacity: 0.6;
}

.mi-checkbox {
  position: relative;
  align-self: flex-start;
  width: 24px;
  height: 24px;
  margin-top: 6px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
  color: transparent;
}

.mi-checkbox.is-on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}

/* 24px 的勾选框：伪元素把命中区补到 44px（视觉尺寸不变） */
.mi-checkbox::after {
  content: '';
  position: absolute;
  top: -10px;
  bottom: -10px;
  left: -10px;
  right: -10px;
}

.mi-select-thumb {
  width: 40px;
  height: 40px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--cov-bg, var(--bg-tertiary));
  color: var(--cov-fg, var(--text));
}

.mi-select-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mi-select-main b {
  font-size: 14px;
  font-weight: 550;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.mi-select-main small {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.mi-select-note {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 2px 2px 0;
  padding: 4px 6px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.mi-select-note svg {
  flex: none;
  margin-top: 1px;
}

/* ===== 底部操作（手势的无障碍替代）：固定在底栏上方，不随卡片滚动 ===== */
.mi-bar {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr) auto;
  gap: 8px;
  flex: none;
  margin-top: 4px;
  padding: 4px 2px 0;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.mi-bar-main {
  min-width: 0;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  overflow: hidden;
  border-radius: 13px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  box-shadow: 0 10px 22px -14px rgba(43, 92, 230, 0.7);
  transition: background 0.14s ease, transform 0.12s ease;
}

.mi-bar-main:active {
  transform: scale(0.985);
  background: var(--accent-hover);
}

.mi-bar-main:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}

.mi-bar-sub {
  min-width: 0;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  background: var(--card-bg);
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
}

.mi-bar-sub:active {
  background: var(--bg-secondary);
}

.mi-bar-sub:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mi-bar-danger {
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 10px;
  border-radius: 13px;
  color: var(--danger);
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
}

.mi-bar-danger:active {
  background: var(--danger-soft);
}

.mi-bar-danger:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 选择态底栏：入库（主）/ 打标签 / 回收站 三键等宽分配 */
.mi-bar-select {
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
}

/* 分组视图底部只放「逐条看 / 刷新」两个动作 */
.mi-bar-groups {
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  margin-top: 4px;
  padding-top: 4px;
}

/* ===== 分组视图 ===== */
.mi-groups-note {
  flex: none;
  margin: 8px 2px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.mi-groups {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  padding: 0 2px 6px;
  overflow-x: hidden;
  overflow-y: auto;
}

.mi-group {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
}

.mi-group-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

.mi-group-ic {
  width: 30px;
  height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}

.mi-group-name {
  flex: 1;
  min-width: 0;
}

.mi-group-name h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  line-height: 1.3;
}

.mi-group-name p {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.mi-group-count {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}

.mi-group-items {
  list-style: none;
  display: grid;
  gap: 3px;
  margin: 8px 0 0;
  padding: 0;
}

.mi-group-items li {
  position: relative;
  padding-left: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.mi-group-items li::before {
  content: '';
  position: absolute;
  left: 1px;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--border-strong);
}

.mi-group-items li.mi-more {
  padding-left: 0;
  color: var(--text-faint);
}

.mi-group-items li.mi-more::before {
  display: none;
}

.mi-group-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.mi-group-note {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.mi-group-btns {
  flex: none;
  display: flex;
  gap: 6px;
}

.mi-mini {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--card-bg);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}

/* 30px 的视觉高度，热区靠 ::after 补到 44px */
.mi-mini::after {
  content: '';
  position: absolute;
  left: -4px;
  right: -4px;
  top: -7px;
  bottom: -7px;
}

.mi-mini.primary {
  border-color: var(--accent-border, rgba(43, 92, 230, 0.3));
  background: var(--accent-soft);
  color: var(--accent);
}

.mi-mini.success {
  border-color: transparent;
  background: var(--success);
  color: #ffffff;
}

.mi-mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== 空态 / 加载 ===== */
.mi-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.mi-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 18px 8px;
  text-align: center;
}

.mi-zero {
  width: 96px;
  height: 96px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
  border-radius: 50%;
  background: var(--success-soft);
  color: var(--success);
}

.mi-empty h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.mi-empty p {
  max-width: 310px;
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.mi-stats {
  display: flex;
  width: 100%;
  max-width: 330px;
  margin-top: 14px;
  padding: 13px 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
}

.mi-stat {
  flex: 1;
  min-width: 0;
  text-align: center;
}

.mi-stat + .mi-stat {
  border-left: 1px solid var(--border);
}

.mi-stat b {
  display: block;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.mi-stat span {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.mi-empty-btn {
  min-width: 180px;
  height: 46px;
  margin-top: 16px;
  border-radius: 13px;
  font-size: 15px;
  justify-content: center;
}

/* ===== 底部 sheet（详情 / 分享回执） ===== */
.mi-dim {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: rgba(20, 18, 15, 0.42);
  animation: mi-fade 0.2s ease both;
}

.mi-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: calc(var(--z-overlay) + 1);
  max-height: 86dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 16px calc(18px + var(--safe-bottom));
  border-radius: 24px 24px 0 0;
  background: var(--card-bg);
  box-shadow: 0 -18px 60px -20px rgba(20, 18, 15, 0.35);
  animation: mi-sheet-up 0.34s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.mi-sheet-grab {
  width: 38px;
  height: 4px;
  margin: 4px auto 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 18%, transparent);
}

@keyframes mi-sheet-up {
  from {
    transform: translateY(105%);
  }
  to {
    transform: translateY(0);
  }
}

@keyframes mi-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 详情 */
.mi-detail-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.mi-detail-head-main {
  flex: 1;
  min-width: 0;
}

.mi-detail-head-main h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.mi-detail-head-main p {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.mi-detail-rows {
  display: grid;
  gap: 1px;
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--border);
  overflow: hidden;
}

.mi-detail-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 11px;
  background: var(--bg-secondary);
  font-size: 12.5px;
  line-height: 1.45;
}

.mi-detail-row > span {
  flex: none;
  width: 68px;
  color: var(--text-secondary);
}

.mi-detail-row b {
  flex: 1;
  min-width: 0;
  font-weight: 550;
  color: var(--text);
}

.mi-detail-row b.mi-wrap {
  word-break: break-all;
  overflow-wrap: anywhere;
}

.mi-detail-row b a {
  color: var(--accent);
  word-break: break-all;
}

.mi-detail-row.error,
.mi-detail-row.error b {
  color: var(--danger);
}

.mi-detail-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.mi-detail-primary {
  width: 100%;
  height: 46px;
  border-radius: 12px;
  justify-content: center;
  font-size: 14.5px;
}

.mi-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.mi-detail-grid .btn {
  min-height: 44px;
  height: auto;
  padding: 8px 10px;
  border-radius: 11px;
  justify-content: center;
  font-size: 13px;
  line-height: 1.3;
  white-space: normal;
  text-align: center;
}

.mi-detail-grid .btn.danger {
  color: var(--danger);
}

/* ===== 状态分类（待整理 · 已转换 / 待整理 / 已转换 / 已入库） =====
 * 横向滚动的一排胶囊，计数与筛选写在一起（与桌面工作台同一口径）；
 * 「已入库」不再是从手机界面里看不到的隐藏分类。 */
/* 四档分类必须「一眼全在」：小屏自动换行，不靠横向滑动藏起「已入库」 */
.mi-filters {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 4px;
  padding: 2px;
}

.mi-filter {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.mi-filter.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.mi-filter-n {
  min-width: 21px;
  height: 21px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 650;
  line-height: 21px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.mi-filter.on .mi-filter-n {
  background: var(--accent);
  color: var(--on-accent);
}

/* ===== 整列条目列表（其余条目 / 已转换 / 已入库） ===== */
.mi-list {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 2px 8px;
  overflow-x: hidden;
  overflow-y: auto;
  touch-action: pan-y;
}

.mi-queue {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.mi-queue-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 0 4px;
}

.mi-queue-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.mi-queue-head span {
  font-size: 11.5px;
  color: var(--text-secondary);
}

.mi-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 64px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
  color: var(--text);
  text-align: left;
  transition: background 0.14s ease, transform 0.12s ease;
}

.mi-row:active {
  transform: scale(0.99);
  background: var(--bg-secondary);
}

.mi-row-thumb {
  width: 42px;
  height: 42px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--cov-bg, var(--bg-tertiary));
  color: var(--cov-fg, var(--text));
}

.mi-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mi-row-main b {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.mi-row-main small {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mi-row-main small.mi-row-dest {
  color: var(--accent);
}

.mi-row-go {
  flex: none;
  color: var(--text-secondary);
}

/* ===== 转换产物预览 ===== */
.mi-review {
  display: flex;
  flex-direction: column;
  max-height: 88dvh;
  overflow: hidden;
}

.mi-review-body {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-secondary);
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.mi-review-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 28px 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.mi-review-state.error {
  color: var(--danger);
}

.mi-review-md {
  padding: 14px 13px 18px;
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.mi-review-md :deep(> :first-child) {
  margin-top: 0;
}

.mi-review-md :deep(h2),
.mi-review-md :deep(h3),
.mi-review-md :deep(h4) {
  margin: 18px 0 8px;
  line-height: 1.35;
}

.mi-review-md :deep(p) {
  margin: 0 0 10px;
}

.mi-review-md :deep(ul),
.mi-review-md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 20px;
}

.mi-review-md :deep(li) {
  margin: 3px 0;
}

.mi-review-md :deep(blockquote) {
  margin: 0 0 10px;
  padding: 4px 12px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}

.mi-review-md :deep(table) {
  width: 100%;
  margin: 0 0 12px;
  border-collapse: collapse;
  font-size: 12.5px;
}

.mi-review-md :deep(th),
.mi-review-md :deep(td) {
  padding: 5px 8px;
  border: 1px solid var(--border-strong);
  text-align: left;
}

.mi-review-md :deep(pre) {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  overflow-x: auto;
}

.mi-review-md :deep(code) {
  font-size: 12.5px;
}

.mi-review-md :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}

.mi-review-md :deep(a) {
  color: var(--accent);
}

.mi-review-actions {
  flex: none;
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.mi-review-actions .btn {
  flex: 1;
  min-height: 46px;
  border-radius: 12px;
  justify-content: center;
  font-size: 14px;
}

/* 分享落袋回执 */
.mi-receipt-head {
  display: flex;
  align-items: center;
  gap: 11px;
}

.mi-check {
  width: 42px;
  height: 42px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--success-soft);
  color: var(--success);
}

.mi-receipt-title {
  flex: 1;
  min-width: 0;
}

.mi-receipt-title h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  line-height: 1.3;
}

.mi-receipt-title p {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.mi-receipt-card {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 9px 10px;
  border-radius: 12px;
  background: var(--bg-secondary);
}

.mi-receipt-cover {
  position: relative;
  width: 56px;
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 10px;
  background: var(--cov-bg, var(--bg-tertiary));
  color: var(--cov-fg, var(--text));
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.mi-receipt-cover::after {
  border-radius: 10px;
}

.mi-receipt-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mi-receipt-card-main b {
  font-size: 13.5px;
  font-weight: 650;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.mi-receipt-card-main span {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mi-receipt-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 14px 12px;
  border-radius: 12px;
  background: var(--bg-secondary);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.mi-receipt-queue {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 11px;
  border-radius: 11px;
  background: var(--accent-soft);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.mi-receipt-queue svg {
  flex: none;
  color: var(--accent);
}

.mi-receipt-queue b {
  color: var(--accent);
  font-weight: 650;
}

.mi-receipt-note {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.mi-receipt-actions {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.mi-receipt-actions .btn {
  width: 100%;
  height: 46px;
  border-radius: 12px;
  justify-content: center;
  font-size: 14.5px;
}

.mi-receipt-undo {
  position: relative;
  display: block;
  width: 100%;
  margin-top: 10px;
  padding: 8px 0;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
  text-align: center;
}

.mi-receipt-undo::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -6px;
  bottom: -6px;
}

.mi-receipt-undo:active {
  background: var(--bg-hover);
}

.mi-receipt-undo:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 深色主题：强调色在 accent-soft 底上只有 4.49:1，小字统一提亮一档到可读阈值以上 */
html.dark .mi-fresh,
html.dark .mi-mini.primary,
html.dark .mi-status.converting,
html.dark .mi-groups-go,
html.dark .mi-groups-text b,
html.dark .mi-group-count,
html.dark .mi-receipt-queue b {
  color: #9cc4ff;
}

html.dark .mi-groups-entry {
  background: var(--accent-soft);
}

html.dark .mi-mini.success {
  color: #0d1f0b;
}

/* 极窄屏：底部三个按钮的文案不再挤在一行 */
/* ===== 手动补录 sheet ===== */
.mi-file-input { display: none; }

.mi-intake {
  padding-bottom: calc(22px + var(--safe-bottom));
}

.mi-intake-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.mi-intake-head h2 {
  flex: 1;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.mi-intake-file {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 12px 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-secondary);
  text-align: left;
}

.mi-intake-file:active { transform: scale(0.995); }

.mi-intake-ic {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 11px;
  background: var(--accent-soft);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mi-intake-file-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mi-intake-file-text b { font-size: 14px; font-weight: 650; }
.mi-intake-file-text small { font-size: 11.5px; line-height: 1.45; color: var(--text-secondary); }

.mi-intake-url {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.mi-intake-url input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: var(--bg-secondary);
  font-size: 13.5px;
}

.mi-intake-url input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.mi-intake-url .btn { height: 44px; border-radius: 11px; }

.mi-intake-note {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 10px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.mi-intake-note .ic { flex: none; margin-top: 2px; }

@media (max-width: 640px) {
  .mi-bar {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }

  .mi-bar-main {
    font-size: 14px;
  }

  .mi-bar-sub,
  .mi-bar-danger {
    font-size: 12.5px;
  }
}
</style>
