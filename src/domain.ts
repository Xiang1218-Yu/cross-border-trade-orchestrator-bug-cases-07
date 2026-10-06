import { randomUUID } from 'node:crypto';

export type OrderStatus = 'draft' | 'confirmed' | 'allocated' | 'dispatched' | 'delivered' | 'closed' | 'cancelled';
export type CustomsStatus = 'draft' | 'submitted' | 'inspection' | 'cleared' | 'rejected';
export type InvoiceStatus = 'issued' | 'partially_paid' | 'paid' | 'void';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** 命令级选项：expectedVersion 用于乐观并发控制，idempotencyKey 用于客户端重试去重。 */
export type CommandOptions = { expectedVersion?: number; idempotencyKey?: string };

/** 并发版本冲突或终态业务冲突，HTTP 层映射为 409。 */
export class ConflictError extends Error {
  readonly code = 'conflict' as const;
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}

type Tenant = { id: string; name: string; creditLimit: number; creditUsed: number; currency: string };
type Customer = { id: string; tenantId: string; name: string; creditLimit: number; creditUsed: number; blocked: boolean; timezone?: string };
type OrderItem = { sku: string; description: string; quantity: number; unitPrice: number; weightKg: number; hsCode: string };
export type Order = { id: string; tenantId: string; customerId: string; reference: string; origin: string; destination: string; priority: 'standard' | 'urgent' | 'critical'; status: OrderStatus; items: OrderItem[]; totalWeightKg: number; subtotal: number; totalAmount: number; currency: string; version: number; shipmentId?: string; customsDeclarationId?: string; invoiceId?: string; createdAt: string; updatedAt: string };
type InventoryLot = { id: string; tenantId: string; warehouse: string; sku: string; available: number; reserved: number; lotCode: string; expiresAt?: string };
type Reservation = { id: string; tenantId: string; orderId: string; lotId: string; sku: string; quantity: number; status: 'active' | 'released' | 'consumed'; createdAt: string };
type ShipmentLeg = { id: string; mode: 'truck' | 'rail' | 'sea' | 'air'; origin: string; destination: string; plannedDeparture: string; plannedArrival: string; actualArrival?: string; status: 'planned' | 'in_transit' | 'arrived' | 'delayed' };
type Shipment = { id: string; tenantId: string; orderId: string; trackingNo: string; legs: ShipmentLeg[]; currentLocation: string; eta: string; status: 'planned' | 'in_transit' | 'delivered' | 'exception'; events: { id: string; code: string; location: string; occurredAt: string; note?: string }[] };
type CustomsDeclaration = { id: string; tenantId: string; orderId: string; country: string; status: CustomsStatus; documentRefs: string[]; requiredDocuments: string[]; riskScore: number; rejectionReason?: string; updatedAt: string };
type InvoiceLine = { code: string; description: string; quantity: number; unitPrice: number; amount: number };
type Invoice = { id: string; tenantId: string; orderId: string; number: string; status: InvoiceStatus; currency: string; lines: InvoiceLine[]; subtotal: number; tax: number; total: number; paid: number; dueDate: string; createdAt: string };
type Payment = { id: string; tenantId: string; invoiceId: string; amount: number; method: 'bank_transfer' | 'card' | 'credit_note'; reference: string; receivedAt: string };
type Approval = { id: string; tenantId: string; orderId: string; type: 'credit_override' | 'customs_exception' | 'delay_compensation'; reason: string; status: ApprovalStatus; decidedBy?: string; comment?: string; createdAt: string; decidedAt?: string };
export type AuditEvent = { id: string; tenantId: string; actor: string; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; at: string };
export type OutboxEvent = { id: string; tenantId: string; topic: string; aggregateId: string; aggregateVersion?: number; idempotencyKey: string; payload: unknown; status: 'pending' | 'published'; attempts: number; createdAt: string };
type IdempotencyRecord = { tenantId: string; command: string; aggregateId: string; key: string; result: unknown; at: string };

type State = { tenants: Tenant[]; customers: Customer[]; orders: Order[]; inventory: InventoryLot[]; reservations: Reservation[]; shipments: Shipment[]; customs: CustomsDeclaration[]; invoices: Invoice[]; payments: Payment[]; approvals: Approval[]; audit: AuditEvent[]; outbox: OutboxEvent[]; idempotency: IdempotencyRecord[] };
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const money = (value: number) => Math.round(value * 100) / 100;

