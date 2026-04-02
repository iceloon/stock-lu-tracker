const state = {
  autoTracking: null,
  latestSnapshot: null,
  snapshots: [],
  catalogPosts: [],
  selectedSnapshotId: null
};

const els = {
  autoConfigForm: document.getElementById("autoConfigForm"),
  runAutoSyncBtn: document.getElementById("runAutoSyncBtn"),
  runBackfillBtn: document.getElementById("runBackfillBtn"),
  loadCatalogBtn: document.getElementById("loadCatalogBtn"),
  importSelectedBtn: document.getElementById("importSelectedBtn"),
  catalogCheckAll: document.getElementById("catalogCheckAll"),
  viewLatestBtn: document.getElementById("viewLatestBtn"),
  autoSyncText: document.getElementById("autoSyncText"),
  latestSnapshotMeta: document.getElementById("latestSnapshotMeta"),
  masterRowsBody: document.getElementById("masterRowsBody"),
  syncLogsBody: document.getElementById("syncLogsBody"),
  catalogMeta: document.getElementById("catalogMeta"),
  catalogBody: document.getElementById("catalogBody"),
  snapshotHistoryMeta: document.getElementById("snapshotHistoryMeta"),
  snapshotHistoryBody: document.getElementById("snapshotHistoryBody")
};

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatNumber(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "-";
  }

  return num.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function monthLabelByDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthLabelFromTitleOrDate(title, postedAt) {
  const text = String(title || "");
  const matched = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
  if (matched) {
    const year = matched[1];
    const month = String(Number(matched[2])).padStart(2, "0");
    return `${year}-${month}`;
  }
  return monthLabelByDate(postedAt);
}

function normalizePostId(value) {
  return String(value || "").trim();
}

function getCatalogCheckboxes() {
  if (!els.catalogBody) {
    return [];
  }

  return Array.from(els.catalogBody.querySelectorAll("input[data-catalog-id]"));
}

function syncCatalogCheckAllState() {
  if (!els.catalogCheckAll) {
    return;
  }

  const selectable = getCatalogCheckboxes().filter((input) => !input.disabled);
  const selectedCount = selectable.filter((input) => input.checked).length;

  if (selectable.length === 0) {
    els.catalogCheckAll.checked = false;
    els.catalogCheckAll.indeterminate = false;
    els.catalogCheckAll.disabled = true;
    return;
  }

  els.catalogCheckAll.disabled = false;
  els.catalogCheckAll.checked = selectedCount > 0 && selectedCount === selectable.length;
  els.catalogCheckAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
}

function updateCatalogMeta() {
  if (!els.catalogMeta) {
    return;
  }

  const selectable = getCatalogCheckboxes().filter((input) => !input.disabled);
  const selectedCount = selectable.filter((input) => input.checked).length;
  els.catalogMeta.textContent = `共 ${state.catalogPosts.length} 条，可选 ${selectable.length} 条，已选 ${selectedCount} 条`;
}

function getViewingSnapshot() {
  if (state.selectedSnapshotId) {
    const hit = state.snapshots.find((item) => item.id === state.selectedSnapshotId);
    if (hit) {
      return hit;
    }
  }
  return state.latestSnapshot;
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error("无法连接本地服务，请确认 `npm start` 正在运行");
  }

  if (response.status === 401) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`/admin-login.html?next=${next}`);
    throw new Error("后台未登录或登录已过期，请重新登录");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }

  return data;
}

function setStatus(text, level = "info") {
  if (!els.autoSyncText) {
    return;
  }

  els.autoSyncText.textContent = text;
  els.autoSyncText.classList.remove("pos", "neg");
  if (level === "ok") {
    els.autoSyncText.classList.add("pos");
  }
  if (level === "err") {
    els.autoSyncText.classList.add("neg");
  }
}

