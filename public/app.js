const storageKey = "jev.admin.password";
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
  const instanceHeaders = snapshot && (options.method || path.endsWith("/export")) ? { "X-Jev-Instance": snapshot.instanceId } : {};
  const response = await fetch(path, { ...options, headers: { Authorization: authorization(), ...instanceHeaders, ...options.headers }, cache: "no-store" });
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
  elements["total-count"].textContent = snapshot.keys.length.toLocaleString();
  elements["available-count"].textContent = snapshot.available.toLocaleString();
  elements["capacity-count"].textContent = snapshot.maxRequestsPerSecond.toLocaleString();
  elements["list-count"].textContent = snapshot.keys.length;
  elements["limit-description"].textContent = `每个 key 在任意连续 1 秒内最多 ${snapshot.rateLimit} 次请求`;
  elements["instance-label"].textContent = `当前实例 ${snapshot.instanceId.slice(0, 8)}`;
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
    identity.append(keyRow, create("div", "key-time", `添加于 ${new Date(entry.createdAt).toLocaleDateString("zh-CN")}`));
    const stateCell = create("td");
    const labels = { available: "可用", busy: "请求已满", cooldown: `冷却 ${entry.cooldownSeconds} 秒`, disabled: "已停用" };
    stateCell.append(create("span", `status ${entry.status}`, labels[entry.status]));
    if (entry.disabledReason) stateCell.append(create("div", "status-reason", entry.disabledReason));
    if (entry.lastCheck) {
      const result = create("div", `status-reason check-result ${entry.lastCheck.status}`, `检测：${entry.lastCheck.message}`);
      result.append(create("div", "check-time", new Date(entry.lastCheck.checkedAt).toLocaleString("zh-CN")));
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
    actions.append(check, remove);
    action.append(actions);
    row.append(identity, stateCell, usage, create("td", "usage", String(entry.inFlight)), action);
    return row;
  });
  elements["key-rows"].replaceChildren(...rows);
  elements["empty-state"].hidden = entries.length !== 0;
  elements["empty-title"].textContent = query ? "没有找到匹配的 key" : "还没有保存 key";
  elements["empty-description"].textContent = query ? "尝试其他名称或 key 内容。" : "添加 key 或导入 JSONL 文件，开始接收请求。";
}

function applySnapshot(next) {
  if (snapshot && snapshot.instanceId !== next.instanceId) {
    elements["notice"].textContent = "当前请求由另一个实例处理，列表已更新为该实例的内存配置。";
    revealed.clear();
  }
  snapshot = next;
  render();
  elements["updated-at"].textContent = `${new Date().toLocaleTimeString("zh-CN")} 更新`;
}

async function refresh() {
  if (loading || !password || bulkCheck) return;
  loading = true;
  elements["refresh-button"].disabled = true;
  try {
    applySnapshot(await (await request("/api/admin/keys")).json());
    elements["dashboard-error"].textContent = "";
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
  const instanceId = snapshot.instanceId;
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
            headers: { "X-Jev-Instance": instanceId },
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
      const next = await (await request("/api/admin/keys", {
        headers: { "X-Jev-Instance": instanceId },
        signal: run.controller.signal,
      })).json();
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
