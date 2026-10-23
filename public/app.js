const storageKey = "jev.admin.password";
// 页面上的时间统一按北京时间显示，不随浏览器时区变化。
const TIME_ZONE = "Asia/Shanghai";
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let password = "";
let snapshot = null;
let deleteTarget = null;
let loading = false;
let bulkCheck = null;
const revealed = new Set();
const checking = new Set();

function authorization() {
  const bytes = new TextEncoder().encode(`admin:${password}`);
  return `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`;
}

function showLogin(message = "") {
  bulkCheck?.controller.abort();
  elements["bulk-check-status"].textContent = "";
  password = "";
  snapshot = null;
  revealed.clear();
  trend = null;
  trendRequest += 1;
  elements["trend-chart"].querySelector("svg")?.remove();
  elements["trend-summary"].textContent = "";
  elements["key-rows"].replaceChildren();
  elements["dashboard"].hidden = true;
  elements["logout-button"].hidden = true;
  elements["login-panel"].hidden = false;
  elements["login-error"].textContent = message;
  elements["password"].value = "";
  if (elements["delete-dialog"].open) elements["delete-dialog"].close();
}

async function request(path, options = {}) {
  const credential = password;
  const response = await fetch(path, { ...options, headers: { Authorization: authorization(), ...options.headers }, cache: "no-store" });
  if (password !== credential) throw new Error("登录状态已经更改，请重新登录。");
  if (response.status === 401) {
    localStorage.removeItem(storageKey);
    showLogin("管理密码不正确，请重新登录。");
    throw new Error("管理密码不正确，请重新登录。");
  }
  if (!response.ok) {
    const body = await response.json();
    throw Object.assign(new Error(body.error ?? `请求失败（HTTP ${response.status}）`), { status: response.status });
  }
  return response;
}

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function render() {
  if (!snapshot) return;
  // key 来自环境变量时只能检测和导出，添加、导入和删除需要修改环境变量后重新部署。
  const fromEnv = snapshot.storage === "env";
  elements["add-form"].hidden = fromEnv;
  elements["import-section"].hidden = fromEnv;
  elements["add-symbol"].hidden = fromEnv;
  elements["add-eyebrow"].textContent = fromEnv ? "环境变量" : "添加连接";
  elements["add-title"].textContent = fromEnv ? "Key 来源" : "添加 key";
  elements["storage-note"].textContent = fromEnv
    ? "未使用 Redis，key 来自环境变量 TYPESAFE_API_KEYS。修改 key 需要更新环境变量并重新部署。停用、冷却和检测结果只保存在当前实例中，实例重启后恢复为环境变量中的配置，管理页面每次刷新可能看到不同实例的状态。"
    : "配置保存在 Redis 中，重新部署后仍然保留。建议定期导出备份。";
  elements["total-count"].textContent = snapshot.keys.length.toLocaleString();
  elements["available-count"].textContent = snapshot.available.toLocaleString();
  elements["capacity-count"].textContent = snapshot.maxRequestsPerSecond.toLocaleString();
  const requests = snapshot.requests;
  elements["request-total"].textContent = requests.total.toLocaleString();
  elements["request-success"].textContent = requests.success.toLocaleString();
  elements["request-error"].textContent = requests.error.toLocaleString();
  const scope = fromEnv ? "当前实例" : "全部实例";
  elements["request-since"].textContent = requests.since ? `${scope}，自 ${new Date(requests.since).toLocaleString("zh-CN", { timeZone: TIME_ZONE })} 起` : `${scope}，还没有请求`;
  elements["request-success-note"].textContent = requests.total ? `成功率 ${(requests.success / requests.total * 100).toFixed(1)}%` : "返回 2xx";
  const failures = Object.entries(requests.byStatus).filter(([status]) => !status.startsWith("2")).sort((a, b) => b[1] - a[1]);
  elements["request-error-note"].textContent = failures.length ? failures.map(([status, count]) => `${status} × ${count.toLocaleString()}`).join(" · ") : "返回错误状态码";
  elements["request-error-note"].title = elements["request-error-note"].textContent;
  elements["list-count"].textContent = snapshot.keys.length;
  elements["limit-description"].textContent = `每个 key 在任意连续 1 秒内最多 ${snapshot.rateLimit} 次请求`;
  elements["export-button"].disabled = snapshot.keys.length === 0 || !!bulkCheck;
  elements["check-all-button"].disabled = snapshot.keys.length === 0 || !!bulkCheck || checking.size > 0 || loading;
  elements["check-all-button"].textContent = bulkCheck ? `检测中 ${bulkCheck.completed}/${bulkCheck.total}` : "检测全部";
  const query = elements["search"].value.trim().toLowerCase();
  const entries = snapshot.keys.filter((entry) => `${entry.name} ${entry.key}`.toLowerCase().includes(query));
  const rows = entries.map((entry) => {
    const row = create("tr");
    const identity = create("td");
    identity.append(create("div", "key-name", entry.name || `Key · ${entry.key.slice(-8)}`));
    const keyRow = create("div", "key-value-row");
    keyRow.append(create("code", "key-value", revealed.has(entry.id) ? entry.key : `${entry.key.slice(0, 12)}…${entry.key.slice(-8)}`));
    const reveal = create("button", "button reveal", revealed.has(entry.id) ? "隐藏" : "显示");
    reveal.type = "button";
    reveal.setAttribute("aria-label", `${revealed.has(entry.id) ? "隐藏" : "显示"} ${entry.name || entry.key.slice(-8)} 的完整 key`);
    reveal.addEventListener("click", () => {
      if (revealed.has(entry.id)) revealed.delete(entry.id);
      else revealed.add(entry.id);
      render();
    });
    const copy = create("button", "button reveal copy", "复制");
    copy.type = "button";
    copy.setAttribute("aria-label", `复制 ${entry.name || entry.key.slice(-8)} 的完整 key`);
    copy.addEventListener("click", async () => {
      elements["dashboard-error"].textContent = "";
      try {
        if (!navigator.clipboard) throw new Error("当前页面无法使用剪贴板，请使用 HTTPS 或 localhost 打开页面。");
        await navigator.clipboard.writeText(entry.key);
        elements["notice"].textContent = `已复制 ${entry.name || entry.key.slice(-8)} 的完整 key。`;
      } catch (error) {
        showError(error);
      }
    });
    keyRow.append(reveal, copy);
    identity.append(keyRow, create("div", "key-time", `添加于 ${new Date(entry.createdAt).toLocaleDateString("zh-CN", { timeZone: TIME_ZONE })}`));
    const stateCell = create("td");
    const labels = { available: "可用", busy: "请求已满", cooldown: `冷却 ${entry.cooldownSeconds} 秒`, disabled: "已停用" };
    stateCell.append(create("span", `status ${entry.status}`, labels[entry.status]));
    if (entry.disabledReason) stateCell.append(create("div", "status-reason", entry.disabledReason));
    if (entry.lastCheck) {
      const result = create("div", `status-reason check-result ${entry.lastCheck.status}`, `检测：${entry.lastCheck.message}`);
      result.append(create("div", "check-time", new Date(entry.lastCheck.checkedAt).toLocaleString("zh-CN", { timeZone: TIME_ZONE })));
      stateCell.append(result);
    }
    const usage = create("td", "usage", String(entry.recentRequests));
    usage.append(create("span", "usage-limit", ` / ${snapshot.rateLimit}`));
    const action = create("td");
    const actions = create("div", "row-actions");
    const check = create("button", "button quiet small check", checking.has(entry.id) ? "检测中…" : "检测");
    check.type = "button";
    check.disabled = checking.has(entry.id) || !!bulkCheck;
    check.setAttribute("aria-label", `检测 ${entry.name || entry.key.slice(-8)}`);
    check.title = "使用这个 key 发送一次 Jev 请求，检测是否可用";
    check.addEventListener("click", () => checkEntry(entry));
    const remove = create("button", "button delete", "删除");
    remove.type = "button";
    remove.disabled = checking.has(entry.id) || !!bulkCheck;
    remove.dataset.id = entry.id;
    remove.setAttribute("aria-label", `删除 ${entry.name || entry.key.slice(-8)}`);
    remove.addEventListener("click", () => {
      deleteTarget = entry;
      elements["delete-description"].textContent = `${entry.name || "API key"} · ${entry.key.slice(-8)}`;
      elements["delete-error"].textContent = "";
      elements["delete-dialog"].showModal();
    });
    actions.append(check);
    if (!fromEnv) actions.append(remove);
    action.append(actions);
    row.append(identity, stateCell, usage, create("td", "usage", String(entry.inFlight)), action);
    return row;
  });
  elements["key-rows"].replaceChildren(...rows);
  elements["empty-state"].hidden = entries.length !== 0;
  elements["empty-title"].textContent = query ? "没有找到匹配的 key" : "还没有保存 key";
  elements["empty-description"].textContent = query ? "尝试其他名称或 key 内容。" : fromEnv ? "在环境变量 TYPESAFE_API_KEYS 中填写 key 后重新部署。" : "添加 key 或导入 JSONL 文件，开始接收请求。";
}