function renderForm() {
  const config = state.autoTracking?.config;
  if (!config || !els.autoConfigForm) {
    return;
  }

  const setValue = (name, value) => {
    const input = els.autoConfigForm.elements?.[name];
    if (!input) {
      return;
    }
    input.value = value;
  };

  setValue("enabled", String(Boolean(config.enabled)));
  setValue("intervalMinutes", String(config.intervalMinutes || 180));
  setValue("maxPostsPerSource", String(config.maxPostsPerSource || 6));
  setValue("ocrEnabled", String(Boolean(config.ocrEnabled)));
  setValue("ocrMaxImagesPerPost", String(config.ocrMaxImagesPerPost || 1));
  setValue("pinnedPostUrls", Array.isArray(config.pinnedPostUrls) ? config.pinnedPostUrls.join("\n") : "");
  setValue("xueqiuTitleRegex", String(config.xueqiuTitleRegex || ""));
  setValue("backfillMaxPages", String(config.backfillMaxPages || 36));
  setValue("backfillPageSize", String(config.backfillPageSize || 20));
  setValue("keywords", Array.isArray(config.keywords) ? config.keywords.join(",") : "");

  const runtime = state.autoTracking?.runtime || {};
  const pinnedCount = Array.isArray(config.pinnedPostUrls) ? config.pinnedPostUrls.length : 0;
  const regexText = config.xueqiuTitleRegex ? ` / 标题规则:${config.xueqiuTitleRegex}` : "";
  const cookieText = `雪球Cookie:${config.hasXueqiuCookie ? "已配置" : "未配置"} / 微博Cookie:${
    config.hasWeiboCookie ? "已配置" : "未配置"
  } / 置顶链接:${pinnedCount}条${regexText}`;
  const runText = runtime.lastRunAt ? `最近执行: ${formatDateTime(runtime.lastRunAt)}` : "尚未执行";
  const errText = runtime.lastError ? ` | 最近错误: ${runtime.lastError}` : "";
  setStatus(`${cookieText} | ${runText}${errText}`, runtime.lastError ? "err" : "ok");
}

function renderSnapshot() {
  const snapshot = getViewingSnapshot();
  if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
    els.masterRowsBody.innerHTML = `<tr><td colspan="8" class="empty">暂无自动抓取到的持仓表。</td></tr>`;
    els.latestSnapshotMeta.textContent = "暂无抓取结果";
    return;
  }

  const sourceLabel = snapshot.source === "xueqiu" ? "雪球" : snapshot.source === "weibo" ? "微博" : snapshot.source;
  const monthLabel = monthLabelFromTitleOrDate(snapshot.title, snapshot.postedAt);
  const viewLabel = state.selectedSnapshotId ? "历史查看中" : "最新";
  els.latestSnapshotMeta.textContent = `${viewLabel} | ${monthLabel} | ${sourceLabel} | ${formatDateTime(
    snapshot.postedAt
  )} | ${snapshot.rows.length} 行`;

  const rows = snapshot.rows
    .map((item) => {
      const qtyRaw = Number.isFinite(Number(item.holdingQty))
        ? Number(item.holdingQty)
        : Number(item.changeQty) || 0;
      const costRaw = Number.isFinite(Number(item.referenceCost))
        ? Number(item.referenceCost)
        : Number(item.latestCost);
      const latestPriceRaw = Number.isFinite(Number(item.latestPrice)) ? Number(item.latestPrice) : null;
      const marketValueRaw = Number.isFinite(Number(item.marketValue)) ? Number(item.marketValue) : null;
      const floatingPnlRaw = Number.isFinite(Number(item.floatingPnl)) ? Number(item.floatingPnl) : null;
      const pnlPctRaw = Number.isFinite(Number(item.pnlPct)) ? Number(item.pnlPct) : null;

      const pnlClass = floatingPnlRaw > 0 ? "pos" : floatingPnlRaw < 0 ? "neg" : "";
      const pctClass = pnlPctRaw > 0 ? "pos" : pnlPctRaw < 0 ? "neg" : "";
      const qtyText = formatNumber(qtyRaw, 0);

      return `
        <tr>
          <td class="mono">${item.symbol || "-"}</td>
          <td>${item.name || "-"}</td>
          <td class="mono">${qtyText}</td>
          <td class="mono">¥ ${formatNumber(costRaw, 3)}</td>
          <td class="mono">${latestPriceRaw === null ? "-" : `¥ ${formatNumber(latestPriceRaw, 3)}`}</td>
          <td class="mono">${marketValueRaw === null ? "-" : `¥ ${formatNumber(marketValueRaw, 3)}`}</td>
          <td class="mono ${pnlClass}">${floatingPnlRaw === null ? "-" : `¥ ${formatNumber(floatingPnlRaw, 3)}`}</td>
          <td class="mono ${pctClass}">${pnlPctRaw === null ? "-" : formatNumber(pnlPctRaw, 3)}</td>
        </tr>
      `;
    })
    .join("");

  els.masterRowsBody.innerHTML = rows;
}

