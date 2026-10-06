import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, cancelOrder, ConflictError, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, operationSummary, recordPayment, state, timeline, updateCustoms } from './domain.js';

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});

function newDraftOrder(reference: string) {
  return createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: `${reference}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    origin: '上海',
    destination: '汉堡',
    items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }]
  });
}

test('confirm atomically writes confirmed order, timeline audit and exactly one order.confirmed outbox event', () => {
  const order = newDraftOrder('ATOMIC');
  const creditBefore = state.customers.find(item => item.id === 'CUS-001')!.creditUsed;
  const confirmed = confirmOrder('tenant-acme', order.id, 'tester');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.version, order.version + 1);

  const events = state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed');
  assert.equal(events.length, 1, '确认事件必须恰好写入一条');
  assert.equal(events[0].status, 'pending');
  assert.equal(events[0].idempotencyKey, `order.confirmed:${order.id}`);
  assert.equal(events[0].aggregateVersion, confirmed.version);
  assert.deepEqual(events[0].payload, confirmed);

  const audit = timeline('tenant-acme', order.id).filter(item => item.action === 'order.confirmed');
  assert.equal(audit.length, 1);
  assert.equal((audit[0].after as { status: string }).status, 'confirmed');

  const customer = state.customers.find(item => item.id === 'CUS-001')!;
  assert.equal(customer.creditUsed, creditBefore + order.totalAmount);
});

test('repeated confirmation is idempotent: same business result, no duplicate events, audit or credit usage', () => {
  const order = newDraftOrder('IDEMPOTENT');
  const first = confirmOrder('tenant-acme', order.id, 'tester');
  const creditAfterFirst = state.customers.find(item => item.id === 'CUS-001')!.creditUsed;
  const second = confirmOrder('tenant-acme', order.id, 'tester');
  const third = confirmOrder('tenant-acme', order.id, 'tester');

  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 1);
  assert.equal(timeline('tenant-acme', order.id).filter(item => item.action === 'order.confirmed').length, 1);
  assert.equal(state.customers.find(item => item.id === 'CUS-001')!.creditUsed, creditAfterFirst);
});

test('client idempotency key replays the first successful confirmation result', () => {
  const order = newDraftOrder('KEY');
  const first = confirmOrder('tenant-acme', order.id, 'tester', { idempotencyKey: 'request-#77' });
  const replay = confirmOrder('tenant-acme', order.id, 'tester', { idempotencyKey: 'request-#77' });
  assert.deepEqual(replay, first);
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 1);

  // 同一个键用于另一笔订单不应命中历史结果
  const other = newDraftOrder('KEY-OTHER');
  confirmOrder('tenant-acme', other.id, 'tester', { idempotencyKey: 'request-#77' });
  assert.equal(state.outbox.filter(item => item.aggregateId === other.id && item.topic === 'order.confirmed').length, 1);
});

test('failed confirm rolls everything back: order stays draft, no event, no audit, no credit reservation', () => {
  const blockedCustomerId = 'CUS-BLOCKED';
  state.customers.push({ id: blockedCustomerId, tenantId: 'tenant-acme', name: 'Blocked Co', creditLimit: 100000, creditUsed: 0, blocked: true });
  const order = createOrder('tenant-acme', {
    customerId: blockedCustomerId,
    reference: `BLOCKED-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    origin: '上海', destination: '汉堡',
    items: [{ sku: 'SENSOR-X9', description: '传感器', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }]
  });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /冻结/);
  const stored = state.orders.find(item => item.id === order.id)!;
  assert.equal(stored.status, 'draft');
  assert.equal(stored.version, 1);
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 0);
  assert.equal(timeline('tenant-acme', order.id).filter(item => item.action === 'order.confirmed').length, 0);
});

test('outbox write failure during confirm rolls back status and credit reservation atomically', () => {
  const order = newDraftOrder('CRASH');
  const customer = state.customers.find(item => item.id === 'CUS-001')!;
  const creditBefore = customer.creditUsed;
  const auditBefore = state.audit.length;
  const originalUnshift = state.outbox.unshift.bind(state.outbox);
  state.outbox.unshift = ((...items: unknown[]) => {
    if ((items[0] as { topic?: string }).topic === 'order.confirmed') throw new Error('模拟数据库写入失败');
    return originalUnshift(...items as never[]);
  }) as typeof state.outbox.unshift;
  try {
    assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /数据库写入失败/);
  } finally {
    state.outbox.unshift = originalUnshift;
  }
  const stored = state.orders.find(item => item.id === order.id)!;
  assert.equal(stored.status, 'draft', '写入失败时订单不能伪装成已确认');
  assert.equal(stored.version, 1);
  assert.equal(customer.creditUsed, creditBefore, '授信占用必须回滚');
  assert.equal(state.audit.length, auditBefore, '确认审计必须回滚');
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 0);
});

test('expectedVersion resolves confirm-vs-cancel race: stale confirm loses with conflict and no partial effects', () => {
  const order = newDraftOrder('RACE-CANCEL');
  // 并发方先取消成功（版本 1 -> 2）
  const cancelled = cancelOrder('tenant-acme', order.id, 'tester', { expectedVersion: 1 });
  assert.equal(cancelled.status, 'cancelled');
  // 拿着旧版本的确认重试，必须被拒绝
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester', { expectedVersion: 1 }), ConflictError);
  const stored = state.orders.find(item => item.id === order.id)!;
  assert.equal(stored.status, 'cancelled');
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 0);
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.cancelled').length, 1);
});

