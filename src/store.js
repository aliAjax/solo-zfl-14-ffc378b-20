// 家庭维修预约调度 —— 核心业务逻辑（纯函数，便于自动化测试）
// 所有函数不直接依赖 DOM；存储与日期均可注入，异常输入返回结构化错误而不是抛错。

export const SLOTS = {
  morning: "上午 09:00-12:00",
  afternoon: "下午 13:00-17:00",
  evening: "晚上 18:00-21:00"
};
export const SLOT_ORDER = { morning: 0, afternoon: 1, evening: 2 };

export const STATUSES = {
  pending: "待确认",
  scheduled: "已预约",
  arrived: "已上门",
  completed: "已完成"
};
// 工单只允许单向流转：待确认 -> 已预约 -> 已上门 -> 已完成
export const STATUS_FLOW = { pending: "scheduled", scheduled: "arrived", arrived: "completed" };

export const URGENCY = { high: "紧急", medium: "普通", low: "可延后" };
export const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function defaultState() {
  return { owners: [], workers: [], orders: [], conflictLog: [] };
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function todayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidDateStr(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---------- 存储（失败不崩页） ----------

export function createStorage(key, backend) {
  const store = backend ?? globalThis.localStorage ?? null;
  return { key, backend: store };
}

export function loadState(storage) {
  const fallback = defaultState();
  if (!storage?.backend) return { state: fallback, error: "本地存储不可用，数据仅保存在内存中" };
  let raw = null;
  try {
    raw = storage.backend.getItem(storage.key);
  } catch {
    return { state: fallback, error: "读取本地数据失败，已使用空数据" };
  }
  if (!raw) return { state: fallback, error: null };
  try {
    return { state: sanitizeState(JSON.parse(raw)), error: null };
  } catch {
    return { state: fallback, error: "本地数据已损坏，已重置为空数据" };
  }
}

export function saveState(storage, state) {
  if (!storage?.backend) return { ok: false, error: "本地存储不可用" };
  try {
    storage.backend.setItem(storage.key, JSON.stringify(state));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "写入本地存储失败（可能空间不足）" };
  }
}

// 载入时清洗数据：结构缺失补齐、非法记录剔除、重复预约去重（只保留一次）
export function sanitizeState(input) {
  const state = defaultState();
  if (!input || typeof input !== "object") return state;
  const asArray = (v) => (Array.isArray(v) ? v : []);

  const ownerIds = new Set();
  for (const o of asArray(input.owners)) {
    if (!o || typeof o.name !== "string" || !o.name.trim()) continue;
    const owner = {
      id: typeof o.id === "string" && o.id ? o.id : createId(),
      name: o.name.trim(),
      phone: typeof o.phone === "string" ? o.phone.trim() : "",
      address: typeof o.address === "string" ? o.address.trim() : ""
    };
    if (ownerIds.has(owner.id)) continue;
    ownerIds.add(owner.id);
    state.owners.push(owner);
  }

  const workerIds = new Set();
  for (const w of asArray(input.workers)) {
    if (!w || typeof w.name !== "string" || !w.name.trim()) continue;
    const worker = {
      id: typeof w.id === "string" && w.id ? w.id : createId(),
      name: w.name.trim(),
      phone: typeof w.phone === "string" ? w.phone.trim() : "",
      skills: typeof w.skills === "string" ? w.skills.trim() : ""
    };
    if (workerIds.has(worker.id)) continue;
    workerIds.add(worker.id);
    state.workers.push(worker);
  }

  const seenOrderIds = new Set();
  const seenFingerprints = new Set();
  for (const o of asArray(input.orders)) {
    if (!o || typeof o !== "object") continue;
    if (!ownerIds.has(o.ownerId) || !workerIds.has(o.workerId)) continue;
    if (!isValidDateStr(o.date) || !(o.slot in SLOTS)) continue;
    const status = o.status in STATUSES ? o.status : "pending";
    const order = {
      id: typeof o.id === "string" && o.id ? o.id : createId(),
      ownerId: o.ownerId,
      workerId: o.workerId,
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "未命名工单",
      description: typeof o.description === "string" ? o.description.trim() : "",
      date: o.date,
      slot: o.slot,
      urgency: o.urgency in URGENCY ? o.urgency : "medium",
      status,
      visitResult: status === "completed" && typeof o.visitResult === "string" ? o.visitResult : "",
      createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : ""
    };
    if (seenOrderIds.has(order.id)) continue;
    const fingerprint = orderFingerprint(order);
    if (seenFingerprints.has(fingerprint)) continue; // 重复预约只保留一次
    seenOrderIds.add(order.id);
    seenFingerprints.add(fingerprint);
    state.orders.push(order);
  }

  for (const c of asArray(input.conflictLog)) {
    if (!c || typeof c !== "object") continue;
    state.conflictLog.push({
      id: typeof c.id === "string" && c.id ? c.id : createId(),
      at: typeof c.at === "string" ? c.at : "",
      workerId: typeof c.workerId === "string" ? c.workerId : "",
      date: typeof c.date === "string" ? c.date : "",
      slot: typeof c.slot === "string" ? c.slot : "",
      detail: typeof c.detail === "string" ? c.detail : ""
    });
  }
  return state;
}

// ---------- 业主 / 维修人员 ----------

export function addOwner(state, input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, errors: { name: "业主姓名不能为空" } };
  const owner = {
    id: createId(),
    name,
    phone: String(input.phone ?? "").trim(),
    address: String(input.address ?? "").trim()
  };
  state.owners.push(owner);
  return { ok: true, owner };
}