export const state: State = {
  tenants: [{ id: 'tenant-acme', name: 'Acme Global Trading', creditLimit: 250000, creditUsed: 36200, currency: 'USD' }],
  customers: [{ id: 'CUS-001', tenantId: 'tenant-acme', name: 'Northstar Retail GmbH', creditLimit: 100000, creditUsed: 12000, blocked: false, timezone: 'Europe/Berlin' }, { id: 'CUS-002', tenantId: 'tenant-acme', name: 'Pacific Parts Inc.', creditLimit: 50000, creditUsed: 49000, blocked: false, timezone: 'America/Los_Angeles' }],
  orders: [], inventory: [
    { id: 'LOT-001', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'SENSOR-X9', available: 80, reserved: 10, lotCode: 'SX9-2608' },
    { id: 'LOT-002', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'CONTROL-M2', available: 36, reserved: 4, lotCode: 'CM2-2607' },
    { id: 'LOT-003', tenantId: 'tenant-acme', warehouse: 'ROTTERDAM-DC', sku: 'SENSOR-X9', available: 12, reserved: 0, lotCode: 'SX9-2606' }
  ], reservations: [], shipments: [], customs: [], invoices: [], payments: [], approvals: [], audit: [], outbox: [], idempotency: []
};

function tenant(id: string) { const value = state.tenants.find(item => item.id === id); if (!value) throw new Error('租户不存在'); return value; }
function assertTenant<T extends { tenantId: string }>(item: T, tenantId: string) { if (item.tenantId !== tenantId) throw new Error('无权访问其他租户的数据'); return item; }
function customerFor(tenantId: string, customerId: string) { const customer = state.customers.find(item => item.id === customerId && item.tenantId === tenantId); if (!customer) throw new Error('客户不存在'); return customer; }
function orderFor(tenantId: string, orderId: string) { const order = state.orders.find(item => item.id === orderId); if (!order) throw new Error('订单不存在'); return assertTenant(order, tenantId); }
function record(tenantId: string, actor: string, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) { state.audit.unshift({ id: id('AUD'), tenantId, actor, action, entityType, entityId, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after), at: now() }); }
function emit(tenantId: string, topic: string, aggregateId: string, payload: unknown, options?: { idempotencyKey?: string; aggregateVersion?: number }) { const eventId = id('EVT'); state.outbox.unshift({ id: eventId, tenantId, topic, aggregateId, aggregateVersion: options?.aggregateVersion, idempotencyKey: options?.idempotencyKey ?? `${topic}:${aggregateId}:${eventId}`, payload: clone(payload), status: 'pending', attempts: 0, createdAt: now() }); }
function mutate(tenantId: string, actor: string, action: string, type: string, entityId: string, before: unknown, after: unknown, topic: string, options?: { idempotencyKey?: string; aggregateVersion?: number }) { const at = now(); const auditEntry: AuditEvent = { id: id('AUD'), tenantId, actor, action, entityType: type, entityId, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after), at }; state.audit.unshift(auditEntry); state.outbox.unshift({ id: id('EVT'), tenantId, topic, aggregateId: entityId, aggregateVersion: options?.aggregateVersion, idempotencyKey: options?.idempotencyKey ?? `${action}:${entityId}:${auditEntry.id}`, payload: clone(after), status: 'pending', attempts: 0, createdAt: at }); }
function transition(order: Order, next: OrderStatus) { const allowed: Record<OrderStatus, OrderStatus[]> = { draft: ['confirmed', 'cancelled'], confirmed: ['allocated', 'cancelled'], allocated: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['closed', 'dispatched'], closed: [], cancelled: [] }; if (!allowed[order.status].includes(next)) throw new Error(`订单不能从 ${order.status} 变更为 ${next}`); order.status = next; order.version += 1; order.updatedAt = now(); }