function applySnapshot(next) {
  snapshot = next;
  render();
  elements["updated-at"].textContent = `${new Date().toLocaleTimeString("zh-CN", { timeZone: TIME_ZONE })} 更新`;
}

// 调用趋势：服务端按小时返回，这里按北京时间汇总成小时、天或周（周一开始）。
// 北京时间固定为 UTC+8、没有夏令时：时间戳加 8 小时后用 UTC 方法取得的日期和钟点就是北京时间。
const HOUR_MS = 3600000;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
const beijing = (time) => new Date(time + BEIJING_OFFSET_MS);
const pad = (value) => String(value).padStart(2, "0");
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dateText = (date) => `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
const SVG_NS = "http://www.w3.org/2000/svg";
const trendRanges = {
  hour: {
    count: 24,
    description: "最近 24 小时，按小时统计（北京时间）",
    start: (date) => date.setUTCMinutes(0, 0, 0),
    step: (date, count) => date.setUTCHours(date.getUTCHours() + count),
    label: (date) => `${pad(date.getUTCHours())}:00`,
    title: (date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${pad(date.getUTCHours())}:00`,
  },
  day: {
    count: 30,
    description: "最近 30 天，按天统计（北京时间）",
    start: (date) => date.setUTCHours(0, 0, 0, 0),
    step: (date, count) => date.setUTCDate(date.getUTCDate() + count),
    label: (date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
    title: (date) => `${dateText(date)} ${WEEKDAYS[date.getUTCDay()]}`,
  },
  week: {
    count: 12,
    description: "最近 12 周，按周统计（北京时间，每周从周一开始）",
    start: (date) => { date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); },
    step: (date, count) => date.setUTCDate(date.getUTCDate() + count * 7),
    label: (date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
    title: (date) => `${dateText(date)} 起的一周`,
  },
};
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact" });
let trendRange = "hour";
let trend = null;
let trendRequest = 0;

