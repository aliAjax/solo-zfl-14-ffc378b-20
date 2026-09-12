import "./styles.css";
import {
  SLOTS,
  STATUSES,
  URGENCY,
  createStorage,
  loadState,
  saveState,
  addOwner,
  addWorker,
  removeOwner,
  removeWorker,
  createOrder,
  rescheduleOrder,
  advanceOrder,
  filterOrders,
  sortOrders,
  computeStats,
  todayStr
} from "./store.js";

const storage = createStorage("zfl-14-home-repair");
const loaded = loadState(storage);
let state = loaded.state;

const filters = { date: "", workerId: "", status: "", keyword: "", sort: "time" };
let toast = loaded.error ? { type: "warn", text: loaded.error } : null;
let orderDraft = null; // 创建/冲突失败时保留表单内容
let panel = null; // { orderId, mode: 'reschedule' | 'complete' }

const app = document.querySelector("#app");

function persist() {
  const result = saveState(storage, state);
  if (!result.ok) showToast("error", `${result.error}，本次修改可能不会被保存`);
}

function showToast(type, text) {
  toast = { type, text };
}

function ownerOf(order) {
  return state.owners.find((o) => o.id === order.ownerId);
}

function workerOf(order) {
  return state.workers.find((w) => w.id === order.workerId);
}

function conflictText(conflicts) {
  return conflicts
    .map((c) => {
      const worker = workerOf(c);
      return `${worker?.name ?? "该人员"} 在 ${c.date} ${SLOTS[c.slot]} 已有工单《${c.title}》`;
    })
    .join("；");
}

