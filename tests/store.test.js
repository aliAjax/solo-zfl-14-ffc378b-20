import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultState,
  createStorage,
  loadState,
  saveState,
  sanitizeState,
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
  weekRange,
  findConflicts
} from "../src/store.js";

// 内存版 localStorage，可注入故障用于异常恢复测试
function memoryStorage({ failOnSet = false, failOnGet = false } = {}) {
  const map = new Map();
  return {
    getItem(key) {
      if (failOnGet) throw new Error("read denied");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (failOnSet) throw new Error("quota exceeded");
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    }
  };
}

// 构造含 1 业主、2 人员的基础状态
function baseState() {
  const state = defaultState();
  const owner = addOwner(state, { name: "王先生", phone: "138", address: "3栋502" }).owner;
  const w1 = addWorker(state, { name: "张师傅", skills: "水电" }).worker;
  const w2 = addWorker(state, { name: "李师傅", skills: "家电" }).worker;
  return { state, owner, w1, w2 };
}

const NOW = "2026-09-12T08:00:00.000Z";

// ---------- 创建 ----------

test("创建工单：校验通过后为待确认状态，并能持久化往返", () => {
  const { state, owner, w1 } = baseState();
  const result = createOrder(
    state,
    { ownerId: owner.id, workerId: w1.id, title: "水槽渗水", date: "2026-09-13", slot: "morning", urgency: "high" },
    NOW
  );
  assert.equal(result.ok, true);
  assert.equal(result.order.status, "pending");
  assert.equal(state.orders.length, 1);

  const storage = createStorage("t", memoryStorage());
  assert.equal(saveState(storage, state).ok, true);
  const loaded = loadState(storage);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.state, state);
});

test("创建工单：缺字段、日期非法、人员不存在时返回错误且不写入", () => {
  const { state, owner, w1 } = baseState();
  const bad = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "", date: "2026-13-40", slot: "noon" }, NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid");
  assert.ok(bad.errors.title && bad.errors.date && bad.errors.slot);
  assert.equal(state.orders.length, 0);

  const ghost = createOrder(
    state,
    { ownerId: owner.id, workerId: "no-such", title: "灯不亮", date: "2026-09-13", slot: "morning" },
    NOW
  );
  assert.equal(ghost.ok, false);
  assert.ok(ghost.errors.workerId);
  assert.equal(state.orders.length, 0);
});

test("重复预约只保留一次", () => {
  const { state, owner, w1 } = baseState();
  const input = { ownerId: owner.id, workerId: w1.id, title: "水槽渗水", date: "2026-09-13", slot: "morning" };
  const first = createOrder(state, input, NOW);
  const second = createOrder(state, input, NOW);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(state.orders.length, 1);
});

// ---------- 冲突 ----------

test("同一人员同一时段不能接两单，冲突被记录；换时段或换人可创建", () => {
  const { state, owner, w1, w2 } = baseState();
  const mk = (workerId, slot, title) =>
    createOrder(state, { ownerId: owner.id, workerId, title, date: "2026-09-13", slot }, NOW);

  assert.equal(mk(w1.id, "morning", "修水管").ok, true);
  const clash = mk(w1.id, "morning", "修电路");
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, "conflict");
  assert.equal(clash.conflicts.length, 1);
  assert.equal(state.conflictLog.length, 1); // 冲突次数被统计
  assert.equal(state.orders.length, 1);

  assert.equal(mk(w1.id, "afternoon", "修电路").ok, true); // 换时段
  assert.equal(mk(w2.id, "morning", "修电路").ok, true); // 换人
  assert.equal(state.orders.length, 3);
});

test("改期：撞时段会提示并保留原安排，改到空闲时段成功", () => {
  const { state, owner, w1 } = baseState();
  const a = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "A", date: "2026-09-13", slot: "morning" }, NOW).order;
  const b = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "B", date: "2026-09-14", slot: "morning" }, NOW).order;

  const clash = rescheduleOrder(state, b.id, { date: "2026-09-13", slot: "morning" }, NOW);
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, "conflict");
  assert.equal(state.orders.find((o) => o.id === b.id).date, "2026-09-14"); // 原安排不变
  assert.equal(state.conflictLog.length, 1);

  const ok = rescheduleOrder(state, b.id, { date: "2026-09-13", slot: "evening" }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(state.orders.find((o) => o.id === b.id).slot, "evening");
  assert.equal(findConflicts(state, { workerId: w1.id, date: "2026-09-13", slot: "evening" }).length, 1);
  assert.ok(a);
});