export function addWorker(state, input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, errors: { name: "维修人员姓名不能为空" } };
  const worker = {
    id: createId(),
    name,
    phone: String(input.phone ?? "").trim(),
    skills: String(input.skills ?? "").trim()
  };
  state.workers.push(worker);
  return { ok: true, worker };
}

export function removeOwner(state, ownerId) {
  if (state.orders.some((o) => o.ownerId === ownerId)) {
    return { ok: false, error: "该业主名下已有工单，不能删除" };
  }
  const before = state.owners.length;
  state.owners = state.owners.filter((o) => o.id !== ownerId);
  return state.owners.length < before ? { ok: true } : { ok: false, error: "业主不存在" };
}

export function removeWorker(state, workerId) {
  if (state.orders.some((o) => o.workerId === workerId)) {
    return { ok: false, error: "该维修人员名下已有工单，不能删除" };
  }
  const before = state.workers.length;
  state.workers = state.workers.filter((w) => w.id !== workerId);
  return state.workers.length < before ? { ok: true } : { ok: false, error: "维修人员不存在" };
}

// ---------- 工单 ----------

function orderFingerprint(order) {
  return [order.ownerId, order.workerId, order.date, order.slot, order.title].join("|");
}

function isActive(order) {
  return order.status !== "completed";
}

export function validateOrderInput(state, input = {}) {
  const errors = {};
  const data = {
    ownerId: String(input.ownerId ?? ""),
    workerId: String(input.workerId ?? ""),
    title: String(input.title ?? "").trim(),
    description: String(input.description ?? "").trim(),
    date: String(input.date ?? ""),
    slot: String(input.slot ?? ""),
    urgency: String(input.urgency ?? "medium")
  };
  if (!state.owners.some((o) => o.id === data.ownerId)) errors.ownerId = "请选择业主";
  if (!state.workers.some((w) => w.id === data.workerId)) errors.workerId = "请选择维修人员";
  if (!data.title) errors.title = "维修需求不能为空";
  if (!isValidDateStr(data.date)) errors.date = "请选择有效的预约日期";
  if (!(data.slot in SLOTS)) errors.slot = "请选择时段";
  if (!(data.urgency in URGENCY)) errors.urgency = "请选择紧急程度";
  return { data, errors, valid: Object.keys(errors).length === 0 };
}

// 同一人员同一日期同一时段的未完工工单视为占用
export function findConflicts(state, { workerId, date, slot }, excludeId = null) {
  return state.orders.filter(
    (o) =>
      o.id !== excludeId &&
      isActive(o) &&
      o.workerId === workerId &&
      o.date === date &&
      o.slot === slot
  );
}

function logConflict(state, { workerId, date, slot, detail }, now) {
  state.conflictLog.push({ id: createId(), at: now, workerId, date, slot, detail });
}

export function createOrder(state, input, now = new Date().toISOString()) {
  const { data, errors, valid } = validateOrderInput(state, input);
  if (!valid) return { ok: false, reason: "invalid", errors };

  // 重复预约只保留一次：同业主、同人员、同时段、同需求的未完工工单直接复用
  const fingerprint = [data.ownerId, data.workerId, data.date, data.slot, data.title].join("|");
  const existing = state.orders.find((o) => isActive(o) && orderFingerprint(o) === fingerprint);
  if (existing) return { ok: true, order: existing, deduped: true };

  const conflicts = findConflicts(state, data);
  if (conflicts.length) {
    logConflict(state, { ...data, detail: `创建《${data.title}》时与 ${conflicts.length} 个工单冲突` }, now);
    return { ok: false, reason: "conflict", conflicts };
  }

  const order = {
    id: createId(),
    ...data,
    status: "pending",
    visitResult: "",
    createdAt: now,
    updatedAt: now
  };
  state.orders.push(order);
  return { ok: true, order, deduped: false };
}