test('stale expectedVersion is rejected even when the order is already in the requested state', () => {
  const order = newDraftOrder('STALE-VIEW');
  confirmOrder('tenant-acme', order.id, 'tester');
  // 无版本头的重复确认仍然幂等
  assert.equal(confirmOrder('tenant-acme', order.id, 'tester').status, 'confirmed');
  // 但携带过期版本的"确认"代表调用方视图过期，必须收到冲突而非伪装成功
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester', { expectedVersion: 1 }), ConflictError);
  assert.throws(() => cancelOrder('tenant-acme', order.id, 'tester', { expectedVersion: 1 }), ConflictError);
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 1);
});

test('expectedVersion rejects cancel racing with a successful confirm; cancel can then target the new version', () => {
  const order = newDraftOrder('RACE-CONFIRM');
  confirmOrder('tenant-acme', order.id, 'tester'); // 版本 1 -> 2
  assert.throws(() => cancelOrder('tenant-acme', order.id, 'tester', { expectedVersion: 1 }), ConflictError);
  const stored = state.orders.find(item => item.id === order.id)!;
  assert.equal(stored.status, 'confirmed');
  // 使用新版本取消可以成功，并回退授信
  const customer = state.customers.find(item => item.id === 'CUS-001')!;
  const creditWhileConfirmed = customer.creditUsed;
  const cancelled = cancelOrder('tenant-acme', order.id, 'tester', { expectedVersion: 2 });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(customer.creditUsed, creditWhileConfirmed - order.totalAmount);
});

test('allocation failure before commit leaves inventory and order untouched; success is versioned and eventful', () => {
  const order = newDraftOrder('ALLOC-FAIL');
  confirmOrder('tenant-acme', order.id, 'tester');
  const scarce = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: `SCARCE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    origin: '上海', destination: '汉堡',
    items: [{ sku: 'SENSOR-X9', description: '传感器', quantity: 90, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }]
  });
  confirmOrder('tenant-acme', scarce.id, 'tester');
  const reservedBefore = state.inventory.find(item => item.id === 'LOT-001')!.reserved;
  assert.throws(() => allocateOrder('tenant-acme', scarce.id, 'tester'), /库存不足/);
  assert.equal(state.inventory.find(item => item.id === 'LOT-001')!.reserved, reservedBefore, '分配失败不能留下半占用库存');
  assert.equal(state.orders.find(item => item.id === scarce.id)!.status, 'confirmed');

  const allocated = allocateOrder('tenant-acme', order.id, 'tester');
  assert.equal(allocated.status, 'allocated');
  const event = state.outbox.find(item => item.aggregateId === order.id && item.topic === 'inventory.reserved')!;
  assert.equal(event.aggregateVersion, allocated.version);
  assert.equal(event.idempotencyKey, `order.allocated:${order.id}`);
});

test('cancel after allocation atomically releases every active reservation and bumps version consistently', () => {
  const order = newDraftOrder('CANCEL-ALLOC');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const reservations = state.reservations.filter(item => item.orderId === order.id && item.status === 'active');
  assert.ok(reservations.length >= 1);
  const totals = new Map<string, number>();
  for (const reservation of reservations) totals.set(reservation.lotId, (totals.get(reservation.lotId) ?? 0) + reservation.quantity);
  const before = new Map([...totals].map(([lotId, qty]) => [lotId, state.inventory.find(lot => lot.id === lotId)!.reserved - qty]));

  cancelOrder('tenant-acme', order.id, 'tester');
  for (const [lotId, expected] of before) assert.equal(state.inventory.find(lot => lot.id === lotId)!.reserved, expected);
  assert.ok(state.reservations.filter(item => item.orderId === order.id).every(item => item.status === 'released'));
  const event = state.outbox.find(item => item.aggregateId === order.id && item.topic === 'order.cancelled')!;
  assert.equal(event.aggregateVersion, state.orders.find(item => item.id === order.id)!.version);
});

test('customs declaration requires confirmation and shares version with the order atomically', () => {
  const draft = newDraftOrder('CUSTOMS-DRAFT');
  assert.throws(() => createCustomsDeclaration('tenant-acme', { orderId: draft.id }, 'tester'), /确认后才能/);

  const order = newDraftOrder('CUSTOMS-OK');
  const confirmedVersion = confirmOrder('tenant-acme', order.id, 'tester').version;
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id }, 'tester');
  const storedOrder = state.orders.find(item => item.id === order.id)!;
  assert.equal(storedOrder.customsDeclarationId, declaration.id);
  assert.equal(storedOrder.version, confirmedVersion + 1);
  const event = state.outbox.find(item => item.topic === 'customs.created' && item.aggregateId === declaration.id)!;
  assert.equal(event.aggregateVersion, storedOrder.version);

  // 并发取消先行后，持旧版本的报关必须被拒绝且不产生第二份申报
  const other = newDraftOrder('CUSTOMS-RACE');
  const v = confirmOrder('tenant-acme', other.id, 'tester').version;
  cancelOrder('tenant-acme', other.id, 'tester', { expectedVersion: v });
  assert.throws(() => createCustomsDeclaration('tenant-acme', { orderId: other.id }, 'tester', { expectedVersion: v }), ConflictError);
  assert.equal(state.customs.filter(item => item.orderId === other.id).length, 0);
});