test("已完成的工单不再占用时段，可安排新单", () => {
  const { state, owner, w1 } = baseState();
  const done = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "旧单", date: "2026-09-13", slot: "morning" }, NOW).order;
  advanceOrder(state, done.id, {}, NOW);
  advanceOrder(state, done.id, {}, NOW);
  advanceOrder(state, done.id, { visitResult: "已修复" }, NOW);

  const again = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "新单", date: "2026-09-13", slot: "morning" }, NOW);
  assert.equal(again.ok, true);
});

// ---------- 流转 ----------

test("工单按 待确认→已预约→已上门→已完成 单向流转，完成记录回访结果", () => {
  const { state, owner, w1 } = baseState();
  const order = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "修灯", date: "2026-09-13", slot: "morning" }, NOW).order;

  assert.equal(advanceOrder(state, order.id, {}, NOW).order.status, "scheduled");
  assert.equal(advanceOrder(state, order.id, {}, NOW).order.status, "arrived");
  const done = advanceOrder(state, order.id, { visitResult: "业主满意" }, NOW);
  assert.equal(done.order.status, "completed");
  assert.equal(done.order.visitResult, "业主满意");

  const beyond = advanceOrder(state, order.id, {}, NOW);
  assert.equal(beyond.ok, false); // 已完成后不能继续流转
  assert.equal(state.orders.find((o) => o.id === order.id).status, "completed");
});

test("已完成的工单不能改期", () => {
  const { state, owner, w1 } = baseState();
  const order = createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "修灯", date: "2026-09-13", slot: "morning" }, NOW).order;
  advanceOrder(state, order.id, {}, NOW);
  advanceOrder(state, order.id, {}, NOW);
  advanceOrder(state, order.id, { visitResult: "ok" }, NOW);
  const result = rescheduleOrder(state, order.id, { date: "2026-09-15" }, NOW);
  assert.equal(result.ok, false);
});

// ---------- 筛选与排序 ----------

function seedOrders() {
  const { state, owner, w1, w2 } = baseState();
  const mk = (workerId, title, date, slot, urgency, status = "pending") => {
    const o = createOrder(state, { ownerId: owner.id, workerId, title, date, slot, urgency, description: title }, NOW).order;
    o.status = status;
    return o;
  };
  const a = mk(w1.id, "厨房水管漏水", "2026-09-13", "morning", "high", "scheduled");
  const b = mk(w1.id, "卫生间换气扇", "2026-09-13", "afternoon", "low");
  const c = mk(w2.id, "客厅空调不制冷", "2026-09-14", "morning", "medium", "arrived");
  const d = mk(w2.id, "卧室门锁", "2026-09-15", "evening", "high", "completed");
  return { state, owner, w1, w2, a, b, c, d };
}

test("列表按日期、人员、状态和关键词组合筛选", () => {
  const { state, w1, a, b } = seedOrders();
  assert.equal(filterOrders(state, { date: "2026-09-13" }).length, 2);
  assert.equal(filterOrders(state, { workerId: w1.id }).length, 2);
  assert.equal(filterOrders(state, { status: "completed" }).length, 1);
  assert.deepEqual(
    filterOrders(state, { date: "2026-09-13", workerId: w1.id, status: "scheduled" }).map((o) => o.id),
    [a.id]
  );
  // 关键词命中标题 / 人员姓名 / 业主地址
  assert.deepEqual(filterOrders(state, { keyword: "空调" }).map((o) => o.title), ["客厅空调不制冷"]);
  assert.equal(filterOrders(state, { keyword: "张师傅" }).length, 2);
  assert.equal(filterOrders(state, { keyword: "3栋" }).length, 4);
  assert.equal(filterOrders(state, { keyword: "不存在" }).length, 0);
  assert.ok(b);
});

test("按预约时间和紧急程度排序", () => {
  const { state, a, b, c, d } = seedOrders();
  const byTime = sortOrders(state.orders, "time").map((o) => o.id);
  assert.deepEqual(byTime, [a.id, b.id, c.id, d.id]); // 日期升序，同日按时段

  const byUrgency = sortOrders(state.orders, "urgency").map((o) => o.id);
  assert.deepEqual(byUrgency, [a.id, d.id, c.id, b.id]); // 紧急优先，同级按时间
});

