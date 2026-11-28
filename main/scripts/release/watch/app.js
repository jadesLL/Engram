(() => {
  const $ = (id) => document.getElementById(id);
  const STATUS_TEXT = {
    running: '运行中',
    success: '成功',
    failure: '失败',
    queued: '排队中',
    cancelled: '已取消',
    skipped: '已跳过',
    unknown: '未知',
  };
  const PHASE_ICON = { success: '✓', failure: '✕', running: '●', pending: '○', skipped: '–' };

  let state = null;
  let collapsed = new Set();
  let pinnedRunId = null;
  let fullLogMode = false;
  let fullLogLines = null;
  let follow = true;
  let fetching = false;
  let timer = null;
  let lastLogKey = '';
  let lastPhaseKey = '';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtDuration(ms, { zeroAs = '0s' } = {}) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    const total = Math.max(0, Math.round(ms / 1000));
    if (total === 0 && zeroAs) return zeroAs;
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtClock(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function stepState(step) {
    if (step.status === 'completed') {
      if (step.conclusion === 'skipped') return 'skipped';
      if (step.conclusion === 'failure' || step.conclusion === 'cancelled') return 'failure';
      return 'success';
    }
    return step.status || 'pending';
  }

  function phaseStatusClass(status) {
    return `status-${status || 'pending'}`;
  }

  function renderHero() {
    const local = state.local || {};
    const run = state.run;
    const pill = $('status-pill');
    const title = $('hero-title');
    const meta = $('hero-meta');

    pill.className = 'pill';
    if (!run) {
      title.textContent = `v${local.version || '?'} · 暂无 Release 运行`;
      meta.textContent = `${local.branch || '—'} · ${local.head || '—'} · ${local.repoRoot || ''}`;
      pill.textContent = '未运行';
      $('hero-progress').textContent = '触发标签后这里会显示阶段时间线';
      $('hero-eta').textContent = '';
      $('bar-fill').style.width = '0%';
      $('bar-fill').style.background = 'var(--line-strong)';
      $('run-meta').textContent = '';
      return;
    }

    const status = run.conclusion || 'unknown';
    const label = STATUS_TEXT[status] || status;
    pill.classList.add(status);
    pill.textContent = label;

    const isRelease = String(run.path || '').startsWith('release.yml@');
    title.textContent = `${run.tag || `v${local.version || '?'}`} · ${isRelease ? 'Release' : 'CI'} #${run.id}`;

    const bits = [];
    if (run.headSha) bits.push(`提交 ${run.headSha.slice(0, 8)}`);
    if (run.runner) bits.push(`runner ${run.runner}`);
    if (run.startedAt) bits.push(`开始 ${fmtClock(run.startedAt)}`);
    if (run.attempt && run.attempt > 1) bits.push(`第 ${run.attempt} 次尝试`);
    if (run.event) bits.push(run.event);
    meta.textContent = bits.join(' · ');
    meta.title = run.path || '';

    const progress = state.progress || { total: 0, completed: 0, failed: 0 };
    const percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
    const fill = $('bar-fill');
    fill.style.width = `${percent}%`;
    fill.style.background =
      status === 'failure' ? 'var(--bad)' : status === 'running' ? 'var(--ink)' : status === 'success' ? 'var(--ok)' : 'var(--line-strong)';

    const progressBits = [`${progress.completed}/${progress.total} 步`];
    if (progress.failed) progressBits.push(`${progress.failed} 步失败`);
    $('hero-progress').textContent = progressBits.join(' · ');

    if (status === 'running') {
      const eta = state.eta;
      const elapsed = run.startedAt ? fmtDuration(Date.now() - Date.parse(run.startedAt)) : fmtDuration(run.durationMs);
      const remaining = eta ? `预计剩余 ~${fmtDuration(eta.remainingMs)}` : '预计剩余 —';
      const basis = eta
        ? eta.basis === 'history'
          ? '按最近发版校准'
          : eta.basis === 'mixed'
            ? '部分按历史校准'
            : '按经验估算'
        : '';
      $('hero-eta').textContent = `已跑 ${elapsed} · ${remaining}${basis ? `（${basis}）` : ''}`;
    } else {
      $('hero-eta').textContent = `总耗时 ${fmtDuration(run.durationMs)}`;
    }

    $('run-meta').textContent = run.path || '';
    $('run-meta').title = run.path || '';

    const link = $('gitea-link');
    if (run.htmlUrl) {
      link.href = run.htmlUrl;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  function renderBanners() {
    const wrap = $('banners');
    wrap.textContent = '';
    const items = [];
    for (const message of state.errors || []) items.push(['error', message]);
    const failed = [];
    for (const phase of state.phases || []) {
      for (const step of phase.steps || []) {
        if (stepState(step) === 'failure') failed.push(step.name);
      }
    }
    if (failed.length) items.push(['error', `失败步骤：${failed.join('、')}`]);
    for (const message of state.warnings || []) items.push(['warn', message]);
    for (const [kind, message] of items.slice(0, 4)) {
      wrap.append(el('div', `banner ${kind}`, message));
    }
    if (!items.length) wrap.hidden = true;
    else wrap.hidden = false;
  }

  function renderPhases() {
    const list = $('phases');
    const phases = state.phases || [];
    const phaseKey = phases.map((phase) => `${phase.id}:${phase.status}:${phase.steps.length}`).join('|');
    const runChanged = phaseKey !== lastPhaseKey;
    lastPhaseKey = phaseKey;

    // 新运行 / 第一次加载：默认全部展开
    if (runChanged && collapsed.size === 0 && phases.length) {
      collapsed = new Set();
    }
    list.textContent = '';
    const empty = $('timeline-empty');
    empty.hidden = Boolean(phases.length);
    if (!phases.length) {
      empty.innerHTML = state.run
        ? '运行已触发，等待 runner 接单与步骤上报…'
        : '没有找到 Release 运行。发版时推送标签后刷新：<code>git tag vX.Y.Z &amp;&amp; git push gitea vX.Y.Z</code>';
    }

    for (const phase of phases) {
      const item = el('li', `phase ${phaseStatusClass(phase.status)}`);
      if (!collapsed.has(phase.id)) item.classList.add('open');

      const row = el('button', 'phase-row');
      row.type = 'button';
      row.append(
        el('span', 'ico', PHASE_ICON[phase.status] || '○'),
        el('span', 'phase-label', phase.label),
        el('span', 'phase-hint', phase.hint || ''),
        el('span', 'phase-meta', `${phase.steps.length} 步 · ${fmtDuration(phase.durationMs)}`),
        el('span', 'chev', '›'),
      );
      row.addEventListener('click', () => {
        if (collapsed.has(phase.id)) collapsed.delete(phase.id);
        else collapsed.add(phase.id);
        item.classList.toggle('open');
        updateToggleAllLabel();
      });

      const steps = el('ul', 'steps');
      for (const step of phase.steps) {
        const status = stepState(step);
        const stepItem = el('li', `step ${phaseStatusClass(status)}`);
        const name = el('span', 'step-name', step.name);
        name.title = step.name;
        const durationText =
          status === 'skipped' || step.durationMs === null
            ? '—'
            : fmtDuration(step.durationMs, { zeroAs: '<1s' });
        const duration = el('span', 'step-dur', durationText);
        if (status === 'running' && step.startedAt) duration.dataset.liveStart = step.startedAt;
        stepItem.append(el('span', 'step-ico', PHASE_ICON[status] || '○'), name, duration);
        steps.append(stepItem);
      }
      item.append(row, steps);
      list.append(item);
    }
    updateToggleAllLabel();
  }

  function updateToggleAllLabel() {
    const phases = state?.phases || [];
    const allCollapsed = phases.length > 0 && phases.every((phase) => collapsed.has(phase.id));
    $('toggle-all').textContent = allCollapsed ? '展开全部' : '收起全部';
  }

  function renderLocal() {
    const wrap = $('local');
    wrap.textContent = '';
    const local = state.local || {};

    const versionRow = el('div', 'kv-row');
    const versionVal = el('div', 'kv-val');
    versionVal.append(document.createTextNode(local.version || '—'));
    versionVal.append(
      el(
        'span',
        `tag ${local.versionsConsistent ? 'ok' : 'bad'}`,
        local.versionsConsistent ? '三处一致' : '三处不一致',
      ),
    );
    versionVal.title = (local.versionSources || [])
      .map((source) => `${source.id}: ${source.version || source.error || '—'}`)
      .join('\n');
    versionRow.append(el('span', 'kv-key', '版本'), versionVal);

    const changelogRow = el('div', 'kv-row');
    const changelogVal = el('div', 'kv-val');
    const changelog = local.changelog;
    if (changelog) {
      changelogVal.append(document.createTextNode(`${changelog.total} 条`));
      const parts = Object.entries(changelog.byCategory || {})
        .filter(([category]) => category !== '内部')
        .map(([category, count]) => `${category} ${count}`);
      if (parts.length) {
        const small = el('span', 'muted');
        small.style.marginLeft = '6px';
        small.style.fontFamily = 'var(--sans)';
        small.style.fontSize = '11px';
        small.textContent = parts.join(' · ');
        changelogVal.append(small);
      }
      if (changelog.errors) changelogVal.append(el('span', 'tag bad', `${changelog.errors} 处格式错误`));
      else if (changelog.warnings) changelogVal.append(el('span', 'tag warn', `${changelog.warnings} 警告`));
    } else {
      changelogVal.append(document.createTextNode('未找到 CHANGELOG'));
    }
    changelogVal.title = local.changelogPath || '';
    changelogRow.append(el('span', 'kv-key', '未发布'), changelogVal);

    const branchRow = el('div', 'kv-row');
    const branchVal = el('div', 'kv-val');
    branchVal.append(document.createTextNode(`${local.branch || '—'} · ${local.head || '—'}`));
    if (local.dirty) branchVal.append(el('span', 'tag warn', `${local.dirty} 个未提交`));
    branchRow.append(el('span', 'kv-key', '分支'), branchVal);

    const tagRow = el('div', 'kv-row');
    const tagVal = el('div', 'kv-val');
    if (local.versionTag) {
      tagVal.append(document.createTextNode(local.versionTag));
      tagVal.append(
        el(
          'span',
          `tag ${local.tagExists ? 'ok' : ''}`,
          local.tagExists ? (local.tagAtHead ? '已在 HEAD' : '已创建') : '未打标签',
        ),
      );
    } else {
      tagVal.append(document.createTextNode('—'));
    }
    tagRow.append(el('span', 'kv-key', '标签'), tagVal);

    wrap.append(versionRow, changelogRow, branchRow, tagRow);
  }

  function renderAssets() {
    const wrap = $('assets');
    wrap.textContent = '';
    const release = state.release;
    if (!release) {
      wrap.classList.add('muted');
      wrap.textContent = state.run?.conclusion === 'running' ? 'Release 会在产物齐备后创建。' : '没有找到这个版本的 Release。';
      return;
    }
    wrap.classList.remove('muted');
    if (release.htmlUrl) {
      const link = el('a', 'release-link', '查看 Release ↗');
      link.href = release.htmlUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      wrap.append(link);
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (!assets.length) {
      const empty = el('div', 'muted', 'Release 暂无附件');
      wrap.append(empty);
      return;
    }
    for (const asset of assets) {
      const row = el('div', 'asset');
      const name = el('span', 'asset-name', asset.name || '—');
      name.title = asset.name || '';
      row.append(name, el('span', 'asset-size', fmtSize(asset.size)));
      wrap.append(row);
    }
  }

  function renderHistory() {
    const wrap = $('history');
    wrap.textContent = '';
    const history = state.history || [];
    if (!history.length) {
      wrap.classList.add('muted');
      wrap.textContent = '完成一次发版后自动记录耗时。';
      return;
    }
    wrap.classList.remove('muted');
    for (const item of history) {
      const row = el('button', 'history-row');
      row.type = 'button';
      const status = item.status === 'success' ? 'success' : item.status === 'failure' ? 'failure' : '';
      row.append(
        el('span', 'history-tag', item.tag || `#${item.id}`),
        el('span', `history-status ${status}`, STATUS_TEXT[item.status] || item.status || '—'),
        el('span', 'history-dur', fmtDuration(item.durationMs)),
      );
      row.title = `${fmtClock(item.startedAt)} → ${fmtClock(item.completedAt)}`;
      if (state.run && state.run.id === item.id) row.classList.add('active');
      row.addEventListener('click', () => {
        pinnedRunId = item.id;
        refresh(true);
      });
      wrap.append(row);
    }
  }

  function lineClass(line) {
    const text = String(line || '');
    if (/\b(FAIL|failed|failure|Error:|ERR_[A-Z]+|not ok)\b/.test(text) && !/\b0 (failed|errors?)\b/i.test(text)) {
      return 'bad';
    }
    if (/(✔|✓|\bPASS(ED)?\b|success|通过)/i.test(text)) return 'ok';
    if (/^(>>|::group::)/.test(text)) return 'accent';
    if (/^#\d+/.test(text)) return 'dim';
    if (/^::(endgroup|warning|error)/.test(text)) return 'meta';
    return '';
  }

  function currentLogLines() {
    if (fullLogMode && fullLogLines) return fullLogLines;
    return state?.log?.lines || [];
  }

  function renderLog(force = false) {
    const pre = $('log');
    const log = state?.log;
    if (!log && !fullLogMode) {
      pre.textContent = state?.run ? '运行还没有产生日志。' : '没有可显示的运行。';
      lastLogKey = '';
      return;
    }
    const lines = currentLogLines();
    const key = `${log?.jobId || 0}:${log?.totalLines || 0}:${fullLogMode ? 'full' : 'tail'}:${lines.length}`;
    if (!force && key === lastLogKey) return;
    lastLogKey = key;
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const span = el('span', `ln ${lineClass(line)}`, line);
      fragment.append(span, document.createTextNode('\n'));
    }
    pre.textContent = '';
    pre.append(fragment);
    if (follow) pre.scrollTop = pre.scrollHeight;
  }

  function render() {
    if (!state) return;
    renderHero();
    renderBanners();
    renderPhases();
    renderLocal();
    renderAssets();
    renderHistory();
    renderLog();
    $('latest-run').hidden = !pinnedRunId;
    const brandSub = $('brand-sub');
    const repo = state.repo || {};
    const repoLabel = repo.owner && repo.name ? `${repo.owner}/${repo.name}` : '未知仓库';
    brandSub.textContent = `${repoLabel} · ${state.generatedAt ? fmtClock(state.generatedAt) : ''}`;
    brandSub.title = repo.giteaUrl || '';
  }

  function tick() {
    document.querySelectorAll('[data-live-start]').forEach((node) => {
      const start = Date.parse(node.dataset.liveStart);
      if (Number.isFinite(start)) node.textContent = fmtDuration(Date.now() - start);
    });
  }

  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    const delay = state?.run?.status === 'in_progress' ? 3000 : 10000;
    timer = setTimeout(() => refresh(false), delay);
  }

  async function refresh(manual = false) {
    if (fetching) return;
    fetching = true;
    $('poll').textContent = manual ? '刷新中…' : $('poll').textContent;
    try {
      const params = new URLSearchParams();
      if (pinnedRunId) params.set('run', pinnedRunId);
      const response = await fetch(`/api/state${params.toString() ? `?${params}` : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state = await response.json();
      fullLogLines = null;
      if (!fullLogMode) lastLogKey = '';
      render();
      $('poll').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    } catch (err) {
      $('poll').textContent = '连接失败，稍后重试';
      if (!state) {
        $('hero-title').textContent = '连接失败';
        $('hero-meta').textContent = err.message;
      }
    } finally {
      fetching = false;
      schedule();
    }
  }

  $('refresh').addEventListener('click', () => refresh(true));
  $('latest-run').addEventListener('click', () => {
    pinnedRunId = null;
    refresh(true);
  });
  $('toggle-all').addEventListener('click', () => {
    const phases = state?.phases || [];
    const allCollapsed = phases.length > 0 && phases.every((phase) => collapsed.has(phase.id));
    collapsed = allCollapsed ? new Set() : new Set(phases.map((phase) => phase.id));
    renderPhases();
  });
  $('follow').addEventListener('change', (event) => {
    follow = event.target.checked;
    if (follow) {
      const pre = $('log');
      pre.scrollTop = pre.scrollHeight;
    }
  });
  // 手动往上翻日志时自动取消跟随，滚回底部再恢复
  $('log').addEventListener('scroll', () => {
    const pre = $('log');
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    if (nearBottom !== follow) {
      follow = nearBottom;
      $('follow').checked = nearBottom;
    }
  });
  $('full-log').addEventListener('click', async () => {
    const button = $('full-log');
    if (fullLogMode) {
      fullLogMode = false;
      lastLogKey = '';
      button.textContent = '完整日志';
      renderLog(true);
      return;
    }
    const jobId = state?.log?.jobId;
    if (!jobId) return;
    button.disabled = true;
    button.textContent = '加载中…';
    try {
      const response = await fetch(`/api/log?job=${jobId}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      fullLogLines = text.split(/\r?\n/).filter((line) => line !== '');
      fullLogMode = true;
      lastLogKey = '';
      button.textContent = '回到日志尾';
      renderLog(true);
    } catch (err) {
      button.textContent = '加载失败';
      setTimeout(() => {
        button.textContent = '完整日志';
      }, 1500);
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh(false);
  });
  setInterval(tick, 1000);
  refresh(true);
})();