function trendPeriods(range) {
  const config = trendRanges[range];
  const current = beijing(Date.now());
  config.start(current);
  const boundaries = [];
  for (let offset = config.count - 1; offset >= -1; offset -= 1) {
    const date = new Date(current);
    config.step(date, -offset);
    boundaries.push(date.getTime() - BEIJING_OFFSET_MS);
  }
  return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1], total: 0, success: 0, error: 0, byStatus: {} }));
}

async function loadTrend() {
  if (!password) return;
  const id = ++trendRequest;
  const range = trendRange;
  const periods = trendPeriods(range);
  const hours = Math.ceil((Date.now() - periods[0].start) / HOUR_MS) + 1;
  elements["trend-chart"].classList.add("loading");
  try {
    const { buckets } = await (await request(`/api/admin/requests/history?hours=${hours}`)).json();
    if (id !== trendRequest) return;
    for (const bucket of buckets) {
      const period = periods.find(({ start, end }) => bucket.hour >= start && bucket.hour < end);
      if (!period) continue;
      for (const [status, count] of Object.entries(bucket.byStatus)) {
        period.total += count;
        period.byStatus[status] = (period.byStatus[status] ?? 0) + count;
        if (status.startsWith("2")) period.success += count;
        else period.error += count;
      }
    }
    trend = { range, periods };
    elements["trend-error"].textContent = "";
    renderTrend();
  } catch (error) {
    if (id === trendRequest && password) elements["trend-error"].textContent = error.message;
  } finally {
    if (id === trendRequest) elements["trend-chart"].classList.remove("loading");
  }
}

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** 纵轴上限取整，分成 4 格。 */
function niceMax(value) {
  if (value <= 4) return 4;
  const unit = 10 ** Math.floor(Math.log10(value / 4));
  return [1, 2, 2.5, 5, 10].map((step) => step * unit).find((step) => step * 4 >= value) * 4;
}

/** 顶端圆角、底端方角的柱子。 */
function barPath(x, top, width, bottom, radius) {
  const r = Math.min(radius, width / 2, bottom - top);
  return `M${x},${bottom}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + width - r}A${r},${r} 0 0 1 ${x + width},${top + r}V${bottom}Z`;
}