function render() {
  const stats = computeStats(state, todayStr());
  const orders = sortOrders(filterOrders(state, filters), filters.sort);

  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">本地家庭维修调度台</p>
          <h1>家庭维修预约调度</h1>
        </div>
        <section class="stats">
          <div class="stat"><span>今日待上门</span><strong>${stats.todayVisits}</strong></div>
          <div class="stat"><span>本周预约</span><strong>${stats.weekOrders}</strong></div>
          <div class="stat"><span>冲突次数</span><strong>${stats.conflictCount}</strong></div>
          <div class="stat wide">
            <span>人员工单量（进行中/全部）</span>
            <div class="worker-stats">
              ${stats.perWorker.length
                ? stats.perWorker
                    .map((w) => `<span class="chip">${escapeHtml(w.name)} ${w.active}/${w.total}</span>`)
                    .join("")
                : `<span class="muted">暂无人员</span>`}
            </div>
          </div>
        </section>
      </header>

      ${toast ? `<div class="toast ${toast.type}" role="alert">${escapeHtml(toast.text)}</div>` : ""}

      <section class="layout">
        <aside class="side">
          ${renderOrderForm()}
          ${renderPeoplePanel("owner")}
          ${renderPeoplePanel("worker")}
        </aside>

        <section>
          <div class="toolbar">
            <input type="date" data-filter="date" value="${filters.date}" title="按日期筛选">
            <select data-filter="workerId">
              <option value="">全部人员</option>
              ${state.workers.map((w) => `<option value="${w.id}" ${filters.workerId === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`).join("")}
            </select>
            <select data-filter="status">
              <option value="">全部状态</option>
              ${Object.entries(STATUSES).map(([v, l]) => `<option value="${v}" ${filters.status === v ? "selected" : ""}>${l}</option>`).join("")}
            </select>
            <input type="search" data-filter="keyword" value="${escapeHtml(filters.keyword)}" placeholder="关键词：需求 / 业主 / 地址">
            <select data-filter="sort" title="排序方式">
              <option value="time" ${filters.sort === "time" ? "selected" : ""}>按预约时间</option>
              <option value="urgency" ${filters.sort === "urgency" ? "selected" : ""}>按紧急程度</option>
            </select>
          </div>
          <div class="orders">
            ${orders.length ? orders.map(renderOrder).join("") : `<div class="empty">没有符合条件的工单</div>`}
          </div>
        </section>
      </section>
    </main>
  `;

  bindEvents();
}

function renderOrderForm() {
  const d = orderDraft ?? {};
  const disabled = state.owners.length === 0 || state.workers.length === 0;
  return `
    <section class="panel">
      <h2>新建工单</h2>
      ${
        disabled
          ? `<p class="muted">请先在下方添加业主和维修人员，再创建工单。</p>`
          : `
      <form class="form" id="order-form">
        <label>维修需求<input name="title" required placeholder="例如：厨房水槽渗水" value="${escapeHtml(d.title ?? "")}"></label>
        <label>业主
          <select name="ownerId">${state.owners.map((o) => `<option value="${o.id}" ${d.ownerId === o.id ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}</select>
        </label>
        <label>维修人员
          <select name="workerId">${state.workers.map((w) => `<option value="${w.id}" ${d.workerId === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`).join("")}</select>
        </label>
        <div class="field-row">
          <label>预约日期<input name="date" type="date" required value="${escapeHtml(d.date ?? "")}"></label>
          <label>时段
            <select name="slot">${Object.entries(SLOTS).map(([v, l]) => `<option value="${v}" ${d.slot === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          </label>
        </div>
        <label>紧急程度
          <select name="urgency">${Object.entries(URGENCY).map(([v, l]) => `<option value="${v}" ${(d.urgency ?? "medium") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
        <label>问题描述<textarea name="description" placeholder="故障现象、注意事项等">${escapeHtml(d.description ?? "")}</textarea></label>
        <button class="primary" type="submit">创建工单</button>
      </form>`
      }
    </section>
  `;
}

function renderPeoplePanel(kind) {
  const isOwner = kind === "owner";
  const people = isOwner ? state.owners : state.workers;
  const title = isOwner ? "业主" : "维修人员";
  return `
    <section class="panel">
      <h2>${title}管理</h2>
      <form class="form" id="${kind}-form">
        <label>姓名<input name="name" required placeholder="${isOwner ? "例如：王先生" : "例如：张师傅"}"></label>
        <label>电话<input name="phone" placeholder="选填"></label>
        <label>${isOwner ? "住址" : "技能"}<input name="${isOwner ? "address" : "skills"}" placeholder="${isOwner ? "例如：3栋 502" : "例如：水电 / 家电"}"></label>
        <button class="primary" type="submit">添加${title}</button>
      </form>
      <ul class="people">
        ${people.length
          ? people
              .map(
                (p) => `
          <li>
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <span class="muted">${escapeHtml([p.phone, isOwner ? p.address : p.skills].filter(Boolean).join(" · ") || "—")}</span>
            </div>
            <button class="ghost" data-remove-${kind}="${p.id}">删除</button>
          </li>`
              )
              .join("")
          : `<li class="muted">暂无${title}，请先添加</li>`}
      </ul>
    </section>
  `;
}

function renderOrder(order) {
  const owner = ownerOf(order);
  const worker = workerOf(order);
  const editing = panel?.orderId === order.id ? panel.mode : null;
  const nextAction = { pending: "确认预约", scheduled: "已上门", arrived: "完成并回访" }[order.status];

  return `
    <article class="order status-${order.status}">
      <div class="order-head">
        <h3>${escapeHtml(order.title)}</h3>
        <span class="badge urgency-${order.urgency}">${URGENCY[order.urgency]}</span>
        <span class="badge st-${order.status}">${STATUSES[order.status]}</span>
      </div>
      <p class="meta">
        ${order.date} ${SLOTS[order.slot]} ｜ 业主：${escapeHtml(owner?.name ?? "已删除")}${owner?.address ? `（${escapeHtml(owner.address)}）` : ""} ｜ 人员：${escapeHtml(worker?.name ?? "已删除")}
      </p>
      ${order.description ? `<p class="desc">${escapeHtml(order.description)}</p>` : ""}
      ${order.status === "completed" && order.visitResult ? `<p class="visit">回访结果：${escapeHtml(order.visitResult)}</p>` : ""}

      ${editing === "reschedule" ? renderRescheduleForm(order) : ""}
      ${editing === "complete" ? renderCompleteForm(order) : ""}

      ${
        !editing
          ? `<div class="actions">
              ${nextAction ? `<button class="primary small" data-advance="${order.id}">${nextAction}</button>` : ""}
              ${order.status !== "completed" ? `<button class="ghost" data-edit-reschedule="${order.id}">改期 / 改派</button>` : ""}
            </div>`
          : ""
      }
    </article>
  `;
}

function renderRescheduleForm(order) {
  return `
    <form class="form inline" data-reschedule-form="${order.id}">
      <div class="field-row">
        <label>新日期<input name="date" type="date" required value="${order.date}"></label>
        <label>新时段
          <select name="slot">${Object.entries(SLOTS).map(([v, l]) => `<option value="${v}" ${order.slot === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
        <label>维修人员
          <select name="workerId">${state.workers.map((w) => `<option value="${w.id}" ${order.workerId === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`).join("")}</select>
        </label>
      </div>
      <div class="actions">
        <button class="primary small" type="submit">保存改期</button>
        <button class="ghost" type="button" data-cancel-panel>取消</button>
      </div>
    </form>
  `;
}

function renderCompleteForm(order) {
  return `
    <form class="form inline" data-complete-form="${order.id}">
      <label>回访结果<textarea name="visitResult" placeholder="例如：已修复，业主满意" required></textarea></label>
      <div class="actions">
        <button class="primary small" type="submit">确认完成</button>
        <button class="ghost" type="button" data-cancel-panel>取消</button>
      </div>
    </form>
  `;
}

function bindEvents() {
  document.querySelector("#order-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const result = createOrder(state, data);
    if (result.ok) {
      orderDraft = null;
      showToast("ok", result.deduped ? "相同预约已存在，未重复创建" : "工单已创建，状态：待确认");
    } else {
      orderDraft = data; // 保留填写内容，便于改期后重新提交
      if (result.reason === "conflict") {
        showToast("error", `时段冲突：${conflictText(result.conflicts)}。请改期或改派其他人员。`);
      } else {
        showToast("error", `创建失败：${Object.values(result.errors).join("；")}`);
      }
    }
    persist();
    render();
  });

  document.querySelector("#owner-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = addOwner(state, Object.fromEntries(new FormData(event.target)));
    showToast(result.ok ? "ok" : "error", result.ok ? "业主已添加" : Object.values(result.errors).join("；"));
    persist();
    render();
  });

  document.querySelector("#worker-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = addWorker(state, Object.fromEntries(new FormData(event.target)));
    showToast(result.ok ? "ok" : "error", result.ok ? "维修人员已添加" : Object.values(result.errors).join("；"));
    persist();
    render();
  });

  document.querySelectorAll("[data-remove-owner]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const result = removeOwner(state, btn.dataset.removeOwner);
      if (!result.ok) showToast("error", result.error);
      persist();
      render();
    })
  );

  document.querySelectorAll("[data-remove-worker]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const result = removeWorker(state, btn.dataset.removeWorker);
      if (!result.ok) showToast("error", result.error);
      persist();
      render();
    })
  );

  document.querySelectorAll("[data-filter]").forEach((el) =>
    el.addEventListener("change", () => {
      filters[el.dataset.filter] = el.value;
      render();
    })
  );
  document.querySelector('[data-filter="keyword"]')?.addEventListener("input", (event) => {
    filters.keyword = event.target.value;
    render();
    const input = document.querySelector('[data-filter="keyword"]');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  document.querySelectorAll("[data-advance]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const order = state.orders.find((o) => o.id === btn.dataset.advance);
      if (order?.status === "arrived") {
        panel = { orderId: order.id, mode: "complete" }; // 完成前先填回访结果
        render();
        return;
      }
      const result = advanceOrder(state, btn.dataset.advance);
      showToast(result.ok ? "ok" : "error", result.ok ? `已流转为：${STATUSES[result.order.status]}` : result.error);
      persist();
      render();
    })
  );

  document.querySelectorAll("[data-edit-reschedule]").forEach((btn) =>
    btn.addEventListener("click", () => {
      panel = { orderId: btn.dataset.editReschedule, mode: "reschedule" };
      render();
    })
  );

  document.querySelectorAll("[data-cancel-panel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      panel = null;
      render();
    })
  );

  document.querySelectorAll("[data-reschedule-form]").forEach((form) =>
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const orderId = form.dataset.rescheduleForm;
      const data = Object.fromEntries(new FormData(form));
      const result = rescheduleOrder(state, orderId, data);
      if (result.ok) {
        panel = null;
        showToast("ok", "改期成功");
      } else if (result.reason === "conflict") {
        showToast("error", `改期冲突：${conflictText(result.conflicts)}。请另选时段或人员。`);
      } else {
        showToast("error", `改期失败：${Object.values(result.errors).join("；")}`);
      }
      persist();
      render();
    })
  );

  document.querySelectorAll("[data-complete-form]").forEach((form) =>
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (!String(data.visitResult ?? "").trim()) {
        showToast("error", "请填写回访结果");
        render();
        return;
      }
      const result = advanceOrder(state, form.dataset.completeForm, { visitResult: data.visitResult });
      if (result.ok) {
        panel = null;
        showToast("ok", "工单已完成，回访结果已记录");
      } else {
        showToast("error", result.error);
      }
      persist();
      render();
    })
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]
  );
}

render();
