import test from 'node:test'; import assert from 'node:assert/strict'; import { containerPlan, dashboard, gateConflicts, prioritizeTasks, voyageMovesBreakdown } from './domain.js';
test('dashboard aggregates berth, yard, gate and exception signals', () => { const data = dashboard(); assert.equal(data.activeVoyages, 2); assert.ok(data.yardUtilization > 0.7); assert.ok(data.blockedTasks >= 1); });
test('gate conflict engine detects same truck overlap', () => { const conflicts = gateConflicts(); assert.ok(conflicts.some(item => item.appointmentId === 'APT-9001' || item.appointmentId === 'APT-9004')); });
test('yard planner respects reefer and hazmat constraints', () => { const plan = containerPlan('TGHU-9831204'); assert.equal(plan?.recommendedBlock?.hazmatAllowed, true); assert.ok(plan?.reasons.some(reason => reason.includes('危险品'))); });
test('priority queue promotes customs inspection work', () => { const tasks = prioritizeTasks(); assert.equal(tasks[0].containerId, 'TGHU-9831204'); });

test('voyage moves breakdown reconciles remaining moves against tasks and flags data gaps', () => {
  const breakdown = voyageMovesBreakdown('VOY-AX7');
  assert.ok(breakdown);
  assert.equal(breakdown.departed, false);
  assert.equal(breakdown.accounting.remaining, 354);
  assert.ok(breakdown.byContainerStatus.length > 0);
  assert.ok(breakdown.byTaskKind.length > 0);
  // TASK-103 带两条阻塞原因，必须出现在阻塞原因分组里
  assert.ok(breakdown.byBlockingReason.some(group => group.taskRefs.some(ref => ref.taskId === 'TASK-103')));
  // 任务只覆盖 3 条，剩余 354 moves 中绝大多数没有任务，必须标记数据缺口
  assert.ok(breakdown.dataGaps.some(gap => gap.code === 'uncovered-moves'));
  assert.equal(breakdown.accounting.openTaskMoves + breakdown.accounting.gapMoves - breakdown.accounting.overrunMoves, breakdown.accounting.remaining);
});

test('departed voyage is presented as closed reconciliation, never as live work', () => {
  const departed = voyageMovesBreakdown('VOY-RD8');
  assert.ok(departed);
  assert.equal(departed.departed, true);
  assert.equal(departed.accounting.remaining, 0);
  assert.equal(departed.rows.length, 0);
  assert.deepEqual(departed.dataGaps, []);
});

test('container create, update and delete form a complete audited CRUD cycle', async () => {
  const { createContainer, updateContainer, deleteContainer, containers } = await import('./domain.js');
  const created = createContainer({ id: 'TEST-CRUD-0001', voyageId: 'VOY-AX7', size: '20', isoType: '22G1', direction: 'import', status: 'in-yard', weightT: 10, reefer: false, customs: 'released', priority: 'normal', yardSlot: 'C03-R11-T1' });
  assert.equal(created.id, 'TEST-CRUD-0001');
  assert.equal(updateContainer(created.id, { weightT: 12 })?.weightT, 12);
  assert.equal(deleteContainer(created.id)?.id, 'TEST-CRUD-0001');
  assert.equal(containers.some(item => item.id === 'TEST-CRUD-0001'), false);
});

test('appointment and task domain operations support create, update and delete', async () => {
  const { createGateAppointment, editGateAppointment, deleteGateAppointment, createYardTask, updateYardTask, deleteYardTask } = await import('./domain.js');
  const appointment = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: 'TEST-CRUD-01', driver: '测试司机', type: 'pickup', windowStart: new Date(Date.now()+3600000).toISOString(), windowEnd: new Date(Date.now()+7200000).toISOString(), lane: 'north' });
  assert.equal(editGateAppointment(appointment.id, { driver: '更新司机' })?.driver, '更新司机');
  assert.equal(deleteGateAppointment(appointment.id)?.id, appointment.id);
  const task = createYardTask({ kind: 'deliver', containerId: 'MSCU-4829017', from: 'A01-R01-T1', to: '南闸口', priority: 40, scheduledAt: new Date().toISOString(), estimatedMinutes: 12 });
  assert.equal(updateYardTask(task.id, { to: '北闸口' })?.to, '北闸口');
  assert.equal(deleteYardTask(task.id)?.id, task.id);
});