// ---------------------------------------------------------------------------
// 可靠提交原语：所有变更先构造成 Mutation，再由 commit 顺序落地；任一写入失败，
// 已落地的变更按逆序回滚，保证 order / inventory / credit / audit / outbox 同成败。
// ---------------------------------------------------------------------------
type Mutation = { apply: () => void; undo: () => void };
function commit(mutations: Mutation[]) {
  const applied: Mutation[] = [];
  try {
    for (const mutation of mutations) { mutation.apply(); applied.push(mutation); }
  } catch (error) {
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      try { applied[index].undo(); } catch { /* 回滚尽力而为，避免覆盖原始错误 */ }
    }
    throw error;
  }
}
function setValue<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): Mutation {
  let previous: T[K];
  return { apply() { previous = target[key]; target[key] = value; }, undo() { target[key] = previous; } };
}
function insert<T>(list: T[], value: T, position: 'unshift' | 'push'): Mutation {
  return {
    apply() { list[position](value); },
    undo() { const index = position === 'unshift' ? list.indexOf(value) : list.lastIndexOf(value); if (index >= 0) list.splice(index, 1); }
  };
}
function buildAudit(tenantId: string, actor: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown, at: string): AuditEvent {
  return { id: id('AUD'), tenantId, actor, action, entityType, entityId, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after), at };
}
function buildEvent(tenantId: string, topic: string, aggregateId: string, payload: unknown, at: string, idempotencyKey: string, aggregateVersion?: number): OutboxEvent {
  return { id: id('EVT'), tenantId, topic, aggregateId, aggregateVersion, idempotencyKey, payload: clone(payload), status: 'pending', attempts: 0, createdAt: at };
}
function assertVersion(order: { id: string; version: number }, expected: number | undefined) {
  if (expected !== undefined && order.version !== expected) throw new ConflictError(`订单 ${order.id} 版本冲突：期望版本 ${expected}，实际版本 ${order.version}`);
}
function replayCommand<T>(tenantId: string, command: string, aggregateId: string, key: string | undefined): T | undefined {
  if (!key) return undefined;
  const found = state.idempotency.find(item => item.tenantId === tenantId && item.command === command && item.aggregateId === aggregateId && item.key === key);
  return found ? clone(found.result) as T : undefined;
}
function rememberCommand(mutations: Mutation[], tenantId: string, command: string, aggregateId: string, key: string | undefined, result: unknown, at: string) {
  if (!key) return;
  mutations.push(insert(state.idempotency, { tenantId, command, aggregateId, key, result: clone(result), at }, 'push'));
}

export function listOrders(tenantId: string, filters: { status?: string; customerId?: string; q?: string } = {}) { tenant(tenantId); return state.orders.filter(item => item.tenantId === tenantId && (!filters.status || item.status === filters.status) && (!filters.customerId || item.customerId === filters.customerId) && (!filters.q || `${item.reference} ${item.destination}`.toLowerCase().includes(filters.q.toLowerCase()))).map(clone); }
export function getOrder(tenantId: string, orderId: string) { return clone(orderFor(tenantId, orderId)); }
export function createOrder(tenantId: string, input: Partial<Order>, actor = 'system') {
  tenant(tenantId); if (!input.customerId || !input.reference || !input.origin || !input.destination || !input.items?.length) throw new Error('客户、参考号、起讫地和订单明细均不能为空');
  if (state.orders.some(item => item.reference === input.reference)) throw new Error('客户参考号已存在');
  const items = input.items.map(item => { if (!item.sku || !item.quantity || item.quantity <= 0 || !item.unitPrice || item.unitPrice < 0 || !item.weightKg || item.weightKg <= 0) throw new Error('订单明细数量、价格和重量必须为正数'); return { sku: item.sku, description: item.description ?? item.sku, quantity: item.quantity, unitPrice: item.unitPrice, weightKg: item.weightKg, hsCode: item.hsCode ?? '0000.00' }; });
  const subtotal = money(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)); const order: Order = { id: id('ORD'), tenantId, customerId: input.customerId, reference: input.reference, origin: input.origin, destination: input.destination, priority: input.priority ?? 'standard', status: 'draft', items, totalWeightKg: money(items.reduce((sum, item) => sum + item.quantity * item.weightKg, 0)), subtotal, totalAmount: subtotal, currency: input.currency ?? tenant(tenantId).currency, version: 1, createdAt: now(), updatedAt: now() };
  state.orders.unshift(order); mutate(tenantId, actor, 'order.created', 'order', order.id, undefined, order, 'order.created'); return clone(order);
}

/**
 * 确认订单：状态变更、授信占用、timeline 审计与 order.confirmed 事件在同一个原子提交中完成。
 * - 已确认订单重复确认：幂等返回同一份业务结果，不再产生事件/审计/授信占用；
 * - 携带 idempotencyKey 的重试：返回该键首次成功提交的结果；
 * - expectedVersion 过期：抛 ConflictError，订单保持原状，防止与取消/分配/报关互相覆盖；
 * - 提交过程中任何写入失败：全部回滚，订单不会伪装成 confirmed，下游也不会收到事件。
 */