// 改期 / 改派：同样做冲突检测，冲突会提示并保留原安排
export function rescheduleOrder(state, orderId, patch, now = new Date().toISOString()) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return { ok: false, reason: "invalid", errors: { order: "工单不存在" } };
  if (order.status === "completed") {
    return { ok: false, reason: "invalid", errors: { order: "已完成的工单不能改期" } };
  }
  const next = {
    date: patch.date ?? order.date,
    slot: patch.slot ?? order.slot,
    workerId: patch.workerId ?? order.workerId
  };
  const errors = {};
  if (!isValidDateStr(next.date)) errors.date = "请选择有效的预约日期";
  if (!(next.slot in SLOTS)) errors.slot = "请选择时段";
  if (!state.workers.some((w) => w.id === next.workerId)) errors.workerId = "请选择维修人员";
  if (Object.keys(errors).length) return { ok: false, reason: "invalid", errors };

  const conflicts = findConflicts(state, next, order.id);
  if (conflicts.length) {
    logConflict(
      state,
      { ...next, detail: `《${order.title}》改期时与 ${conflicts.length} 个工单冲突` },
      now
    );
    return { ok: false, reason: "conflict", conflicts };
  }

  order.date = next.date;
  order.slot = next.slot;
  order.workerId = next.workerId;
  order.updatedAt = now;
  return { ok: true, order };
}

// 状态单向流转；完成时可填写回访结果
export function advanceOrder(state, orderId, { visitResult } = {}, now = new Date().toISOString()) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return { ok: false, error: "工单不存在" };
  const nextStatus = STATUS_FLOW[order.status];
  if (!nextStatus) return { ok: false, error: "工单已完成，无法继续流转" };
  order.status = nextStatus;
  if (nextStatus === "completed") {
    order.visitResult = String(visitResult ?? "").trim();
  }
  order.updatedAt = now;
  return { ok: true, order };
}

// ---------- 筛选与排序 ----------

export function filterOrders(state, filters = {}) {
  const keyword = String(filters.keyword ?? "").trim().toLowerCase();
  return state.orders.filter((order) => {
    if (filters.date && order.date !== filters.date) return false;
    if (filters.workerId && order.workerId !== filters.workerId) return false;
    if (filters.status && order.status !== filters.status) return false;
    if (keyword) {
      const owner = state.owners.find((o) => o.id === order.ownerId);
      const worker = state.workers.find((w) => w.id === order.workerId);
      const haystack = [
        order.title,
        order.description,
        owner?.name ?? "",
        owner?.address ?? "",
        worker?.name ?? ""
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

export function sortOrders(orders, mode = "time") {
  const byTime = (a, b) =>
    a.date.localeCompare(b.date) ||
    SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] ||
    URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
    a.createdAt.localeCompare(b.createdAt);
  const byUrgency = (a, b) =>
    URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
    a.date.localeCompare(b.date) ||
    SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] ||
    a.createdAt.localeCompare(b.createdAt);
  return [...orders].sort(mode === "urgency" ? byUrgency : byTime);
}

// ---------- 统计 ----------

// 以周一为一周开始，返回 [周一, 周日] 的 YYYY-MM-DD
export function weekRange(today) {
  const base = new Date(`${today}T00:00:00Z`);
  const day = base.getUTCDay(); // 0=周日
  const mondayOffset = (day + 6) % 7;
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() - mondayOffset);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return [fmt(monday), fmt(sunday)];
}

export function computeStats(state, today = todayStr()) {
  const [weekStart, weekEnd] = weekRange(today);
  const todayVisits = state.orders.filter((o) => o.date === today && o.status === "scheduled").length;
  const weekOrders = state.orders.filter(
    (o) => isActive(o) && o.date >= weekStart && o.date <= weekEnd
  ).length;
  const perWorker = state.workers.map((worker) => ({
    workerId: worker.id,
    name: worker.name,
    total: state.orders.filter((o) => o.workerId === worker.id).length,
    active: state.orders.filter((o) => o.workerId === worker.id && isActive(o)).length
  }));
  return {
    todayVisits,
    weekOrders,
    conflictCount: state.conflictLog.length,
    perWorker
  };
}