const failureText = (byStatus) => Object.entries(byStatus).filter(([status]) => !status.startsWith("2")).sort((a, b) => b[1] - a[1]).map(([status, count]) => `${status} × ${count.toLocaleString()}`).join(" · ");

function showTrendTooltip(period, centerX) {
  const config = trendRanges[trend.range];
  const tooltip = elements["trend-tooltip"];
  const row = (kind, value, label) => {
    const line = create("div", "tip-row");
    line.append(create("span", `tip-key ${kind}`), create("strong", "", value.toLocaleString()), create("span", "", label));
    return line;
  };
  tooltip.replaceChildren(create("div", "tip-title", config.title(beijing(period.start))), row("total", period.total, "总数"), row("success", period.success, "成功"), row("error", period.error, "失败"));
  const failures = failureText(period.byStatus);
  if (failures) tooltip.append(create("div", "tip-detail", failures));
  tooltip.hidden = false;
  const width = elements["trend-chart"].clientWidth;
  const left = centerX + 14 + tooltip.offsetWidth > width ? centerX - 14 - tooltip.offsetWidth : centerX + 14;
  tooltip.style.left = `${Math.max(0, left)}px`;
}

function renderTrend() {
  const chart = elements["trend-chart"];
  const range = trendRanges[trendRange];
  elements["trend-description"].textContent = snapshot?.storage === "env" ? `${range.description}，仅当前实例` : range.description;
  elements["trend-tooltip"].hidden = true;
  if (!trend) return;
  const { periods } = trend;
  const config = trendRanges[trend.range];
  const sum = periods.reduce((acc, period) => ({ total: acc.total + period.total, success: acc.success + period.success, error: acc.error + period.error }), { total: 0, success: 0, error: 0 });
  elements["trend-summary"].textContent = `合计 ${sum.total.toLocaleString()} 次 · 成功 ${sum.success.toLocaleString()} · 失败 ${sum.error.toLocaleString()}`;

  const style = getComputedStyle(chart);
  const width = Math.max(300, chart.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const height = 220;
  const margin = { top: 12, right: 8, bottom: 28, left: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const baseline = margin.top + plotHeight;
  const max = niceMax(Math.max(...periods.map(({ total }) => total)));
  const band = plotWidth / periods.length;
  const barWidth = Math.min(24, Math.max(4, band - 6));
  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${config.description}的成功与失败请求数` });

  for (let tick = 0; tick <= 4; tick += 1) {
    const y = baseline - tick / 4 * plotHeight;
    root.append(svg("line", { class: "trend-grid", x1: margin.left, x2: width - margin.right, y1: y, y2: y }));
    const label = svg("text", { class: "trend-axis", x: margin.left - 8, y: y + 3, "text-anchor": "end" });
    label.textContent = compact.format(max * tick / 4);
    root.append(label);
  }
  const every = Math.ceil(periods.length / Math.max(1, Math.floor(plotWidth / 48)));
  periods.forEach((period, index) => {
    const x = margin.left + band * index;
    const group = svg("g", { class: "trend-column" });
    group.append(svg("rect", { class: "trend-band", x: x + 1, y: margin.top, width: Math.max(0, band - 2), height: plotHeight, rx: 4 }));
    // 成功在下、失败在上，两段之间留 2px 间隔，最上面一段圆角。
    const segments = [["success", period.success], ["error", period.error]].filter(([, value]) => value > 0);
    let bottom = baseline;
    segments.forEach(([kind, value], segment) => {
      const top = bottom - Math.max(2, value / max * plotHeight);
      const barX = x + (band - barWidth) / 2;
      const d = segment === segments.length - 1 ? barPath(barX, top, barWidth, bottom, 4) : `M${barX},${bottom}V${top}H${barX + barWidth}V${bottom}Z`;
      group.append(svg("path", { class: `bar-${kind}`, d }));
      bottom = top - 2;
    });
    if ((periods.length - 1 - index) % every === 0) {
      const label = svg("text", { class: "trend-axis", x: x + band / 2, y: height - 8, "text-anchor": "middle" });
      label.textContent = config.label(beijing(period.start));
      group.append(label);
    }
    const hit = svg("rect", { class: "trend-hit", x, y: 0, width: band, height, tabindex: 0, "aria-label": `${config.title(beijing(period.start))}：总数 ${period.total}，成功 ${period.success}，失败 ${period.error}` });
    const enter = () => {
      group.classList.add("active");
      showTrendTooltip(period, root.getBoundingClientRect().left - chart.getBoundingClientRect().left + x + band / 2);
    };
    const leave = () => { group.classList.remove("active"); elements["trend-tooltip"].hidden = true; };
    hit.addEventListener("pointerenter", enter);
    hit.addEventListener("focus", enter);
    hit.addEventListener("pointerleave", leave);
    hit.addEventListener("blur", leave);
    group.append(hit);
    root.append(group);
  });
  if (sum.total === 0) {
    const empty = svg("text", { class: "trend-empty", x: margin.left + plotWidth / 2, y: margin.top + plotHeight / 2, "text-anchor": "middle" });
    empty.textContent = "这段时间没有请求";
    root.append(empty);
  }
  chart.querySelector("svg")?.remove();
  chart.prepend(root);
}

async function refresh() {
  if (loading || !password || bulkCheck) return;
  loading = true;
  elements["refresh-button"].disabled = true;
  try {
    applySnapshot(await (await request("/api/admin/keys")).json());
    elements["dashboard-error"].textContent = "";
    loadTrend();
  } finally {
    loading = false;
    elements["refresh-button"].disabled = false;
    render();
  }
}

function showError(error) {
  const target = password ? elements["dashboard-error"] : elements["login-error"];
  target.textContent = error.message;
}

async function checkEntry(entry) {
  if (checking.has(entry.id) || bulkCheck) return;
  checking.add(entry.id);
  elements["dashboard-error"].textContent = "";
  elements["notice"].textContent = `正在检测 ${entry.name || entry.key.slice(-8)}…`;
  render();
  try {
    const response = await request(`/api/admin/keys/${encodeURIComponent(entry.id)}/check`, { method: "POST" });
    const next = await response.json();
    applySnapshot(next);
    elements["notice"].textContent = `${entry.name || entry.key.slice(-8)}：${next.check.message}。`;
  } catch (error) {
    elements["notice"].textContent = "";
    showError(error);
  } finally {
    checking.delete(entry.id);
    render();
  }
}

function showBulkProgress(run, label) {
  if (run.controller.signal.aborted || bulkCheck !== run) return;
  const counts = run.counts;
  elements["bulk-check-status"].textContent = `${label} ${run.completed}/${run.total}：有效 ${counts.valid}，无效 ${counts.invalid}，额度不足 ${counts.no_credits}，限流 ${counts.rate_limited}，暂时无法确认 ${counts.unconfirmed}。`;
  render();
}

async function checkAllEntries() {
  if (!snapshot?.keys.length || bulkCheck || checking.size || loading) return;
  if (["add-button", "import-file", "confirm-delete"].some((id) => elements[id].disabled)) return;
  const entries = [...snapshot.keys];
  const run = {
    controller: new AbortController(),
    completed: 0,
    total: entries.length,
    counts: { valid: 0, invalid: 0, no_credits: 0, rate_limited: 0, unconfirmed: 0 },
  };
  bulkCheck = run;
  const controls = ["add-button", "import-file", "refresh-button", "confirm-delete"];
  controls.forEach((id) => { elements[id].disabled = true; });
  elements["dashboard-error"].textContent = "";
  elements["notice"].textContent = "";
  showBulkProgress(run, "正在检测");
  try {
    for (let offset = 0; offset < entries.length; offset += 5) {
      const batch = entries.slice(offset, offset + 5);
      batch.forEach((entry) => checking.add(entry.id));
      render();
      let failure;
      const results = await Promise.allSettled(batch.map(async (entry) => {
        try {
          const response = await request(`/api/admin/keys/${encodeURIComponent(entry.id)}/check`, {
            method: "POST",
            signal: run.controller.signal,
          });
          const next = await response.json();
          run.counts[next.check.status] += 1;
          run.completed += 1;
          showBulkProgress(run, "正在检测");
        } catch (error) {
          if (error.status === 429) {
            run.counts.rate_limited += 1;
            run.completed += 1;
            showBulkProgress(run, "正在检测");
            return;
          }
          if (!run.controller.signal.aborted) {
            failure = error;
            run.controller.abort();
          }
          throw error;
        } finally {
          checking.delete(entry.id);
          render();
        }
      }));
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw failure ?? rejected.reason;
      run.controller.signal.throwIfAborted();
      // 每批完成后获取当前状态，多个检测响应的到达顺序不会覆盖较新的结果。
      const next = await (await request("/api/admin/keys", { signal: run.controller.signal })).json();
      run.controller.signal.throwIfAborted();
      applySnapshot(next);
    }
    showBulkProgress(run, "检测完成");
  } catch (error) {
    if (password) {
      elements["bulk-check-status"].textContent = `检测已终止，已完成 ${run.completed}/${run.total}。`;
      showError(error);
    }
  } finally {
    bulkCheck = null;
    controls.forEach((id) => { elements[id].disabled = false; });
    render();
  }
}

elements["login-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  password = elements["password"].value;
  elements["login-button"].disabled = true;
  elements["login-error"].textContent = "";
  try {
    await refresh();
    localStorage.setItem(storageKey, password);
    elements["password"].value = "";
    elements["login-panel"].hidden = true;
    elements["dashboard"].hidden = false;
    elements["logout-button"].hidden = false;
  } catch (error) {
    elements["login-error"].textContent = error.message;
  } finally {
    elements["login-button"].disabled = false;
  }
});

elements["logout-button"].addEventListener("click", () => {
  localStorage.removeItem(storageKey);
  showLogin();
});
elements["search"].addEventListener("input", render);
elements["refresh-button"].addEventListener("click", () => refresh().catch(showError));
elements["check-all-button"].addEventListener("click", checkAllEntries);
for (const button of document.querySelectorAll(".segment")) {
  button.addEventListener("click", () => {
    if (trendRange === button.dataset.range) return;
    trendRange = button.dataset.range;
    document.querySelectorAll(".segment").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    renderTrend();
    loadTrend();
  });
}
// 宽度变化时按新宽度重画，柱子和文字不会被拉伸。
new ResizeObserver(() => { if (trend) renderTrend(); }).observe(elements["trend-chart"]);

elements["add-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (bulkCheck) return;
  elements["add-button"].disabled = true;
  elements["dashboard-error"].textContent = "";
  try {
    const name = elements["key-name"].value.trim();
    const keys = elements["new-keys"].value.split(/\r?\n/).map((key) => key.trim()).filter(Boolean).map((key, index, all) => ({ key, name: all.length > 1 && name ? `${name} ${index + 1}` : name }));
    const response = await request("/api/admin/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
    const next = await response.json();
    applySnapshot(next);
    elements["add-form"].reset();
    elements["notice"].textContent = `已添加 ${next.added} 个 key。`;
  } catch (error) {
    showError(error);
  } finally {
    elements["add-button"].disabled = false;
  }
});

elements["cancel-delete"].addEventListener("click", () => elements["delete-dialog"].close());
elements["delete-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!deleteTarget || bulkCheck) return;
  elements["confirm-delete"].disabled = true;
  try {
    const response = await request(`/api/admin/keys/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
    revealed.delete(deleteTarget.id);
    applySnapshot(await response.json());
    elements["delete-dialog"].close();
    elements["notice"].textContent = "已删除 key。";
    deleteTarget = null;
  } catch (error) {
    elements["delete-error"].textContent = error.message;
  } finally {
    elements["confirm-delete"].disabled = false;
  }
});