export function confirmOrder(tenantId: string, orderId: string, actor = 'system', options: CommandOptions = {}) {
  const order = orderFor(tenantId, orderId);
  const replayed = replayCommand<Order>(tenantId, 'order.confirm', order.id, options.idempotencyKey);
  if (replayed) return replayed;
  if (order.status === 'cancelled') throw new ConflictError(`订单 ${order.id} 已取消，不能确认`);
  assertVersion(order, options.expectedVersion);
  if (order.status === 'confirmed') return clone(order);
  if (order.status !== 'draft') throw new Error(`订单不能从 ${order.status} 变更为 confirmed`);
  const customer = customerFor(tenantId, order.customerId);
  if (customer.blocked) throw new Error('客户已被风控冻结');
  if (customer.creditUsed + order.totalAmount > customer.creditLimit) {
    // 审批申请是独立的业务事件，在确认事务之外落库；订单本身保持 draft。
    const approval = createApproval(tenantId, { orderId, type: 'credit_override', reason: '订单金额超过客户授信额度' }, actor);
    throw new Error(`客户授信不足，需要审批 ${approval.id}`);
  }

  const before = clone(order);
  const at = now();
  const confirmed: Order = { ...clone(order), status: 'confirmed', version: order.version + 1, updatedAt: at };
  const eventKey = `order.confirmed:${order.id}`;
  const mutations: Mutation[] = [
    setValue(customer, 'creditUsed', money(customer.creditUsed + order.totalAmount)),
    setValue(order, 'status', confirmed.status),
    setValue(order, 'version', confirmed.version),
    setValue(order, 'updatedAt', at),
    insert(state.audit, buildAudit(tenantId, actor, 'order.confirmed', 'order', order.id, before, confirmed, at), 'unshift'),
    insert(state.outbox, buildEvent(tenantId, 'order.confirmed', order.id, confirmed, at, eventKey, confirmed.version), 'unshift')
  ];
  rememberCommand(mutations, tenantId, 'order.confirm', order.id, options.idempotencyKey, confirmed, at);
  commit(mutations);
  return clone(confirmed);
}

/**
 * 库存分配：所有库存占用、预留单、订单状态变更与 inventory.reserved 事件原子提交。
 * 数量校验阶段不产生任何副作用；expectedVersion 防止与确认/取消并发覆盖。
 */