function renderLogs() {
  const logs = state.autoTracking?.recentLogs || [];
  if (!logs.length) {
    els.syncLogsBody.innerHTML = `<tr><td colspan="3" class="empty">暂无日志。</td></tr>`;
    return;
  }

  const rows = logs
    .slice(0, 20)
    .map((log) => {
      const level = String(log.level || "info").toUpperCase();
      const levelClass = level === "ERROR" ? "neg" : level === "WARN" ? "" : "pos";
      return `
        <tr>
          <td>${formatDateTime(log.createdAt)}</td>
          <td class="mono ${levelClass}">${level}</td>
          <td>${log.message || "-"}</td>
        </tr>
      `;
    })
    .join("");

  els.syncLogsBody.innerHTML = rows;
}

function renderCatalog() {
  if (!els.catalogBody || !els.catalogMeta) {
    return;
  }

  if (!state.catalogPosts.length) {
    els.catalogMeta.textContent = "未加载";
    els.catalogBody.innerHTML = `<tr><td colspan="6" class="empty">尚未抓取目录，点击“抓取全部月份目录”。</td></tr>`;
    if (els.catalogCheckAll) {
      els.catalogCheckAll.checked = false;
      els.catalogCheckAll.indeterminate = false;
      els.catalogCheckAll.disabled = true;
    }
    return;
  }

  const importedPostIds = new Set(
    (state.snapshots || []).map((item) => normalizePostId(item.postId)).filter(Boolean)
  );
  const rows = state.catalogPosts
    .map((item) => {
      const postId = normalizePostId(item.postId);
      const hasPostId = Boolean(postId);
      const imported = hasPostId && (Boolean(item.imported) || importedPostIds.has(postId));
      const statusText = !hasPostId ? "缺少帖子ID" : imported ? "已导入" : item.processed ? "已处理" : "未导入";
      const statusClass = imported ? "pos" : !hasPostId ? "neg" : "";
      const monthLabel = monthLabelFromTitleOrDate(item.title, item.postedAt);
      const safeTitle = item.title || "(无标题)";
      const checkboxAttrs = hasPostId ? `data-catalog-id="${postId}"` : "disabled";

      return `
        <tr>
          <td><input type="checkbox" ${checkboxAttrs} /></td>
          <td class="mono">${monthLabel}</td>
          <td>${safeTitle}</td>
          <td>${formatDateTime(item.postedAt)}</td>
          <td class="${statusClass}">${statusText}</td>
          <td>${item.link ? `<a href="${item.link}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
        </tr>
      `;
    })
    .join("");

  els.catalogBody.innerHTML = rows;
  syncCatalogCheckAllState();
  updateCatalogMeta();
}

function renderSnapshotHistory() {
  if (!els.snapshotHistoryBody || !els.snapshotHistoryMeta) {
    return;
  }

  const list = Array.isArray(state.snapshots) ? state.snapshots : [];
  if (list.length === 0) {
    els.snapshotHistoryMeta.textContent = "暂无";
    els.snapshotHistoryBody.innerHTML = `<tr><td colspan="5" class="empty">暂无历史快照。</td></tr>`;
    return;
  }

  const rows = list
    .map((item) => {
      const active = state.selectedSnapshotId === item.id;
      const monthLabel = monthLabelFromTitleOrDate(item.title, item.postedAt);
      return `
        <tr class="${active ? "row-selected" : ""}">
          <td class="mono">${monthLabel}</td>
          <td>${item.title || "-"}</td>
          <td>${formatDateTime(item.postedAt)}</td>
          <td class="mono">${Array.isArray(item.rows) ? item.rows.length : 0}</td>
          <td><button class="inline-btn" data-view-snapshot="${item.id}">查看</button></td>
        </tr>
      `;
    })
    .join("");

  els.snapshotHistoryBody.innerHTML = rows;
  els.snapshotHistoryMeta.textContent = `已导入 ${list.length} 条月份快照`;
}

function renderAll() {
  renderForm();
  renderSnapshot();
  renderLogs();
  renderCatalog();
  renderSnapshotHistory();
}

async function loadData() {
  const [autoData, snapshotsData] = await Promise.all([
    request("/api/auto-tracking"),
    request("/api/master-snapshots?limit=240")
  ]);

  state.autoTracking = autoData.autoTracking || null;
  state.latestSnapshot = autoData.latestSnapshot || null;
  state.snapshots = Array.isArray(snapshotsData.snapshots) ? snapshotsData.snapshots : [];

  if (state.selectedSnapshotId && !state.snapshots.some((item) => item.id === state.selectedSnapshotId)) {
    state.selectedSnapshotId = null;
  }

  renderAll();
}

async function fetchCatalog({ silent = false } = {}) {
  const pagesValue = Number(els.autoConfigForm?.elements?.backfillMaxPages?.value);
  const pageSizeValue = Number(els.autoConfigForm?.elements?.backfillPageSize?.value);

  const data = await request("/api/auto-tracking/catalog", {
    method: "POST",
    body: JSON.stringify({
      pages: Number.isFinite(pagesValue) ? pagesValue : undefined,
      pageSize: Number.isFinite(pageSizeValue) ? pageSizeValue : undefined
    })
  });

  state.catalogPosts = Array.isArray(data.posts) ? data.posts : [];
  renderCatalog();

  if (!silent) {
    setStatus(`目录抓取完成：${state.catalogPosts.length} 条月份帖子`, "ok");
  }
}

async function handleSaveConfig(event) {
  event.preventDefault();

  const formData = new FormData(els.autoConfigForm);
  const payload = Object.fromEntries(formData.entries());

  payload.enabled = String(payload.enabled) === "true";
  payload.ocrEnabled = String(payload.ocrEnabled) === "true";
  payload.intervalMinutes = Number(payload.intervalMinutes);
  payload.maxPostsPerSource = Number(payload.maxPostsPerSource);
  payload.ocrMaxImagesPerPost = Number(payload.ocrMaxImagesPerPost);
  payload.backfillMaxPages = Number(payload.backfillMaxPages);
  payload.backfillPageSize = Number(payload.backfillPageSize);

  const xueqiuCookie = String(payload.xueqiuCookie || "").trim();
  const weiboCookie = String(payload.weiboCookie || "").trim();

  if (!xueqiuCookie) {
    delete payload.xueqiuCookie;
  }
  if (!weiboCookie) {
    delete payload.weiboCookie;
  }

  try {
    setStatus("正在保存配置...", "info");
    await request("/api/auto-tracking/config", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await loadData();
    setStatus("配置保存成功", "ok");
  } catch (error) {
    setStatus(`保存失败: ${error.message}`, "err");
  }
}

async function handleRunNow() {
  try {
    setStatus("正在抓取...", "info");
    const res = await request("/api/auto-tracking/run", {
      method: "POST"
    });

    await loadData();
    const importedSnapshots = Number(res?.result?.importedSnapshots) || 0;
    const importedTrades = Number(res?.result?.importedTrades) || 0;
    const runError = res?.result?.error;

    if (runError) {
      setStatus(`抓取失败: ${runError}`, "err");
      return;
    }

    setStatus(`抓取完成：快照 ${importedSnapshots} 条，交易 ${importedTrades} 条`, "ok");
  } catch (error) {
    setStatus(`抓取失败: ${error.message}`, "err");
  }
}

async function handleRunBackfill() {
  try {
    const pagesValue = Number(els.autoConfigForm?.elements?.backfillMaxPages?.value);
    const pageSizeValue = Number(els.autoConfigForm?.elements?.backfillPageSize?.value);

    setStatus("正在回溯历史标题帖子并识别截图...", "info");
    const res = await request("/api/auto-tracking/backfill", {
      method: "POST",
      body: JSON.stringify({
        pages: Number.isFinite(pagesValue) ? pagesValue : undefined,
        pageSize: Number.isFinite(pageSizeValue) ? pageSizeValue : undefined
      })
    });

    await loadData();
    const importedSnapshots = Number(res?.result?.importedSnapshots) || 0;
    const importedTrades = Number(res?.result?.importedTrades) || 0;
    const runError = res?.result?.error;

    if (runError) {
      setStatus(`回溯失败: ${runError}`, "err");
      return;
    }

    setStatus(`回溯完成：快照 ${importedSnapshots} 条，交易 ${importedTrades} 条`, "ok");
  } catch (error) {
    setStatus(`回溯失败: ${error.message}`, "err");
  }
}

async function handleLoadCatalog() {
  try {
    setStatus("正在抓取全部月份目录...", "info");
    await fetchCatalog({ silent: true });
    setStatus(`目录抓取完成：${state.catalogPosts.length} 条月份帖子`, "ok");
  } catch (error) {
    setStatus(`目录抓取失败: ${error.message}`, "err");
  }
}

async function handleImportSelected() {
  try {
    const checked = Array.from(els.catalogBody?.querySelectorAll("input[data-catalog-id]:checked") || []);
    const postIds = [
      ...new Set(checked.map((item) => normalizePostId(item.dataset.catalogId)).filter(Boolean))
    ];

    if (postIds.length === 0) {
      setStatus("请先勾选要导入的月份帖子", "err");
      return;
    }

    const pagesValue = Number(els.autoConfigForm?.elements?.backfillMaxPages?.value);
    const pageSizeValue = Number(els.autoConfigForm?.elements?.backfillPageSize?.value);

    setStatus(`正在导入选中月份（${postIds.length} 条）...`, "info");
    const res = await request("/api/auto-tracking/import-selected", {
      method: "POST",
      body: JSON.stringify({
        postIds,
        pages: Number.isFinite(pagesValue) ? pagesValue : undefined,
        pageSize: Number.isFinite(pageSizeValue) ? pageSizeValue : undefined
      })
    });

    await loadData();
    if (state.catalogPosts.length > 0) {
      await fetchCatalog({ silent: true });
    }

    const importedSnapshots = Number(res?.result?.importedSnapshots) || 0;
    const importedTrades = Number(res?.result?.importedTrades) || 0;
    const runError = res?.result?.error;

    if (runError) {
      setStatus(`导入失败: ${runError}`, "err");
      return;
    }

    setStatus(`导入完成：快照 ${importedSnapshots} 条，交易 ${importedTrades} 条`, "ok");
  } catch (error) {
    setStatus(`导入失败: ${error.message}`, "err");
  }
}

function handleCatalogCheckAllChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const shouldCheck = target.checked;
  getCatalogCheckboxes()
    .filter((input) => !input.disabled)
    .forEach((input) => {
      input.checked = shouldCheck;
    });

  syncCatalogCheckAllState();
  updateCatalogMeta();
}

function handleCatalogBodyChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  if (!target.matches("input[data-catalog-id]")) {
    return;
  }

  syncCatalogCheckAllState();
  updateCatalogMeta();
}

function handleSnapshotTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest("[data-view-snapshot]");
  if (!button) {
    return;
  }

  const id = String(button.getAttribute("data-view-snapshot") || "").trim();
  if (!id) {
    return;
  }

  state.selectedSnapshotId = id;
  renderSnapshot();
  renderSnapshotHistory();
}

function handleViewLatestSnapshot() {
  state.selectedSnapshotId = null;
  renderSnapshot();
  renderSnapshotHistory();
}

function bindEvents() {
  if (els.autoConfigForm) {
    els.autoConfigForm.addEventListener("submit", handleSaveConfig);
  }

  if (els.runAutoSyncBtn) {
    els.runAutoSyncBtn.addEventListener("click", handleRunNow);
  }

  if (els.runBackfillBtn) {
    els.runBackfillBtn.addEventListener("click", handleRunBackfill);
  }

  if (els.loadCatalogBtn) {
    els.loadCatalogBtn.addEventListener("click", handleLoadCatalog);
  }

  if (els.importSelectedBtn) {
    els.importSelectedBtn.addEventListener("click", handleImportSelected);
  }

  if (els.catalogCheckAll) {
    els.catalogCheckAll.addEventListener("change", handleCatalogCheckAllChange);
  }

  if (els.catalogBody) {
    els.catalogBody.addEventListener("change", handleCatalogBodyChange);
  }

  if (els.snapshotHistoryBody) {
    els.snapshotHistoryBody.addEventListener("click", handleSnapshotTableClick);
  }

  if (els.viewLatestBtn) {
    els.viewLatestBtn.addEventListener("click", handleViewLatestSnapshot);
  }
}

async function bootstrap() {
  bindEvents();
  try {
    await loadData();
  } catch (error) {
    setStatus(`加载失败: ${error.message}`, "err");
  }
}

bootstrap();