elements["import-file"].addEventListener("change", async () => {
  if (bulkCheck) return;
  const file = elements["import-file"].files[0];
  if (!file) return;
  elements["import-file"].disabled = true;
  elements["dashboard-error"].textContent = "";
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("JSONL 文件不能超过 2 MiB。");
    const response = await request("/api/admin/keys/import", { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: await file.text() });
    const next = await response.json();
    applySnapshot(next);
    elements["notice"].textContent = `已导入 ${next.added} 个 key。`;
  } catch (error) {
    showError(error);
  } finally {
    elements["import-file"].value = "";
    elements["import-file"].disabled = false;
  }
});

elements["export-button"].addEventListener("click", async () => {
  elements["export-button"].disabled = true;
  try {
    const response = await request("/api/admin/keys/export");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = create("a");
    link.href = url;
    link.download = "jev-keys.jsonl";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    elements["notice"].textContent = "已导出全部 key。";
  } catch (error) {
    showError(error);
  } finally {
    elements["export-button"].disabled = !snapshot?.keys.length;
  }
});

async function initialize() {
  password = localStorage.getItem(storageKey) ?? "";
  if (!password) return;
  elements["login-button"].disabled = true;
  try {
    await refresh();
    elements["login-panel"].hidden = true;
    elements["dashboard"].hidden = false;
    elements["logout-button"].hidden = false;
  } catch (error) {
    elements["login-error"].textContent = error.message;
  } finally {
    elements["login-button"].disabled = false;
  }
}

initialize().catch(showError);