export function allocateOrder(tenantId: string, orderId: string, actor = 'system', options: CommandOptions = {}) {
  const order = orderFor(tenantId, orderId);
  const replayed = replayCommand<Order>(tenantId, 'order.allocate', order.id, options.idempotencyKey);
  if (replayed) return replayed;
  if (order.status === 'cancelled') throw new ConflictError(`订单 ${order.id} 已取消，不能分配库存`);
  assertVersion(order, options.expectedVersion);
  if (order.status === 'allocated') return clone(order);
  if (order.status !== 'confirmed') throw new Error(`只有已确认订单才能分配库存，当前状态为 ${order.status}`);

  const before = clone(order);
  const at = now();
  const allocations: Reservation[] = [];
  const lotDeltas = new Map<string, number>();
  // 先纯计算整套分配方案：任何 SKU 库存不足都在提交前抛错，绝不留下半占用的库存。
  for (const item of order.items) {
    let remaining = item.quantity;
    for (const lot of state.inventory.filter(value => value.tenantId === tenantId && value.sku === item.sku && value.available - value.reserved > 0)) {
      const free = lot.available - lot.reserved;
      const qty = Math.min(remaining, free);
      lotDeltas.set(lot.id, (lotDeltas.get(lot.id) ?? 0) + qty);
      allocations.push({ id: id('RSV'), tenantId, orderId, lotId: lot.id, sku: item.sku, quantity: qty, status: 'active', createdAt: at });
      remaining -= qty;
      if (!remaining) break;
    }
    if (remaining) throw new Error(`库存不足：${item.sku} 还缺少 ${remaining}`);
  }

  const allocated: Order = { ...clone(order), status: 'allocated', version: order.version + 1, updatedAt: at };
  const after = { order: allocated, allocations };
  const mutations: Mutation[] = [];
  for (const [lotId, delta] of lotDeltas) {
    const lot = state.inventory.find(value => value.id === lotId)!;
    mutations.push(setValue(lot, 'reserved', lot.reserved + delta));
  }
  for (const reservation of allocations) mutations.push(insert(state.reservations, reservation, 'push'));
  mutations.push(
    setValue(order, 'status', allocated.status),
    setValue(order, 'version', allocated.version),
    setValue(order, 'updatedAt', at),
    insert(state.audit, buildAudit(tenantId, actor, 'order.allocated', 'order', order.id, before, after, at), 'unshift'),
    insert(state.outbox, buildEvent(tenantId, 'inventory.reserved', order.id, after, at, `order.allocated:${order.id}`, allocated.version), 'unshift')
  );
  rememberCommand(mutations, tenantId, 'order.allocate', order.id, options.idempotencyKey, allocated, at);
  commit(mutations);
  return clone(allocated);
}
export function dispatchOrder(tenantId: string, orderId: string, actor = 'system', options: CommandOptions = {}) { const order = orderFor(tenantId, orderId); assertVersion(order, options.expectedVersion); const customs = state.customs.find(item => item.orderId === orderId); if (!customs || customs.status !== 'cleared') throw new Error('海关申报尚未放行'); const reservations = state.reservations.filter(item => item.orderId === orderId && item.status === 'active'); if (!reservations.length) throw new Error('订单没有有效库存分配'); const before = clone(order); transition(order, 'dispatched'); reservations.forEach(reservation => { const lot = state.inventory.find(item => item.id === reservation.lotId)!; lot.available -= reservation.quantity; lot.reserved -= reservation.quantity; reservation.status = 'consumed'; }); const shipment: Shipment = { id: id('SHP'), tenantId, orderId, trackingNo: `CBF${Date.now().toString().slice(-8)}`, legs: [{ id: id('LEG'), mode: 'truck', origin: order.origin, destination: '出口口岸', plannedDeparture: now(), plannedArrival: new Date(Date.now() + 86400000).toISOString(), status: 'planned' }, { id: id('LEG'), mode: 'sea', origin: '出口口岸', destination: order.destination, plannedDeparture: new Date(Date.now() + 172800000).toISOString(), plannedArrival: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned' }], currentLocation: order.origin, eta: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned', events: [] }; state.shipments.push(shipment); order.shipmentId = shipment.id; mutate(tenantId, actor, 'order.dispatched', 'order', order.id, before, { order, shipment }, 'shipment.created', { aggregateVersion: order.version }); return clone(order); }
export function deliverOrder(tenantId: string, orderId: string, actor = 'system', options: CommandOptions = {}) { const order = orderFor(tenantId, orderId); assertVersion(order, options.expectedVersion); const shipment = state.shipments.find(item => item.orderId === orderId); if (!shipment) throw new Error('运输单不存在'); const before = clone(order); transition(order, 'delivered'); shipment.status = 'delivered'; shipment.currentLocation = order.destination; shipment.events.push({ id: id('TRK'), code: 'DELIVERED', location: order.destination, occurredAt: now(), note: '签收完成' }); mutate(tenantId, actor, 'order.delivered', 'order', order.id, before, { order, shipment }, 'shipment.delivered', { aggregateVersion: order.version }); return clone(order); }
export function closeOrder(tenantId: string, orderId: string, actor = 'system', options: CommandOptions = {}) { const order = orderFor(tenantId, orderId); assertVersion(order, options.expectedVersion); const invoice = state.invoices.find(item => item.orderId === orderId); if (!invoice || invoice.status !== 'paid') throw new Error('发票未完成收款核销'); const before = clone(order); transition(order, 'closed'); const customer = customerFor(tenantId, order.customerId); customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.closed', 'order', order.id, before, order, 'order.closed', { aggregateVersion: order.version }); return clone(order); }

/**
 * 取消订单：订单状态、全部有效预留的释放（跨多个库存批次）、授信回退、审计与
 * order.cancelled 事件原子提交；expectedVersion 过期时直接拒绝，避免取消一个已被
 * 确认/分配推进的新版本。
 */
export function cancelOrder(tenantId: string, orderId: string, actor = 'system', options: CommandOptions = {}) {
  const order = orderFor(tenantId, orderId);
  const replayed = replayCommand<Order>(tenantId, 'order.cancel', order.id, options.idempotencyKey);
  if (replayed) return replayed;
  assertVersion(order, options.expectedVersion);
  if (order.status === 'cancelled') throw new ConflictError(`订单 ${order.id} 已取消，不能重复取消`);
  if (['dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('已出运订单不能取消');

  const before = clone(order);
  const at = now();
  const cancelled: Order = { ...clone(order), status: 'cancelled', version: order.version + 1, updatedAt: at };
  const activeReservations = state.reservations.filter(item => item.orderId === orderId && item.status === 'active');
  const releasedByLot = new Map<string, number>();
  for (const reservation of activeReservations) releasedByLot.set(reservation.lotId, (releasedByLot.get(reservation.lotId) ?? 0) + reservation.quantity);
  const customer = customerFor(tenantId, order.customerId);

  const mutations: Mutation[] = [];
  for (const [lotId, qty] of releasedByLot) {
    const lot = state.inventory.find(item => item.id === lotId)!;
    mutations.push(setValue(lot, 'reserved', Math.max(0, lot.reserved - qty)));
  }
  for (const reservation of activeReservations) mutations.push(setValue(reservation, 'status', 'released'));
  if (before.status !== 'draft') mutations.push(setValue(customer, 'creditUsed', money(Math.max(0, customer.creditUsed - order.totalAmount))));
  mutations.push(
    setValue(order, 'status', cancelled.status),
    setValue(order, 'version', cancelled.version),
    setValue(order, 'updatedAt', at),
    insert(state.audit, buildAudit(tenantId, actor, 'order.cancelled', 'order', order.id, before, cancelled, at), 'unshift'),
    insert(state.outbox, buildEvent(tenantId, 'order.cancelled', order.id, cancelled, at, `order.cancelled:${order.id}`, cancelled.version), 'unshift')
  );
  rememberCommand(mutations, tenantId, 'order.cancel', order.id, options.idempotencyKey, cancelled, at);
  commit(mutations);
  return clone(cancelled);
}

/**
 * 发起海关申报：只允许在订单确认之后进行；申报单、订单关联版本号、审计与
 * customs.created 事件原子提交，expectedVersion 防止与确认/取消并发交错。
 */
export function createCustomsDeclaration(tenantId: string, input: { orderId: string; country?: string; requiredDocuments?: string[] }, actor = 'system', options: CommandOptions = {}) {
  const order = orderFor(tenantId, input.orderId);
  const replayed = replayCommand<CustomsDeclaration>(tenantId, 'customs.create', order.id, options.idempotencyKey);
  if (replayed) return replayed;
  if (order.status === 'cancelled') throw new ConflictError(`订单 ${order.id} 已取消，不能发起海关申报`);
  assertVersion(order, options.expectedVersion);
  if (state.customs.some(item => item.orderId === order.id)) throw new Error('订单已有海关申报');
  if (order.status === 'draft') throw new Error('订单确认后才能发起海关申报');

  const at = now();
  const declaration: CustomsDeclaration = { id: id('CUS'), tenantId, orderId: order.id, country: input.country ?? order.destination, status: 'draft', documentRefs: [], requiredDocuments: input.requiredDocuments ?? ['commercial-invoice', 'packing-list', 'origin-certificate'], riskScore: order.priority === 'critical' ? 82 : order.totalWeightKg > 1000 ? 60 : 24, updatedAt: at };
  const linkedVersion = order.version + 1;
  const mutations: Mutation[] = [
    insert(state.customs, declaration, 'push'),
    setValue(order, 'customsDeclarationId', declaration.id),
    setValue(order, 'version', linkedVersion),
    setValue(order, 'updatedAt', at),
    insert(state.audit, buildAudit(tenantId, actor, 'customs.created', 'customs', declaration.id, undefined, declaration, at), 'unshift'),
    insert(state.outbox, buildEvent(tenantId, 'customs.created', declaration.id, declaration, at, `customs.created:${order.id}`, linkedVersion), 'unshift')
  ];
  rememberCommand(mutations, tenantId, 'customs.create', order.id, options.idempotencyKey, declaration, at);
  commit(mutations);
  return clone(declaration);
}
export function updateCustoms(tenantId: string, declarationId: string, input: { status?: CustomsStatus; documentRefs?: string[]; rejectionReason?: string }, actor = 'system') { const declaration = assertTenant(state.customs.find(item => item.id === declarationId) ?? (() => { throw new Error('海关申报不存在'); })(), tenantId); const before = clone(declaration); if (input.documentRefs) declaration.documentRefs = [...new Set(input.documentRefs)]; if (input.status) { if (input.status === 'cleared' && declaration.requiredDocuments.some(doc => !declaration.documentRefs.includes(doc))) throw new Error('放行前必须补齐所有必需单证'); if (input.status === 'inspection' && declaration.status !== 'submitted') throw new Error('只有已提交申报才能进入查验'); declaration.status = input.status; } declaration.rejectionReason = input.rejectionReason; declaration.updatedAt = now(); mutate(tenantId, actor, 'customs.updated', 'customs', declaration.id, before, declaration, 'customs.updated'); return clone(declaration); }
export function addShipmentEvent(tenantId: string, shipmentId: string, input: { code: string; location: string; occurredAt?: string; note?: string }, actor = 'system') { const shipment = assertTenant(state.shipments.find(item => item.id === shipmentId) ?? (() => { throw new Error('运输单不存在'); })(), tenantId); if (!input.code || !input.location) throw new Error('轨迹编码和位置不能为空'); const event = { id: id('TRK'), code: input.code, location: input.location, occurredAt: input.occurredAt ?? now(), note: input.note }; shipment.events.push(event); shipment.currentLocation = input.location; if (input.code === 'DEPARTED') { shipment.status = 'in_transit'; shipment.legs[0].status = 'in_transit'; } if (input.code === 'DELAYED') { shipment.status = 'exception'; shipment.legs.find(leg => leg.status !== 'arrived')!.status = 'delayed'; createApproval(tenantId, { orderId: shipment.orderId, type: 'delay_compensation', reason: `运输轨迹 ${shipment.trackingNo} 发生延误` }, actor); } if (input.code === 'ARRIVED') shipment.legs[shipment.legs.length - 1].status = 'arrived'; record(tenantId, actor, 'shipment.event.added', 'shipment', shipment.id, undefined, event); emit(tenantId, 'shipment.event.added', shipment.id, event); return clone(shipment); }

export function generateInvoice(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const existing = state.invoices.find(item => item.orderId === orderId); if (existing) return clone(existing); if (!['allocated', 'dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('订单完成库存分配后才能开票'); const freight = money(Math.max(120, order.totalWeightKg * (order.priority === 'critical' ? 4.2 : 2.1))); const fuel = money(freight * 0.13); const customsFee = money(95 + order.items.length * 25); const lines: InvoiceLine[] = [{ code: 'GOODS', description: '货物服务费', quantity: 1, unitPrice: order.subtotal, amount: order.subtotal }, { code: 'FREIGHT', description: '跨境运输费', quantity: 1, unitPrice: freight, amount: freight }, { code: 'FUEL', description: '燃油附加费', quantity: 1, unitPrice: fuel, amount: fuel }, { code: 'CUSTOMS', description: '关务服务费', quantity: 1, unitPrice: customsFee, amount: customsFee }]; const subtotal = money(lines.reduce((sum, line) => sum + line.amount, 0)); const tax = money(subtotal * 0.06); const invoice: Invoice = { id: id('INV'), tenantId, orderId, number: `INV-${new Date().getFullYear()}-${String(state.invoices.length + 1).padStart(5, '0')}`, status: 'issued', currency: order.currency, lines, subtotal, tax, total: money(subtotal + tax), paid: 0, dueDate: new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: now() }; state.invoices.push(invoice); order.invoiceId = invoice.id; mutate(tenantId, actor, 'invoice.issued', 'invoice', invoice.id, undefined, invoice, 'invoice.issued'); return clone(invoice); }
export function recordPayment(tenantId: string, input: { invoiceId: string; amount: number; method: Payment['method']; reference: string }, actor = 'system') { const invoice = assertTenant(state.invoices.find(item => item.id === input.invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId); if (!input.amount || input.amount <= 0 || input.amount > invoice.total - invoice.paid + 0.01) throw new Error('收款金额超过发票未核销余额'); const before = clone(invoice); const payment: Payment = { id: id('PAY'), tenantId, invoiceId: invoice.id, amount: money(input.amount), method: input.method, reference: input.reference, receivedAt: now() }; state.payments.push(payment); invoice.paid = money(invoice.paid + payment.amount); invoice.status = invoice.paid >= invoice.total - 0.01 ? 'paid' : 'partially_paid'; if (invoice.status === 'paid') { const order = state.orders.find(item => item.id === invoice.orderId); if (order) order.status = 'closed'; } mutate(tenantId, actor, 'payment.recorded', 'invoice', invoice.id, before, invoice, 'payment.recorded'); return clone(payment); }

export function createApproval(tenantId: string, input: { orderId: string; type: Approval['type']; reason: string }, actor = 'system') { orderFor(tenantId, input.orderId); const approval: Approval = { id: id('APR'), tenantId, orderId: input.orderId, type: input.type, reason: input.reason, status: 'pending', createdAt: now() }; state.approvals.push(approval); record(tenantId, actor, 'approval.created', 'approval', approval.id, undefined, approval); emit(tenantId, 'approval.created', approval.id, approval); return clone(approval); }
export function decideApproval(tenantId: string, approvalId: string, input: { status: Exclude<ApprovalStatus, 'pending'>; comment?: string }, actor: string) { const approval = assertTenant(state.approvals.find(item => item.id === approvalId) ?? (() => { throw new Error('审批不存在'); })(), tenantId); if (approval.status !== 'pending') throw new Error('审批已经决策'); const before = clone(approval); approval.status = input.status; approval.decidedBy = actor; approval.comment = input.comment; approval.decidedAt = now(); if (input.status === 'approved' && approval.type === 'credit_override') { const order = orderFor(tenantId, approval.orderId); const customer = customerFor(tenantId, order.customerId); customer.creditLimit = Math.max(customer.creditLimit, customer.creditUsed + order.totalAmount); } mutate(tenantId, actor, 'approval.decided', 'approval', approval.id, before, approval, 'approval.decided'); return clone(approval); }

export function operationSummary(tenantId: string) { tenant(tenantId); const orders = listOrders(tenantId); const invoices = state.invoices.filter(item => item.tenantId === tenantId); const shipments = state.shipments.filter(item => item.tenantId === tenantId); return { tenantId, generatedAt: now(), orderCount: orders.length, byStatus: orders.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}), grossMerchandiseValue: money(orders.reduce((sum, item) => sum + item.totalAmount, 0)), receivable: money(invoices.reduce((sum, item) => sum + item.total - item.paid, 0)), paid: money(invoices.reduce((sum, item) => sum + item.paid, 0)), delayedShipments: shipments.filter(item => item.status === 'exception').length, pendingApprovals: state.approvals.filter(item => item.tenantId === tenantId && item.status === 'pending').length, inventory: state.inventory.filter(item => item.tenantId === tenantId).map(item => ({ warehouse: item.warehouse, sku: item.sku, available: item.available, reserved: item.reserved, free: item.available - item.reserved })) }; }
export function timeline(tenantId: string, orderId: string) { const order = orderFor(tenantId, orderId); const relatedIds = new Set([order.id]); const shipment = state.shipments.find(item => item.orderId === orderId); const customs = state.customs.find(item => item.orderId === orderId); const invoice = state.invoices.find(item => item.orderId === orderId); if (shipment) relatedIds.add(shipment.id); if (customs) relatedIds.add(customs.id); if (invoice) relatedIds.add(invoice.id); state.approvals.filter(item => item.orderId === orderId).forEach(item => relatedIds.add(item.id)); return state.audit.filter(item => item.tenantId === tenantId && relatedIds.has(item.entityId)).sort((a, b) => b.at.localeCompare(a.at)).map(clone); }
export function listAudit(tenantId: string, limit = 100) { tenant(tenantId); return state.audit.filter(item => item.tenantId === tenantId).slice(0, Math.min(limit, 500)).map(clone); }
export function listOutbox(tenantId: string, status?: OutboxEvent['status']) { tenant(tenantId); return state.outbox.filter(item => item.tenantId === tenantId && (!status || item.status === status)).map(clone); }
export function publishOutbox(tenantId: string, eventId: string, actor = 'system') { const event = assertTenant(state.outbox.find(item => item.id === eventId) ?? (() => { throw new Error('事件不存在'); })(), tenantId); if (event.status === 'published') return clone(event); const before = { status: event.status, attempts: event.attempts }; event.status = 'published'; event.attempts += 1; record(tenantId, actor, 'outbox.published', 'outbox', event.id, before, event); return clone(event); }


export type OrderPage = { items: Order[]; nextCursor?: string; total: number };
export function listOrdersPage(tenantId: string, input: { cursor?: string; limit?: number } = {}) {
  tenant(tenantId);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const ordered = state.orders.filter(item => item.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const items = ordered.slice(offset, offset + limit).map(clone);
  return { items, nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined, total: ordered.length };
}
export function invoiceOverdue(tenantId: string, invoiceId: string, asOf = new Date()) {
  const invoice = assertTenant(state.invoices.find(item => item.id === invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId);
  const order = orderFor(tenantId, invoice.orderId);
  const customer = customerFor(tenantId, order.customerId);
  const customerDate = asOf.toISOString().slice(0, 10);
  return { invoiceId, overdue: customerDate > invoice.dueDate.slice(0, 10), evaluatedDate: customerDate, customerTimezone: customer.timezone ?? 'UTC' };
}

// seed a coherent flow for demos: one order is allocated, one customs declaration is cleared, and one invoice is partially paid.
const seeded = createOrder('tenant-acme', { customerId: 'CUS-001', reference: 'PO-2026-0918', origin: '上海保税区', destination: '鹿特丹', priority: 'urgent', items: [{ sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 10, unitPrice: 180, weightKg: 2.4, hsCode: '9025.19' }, { sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 4, unitPrice: 420, weightKg: 3.2, hsCode: '8537.10' }] });
confirmOrder('tenant-acme', seeded.id); allocateOrder('tenant-acme', seeded.id); const seededDeclaration = createCustomsDeclaration('tenant-acme', { orderId: seeded.id }); updateCustoms('tenant-acme', seededDeclaration.id, { documentRefs: ['commercial-invoice', 'packing-list', 'origin-certificate'], status: 'submitted' }); updateCustoms('tenant-acme', seededDeclaration.id, { status: 'cleared' }); dispatchOrder('tenant-acme', seeded.id); const seededInvoice = generateInvoice('tenant-acme', seeded.id); recordPayment('tenant-acme', { invoiceId: seededInvoice.id, amount: 500, method: 'bank_transfer', reference: 'BANK-DEMO-001' });