// ---------- 统计 ----------

test("统计今日待上门、本周预约、冲突次数和每位人员工单量", () => {
  const { state, owner, w1, w2 } = seedOrders();
  // 制造一次冲突
  createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "撞单", date: "2026-09-13", slot: "morning" }, NOW);

  // 2026-09-13 是周日，本周为 09-07 ~ 09-13
  const stats = computeStats(state, "2026-09-13");
  assert.equal(stats.todayVisits, 1); // 当天 status=scheduled 的工单
  assert.equal(stats.weekOrders, 2); // 本周内未完工：a、b（c/d 在下周）
  assert.equal(stats.conflictCount, 1);

  const perW1 = stats.perWorker.find((p) => p.workerId === w1.id);
  const perW2 = stats.perWorker.find((p) => p.workerId === w2.id);
  assert.deepEqual({ total: perW1.total, active: perW1.active }, { total: 2, active: 2 });
  assert.deepEqual({ total: perW2.total, active: perW2.active }, { total: 2, active: 1 });
});

test("weekRange 以周一为起点", () => {
  assert.deepEqual(weekRange("2026-09-13"), ["2026-09-07", "2026-09-13"]); // 周日
  assert.deepEqual(weekRange("2026-09-14"), ["2026-09-14", "2026-09-20"]); // 周一
});

// ---------- 异常恢复 ----------

test("本地数据损坏时重置为空数据而不是抛错", () => {
  const backend = memoryStorage();
  backend.setItem("t", "{not-json");
  const loaded = loadState(createStorage("t", backend));
  assert.deepEqual(loaded.state, defaultState());
  assert.match(loaded.error, /损坏/);
});

test("存储读写失败时不抛错，返回错误信息", () => {
  const unreadable = loadState(createStorage("t", memoryStorage({ failOnGet: true })));
  assert.deepEqual(unreadable.state, defaultState());
  assert.ok(unreadable.error);

  const unsavable = saveState(createStorage("t", memoryStorage({ failOnSet: true })), defaultState());
  assert.equal(unsavable.ok, false);
  assert.ok(unsavable.error);

  const noBackend = saveState(createStorage("t", null), defaultState());
  assert.equal(noBackend.ok, false);
});

test("sanitizeState 清洗脏数据：去重、剔除非法记录、保留合法工单", () => {
  const state = sanitizeState({
    owners: [{ id: "o1", name: "王先生" }, { name: "" }, null],
    workers: [{ id: "w1", name: "张师傅" }],
    orders: [
      { id: "1", ownerId: "o1", workerId: "w1", title: "修水管", date: "2026-09-13", slot: "morning", urgency: "high", status: "scheduled" },
      { id: "2", ownerId: "o1", workerId: "w1", title: "修水管", date: "2026-09-13", slot: "morning", urgency: "high", status: "scheduled" }, // 重复预约
      { id: "3", ownerId: "o1", workerId: "ghost", title: "坏单", date: "2026-09-13", slot: "morning" }, // 人员不存在
      { id: "4", ownerId: "o1", workerId: "w1", title: "坏日期", date: "09-13", slot: "morning" }, // 日期非法
      { id: "5", ownerId: "o1", workerId: "w1", title: "坏状态", date: "2026-09-13", slot: "evening", status: "weird" }
    ],
    conflictLog: "not-an-array"
  });
  assert.equal(state.owners.length, 1);
  assert.equal(state.workers.length, 1);
  assert.equal(state.orders.length, 2); // 重复与非法记录被剔除
  assert.equal(state.orders[1].status, "pending"); // 非法状态回退为待确认
  assert.deepEqual(state.conflictLog, []);
});

test("删除保护：名下有工单的业主/人员不能删除", () => {
  const { state, owner, w1 } = baseState();
  createOrder(state, { ownerId: owner.id, workerId: w1.id, title: "修灯", date: "2026-09-13", slot: "morning" }, NOW);
  assert.equal(removeOwner(state, owner.id).ok, false);
  assert.equal(removeWorker(state, w1.id).ok, false);
  assert.equal(removeWorker(state, "nobody").ok, false);
  const w2 = state.workers[1];
  assert.equal(removeWorker(state, w2.id).ok, true);
  assert.equal(state.workers.length, 1);
});
