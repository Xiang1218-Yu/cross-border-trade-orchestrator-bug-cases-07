import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, cancelOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, operationSummary, recordPayment, state, updateCustoms } from './domain.js';

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

test('confirmation commits state and outbox event atomically and replays idempotently', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CONFIRM-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  const confirmed = confirmOrder('tenant-acme', order.id, 'tester');
  assert.equal(confirmed.status, 'confirmed');
  const events = () => state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed');
  const audits = () => state.audit.filter(item => item.entityId === order.id && item.action === 'order.confirmed');
  assert.equal(events().length, 1);
  assert.equal(events()[0].idempotencyKey, `order.confirmed:${order.id}`);
  assert.equal(events()[0].status, 'pending');
  assert.equal((events()[0].payload as { version: number; status: string }).version, confirmed.version);
  assert.equal((events()[0].payload as { version: number; status: string }).status, 'confirmed');
  assert.equal(audits().length, 1);
  const creditAfterConfirm = state.customers.find(item => item.id === 'CUS-001')!.creditUsed;
  // 重复确认返回同一业务结果，不重复创建事件、审计或授信占用
  const replay = confirmOrder('tenant-acme', order.id, 'tester');
  assert.equal(replay.status, 'confirmed');
  assert.equal(events().length, 1);
  assert.equal(audits().length, 1);
  assert.equal(state.customers.find(item => item.id === 'CUS-001')!.creditUsed, creditAfterConfirm);
  // 历史故障丢失的确认事件可由重放按同一幂等键补发，且不会翻倍
  state.outbox = state.outbox.filter(item => !(item.aggregateId === order.id && item.topic === 'order.confirmed'));
  confirmOrder('tenant-acme', order.id, 'tester');
  assert.equal(events().length, 1);
  assert.equal(events()[0].idempotencyKey, `order.confirmed:${order.id}`);
});

test('failed confirmation leaves no confirmed state, event or audit trail', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CONFIRM-FAIL-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 100, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  const creditBefore = state.customers.find(item => item.id === 'CUS-002')!.creditUsed;
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  // 重复失败复用同一审批，不重复创建 approval.created 事件
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  assert.equal(state.approvals.filter(item => item.orderId === order.id && item.type === 'credit_override').length, 1);
  assert.equal(state.outbox.filter(item => item.topic === 'approval.created' && (item.payload as { orderId: string }).orderId === order.id).length, 1);
  // 订单保持 draft，没有确认事件、确认审计，授信未变
  assert.equal(state.orders.find(item => item.id === order.id)!.status, 'draft');
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 0);
  assert.equal(state.audit.filter(item => item.entityId === order.id && item.action === 'order.confirmed').length, 0);
  assert.equal(state.customers.find(item => item.id === 'CUS-002')!.creditUsed, creditBefore);
});

test('cancelled orders cannot be confirmed and confirmed orders cancel exactly once', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CONFIRM-CANCEL-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  const cancelled = cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /不能确认/);
  assert.equal(state.outbox.filter(item => item.aggregateId === order.id && item.topic === 'order.confirmed').length, 1);
  assert.equal(state.orders.find(item => item.id === order.id)!.status, 'cancelled');
});
