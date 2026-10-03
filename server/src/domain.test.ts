import test from 'node:test'; import assert from 'node:assert/strict'; import { containerPlan, dashboard, gateConflicts, prioritizeTasks, voyageMovesBreakdown } from './domain.js';
test('dashboard aggregates berth, yard, gate and exception signals', () => { const data = dashboard(); assert.equal(data.activeVoyages, 2); assert.ok(data.yardUtilization > 0.7); assert.ok(data.blockedTasks >= 1); });
test('gate conflict engine detects same truck overlap', () => { const conflicts = gateConflicts(); assert.ok(conflicts.some(item => item.appointmentId === 'APT-9001' || item.appointmentId === 'APT-9004')); });
test('yard planner respects reefer and hazmat constraints', () => { const plan = containerPlan('TGHU-9831204'); assert.equal(plan?.recommendedBlock?.hazmatAllowed, true); assert.ok(plan?.reasons.some(reason => reason.includes('危险品'))); });
test('priority queue promotes customs inspection work', () => { const tasks = prioritizeTasks(); assert.equal(tasks[0].containerId, 'TGHU-9831204'); });

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

test('moves breakdown decomposes remaining moves by status, kind, reason and priority', () => {
  const view = voyageMovesBreakdown('VOY-AX7');
  assert.ok(view && !view.closed);
  assert.equal(view.remaining, 354);
  const statusTotal = view.byContainerStatus.reduce((sum, group) => sum + group.count, 0);
  assert.equal(statusTotal, view.accountedMoves);
  const kindTotal = view.byTaskKind.reduce((sum, group) => sum + group.count, 0);
  assert.equal(kindTotal, view.accountedMoves);
  assert.ok(view.byBlockingReason.some(group => group.taskIds.includes('TASK-103')));
  assert.ok(view.byPriority.some(group => group.key === 'urgent' && group.taskIds.includes('TASK-103')));
  // OOLU-7734201 在闸口但没有任何未完成任务，必须作为无任务箱务缺口暴露
  assert.ok(view.dataGap.exists);
  assert.ok(view.dataGap.uncoveredContainerIds.includes('OOLU-7734201'));
  assert.equal(view.dataGap.unaccountedMoves, view.remaining - view.accountedMoves);
});

test('moves breakdown marks departed voyages as closed and never lists live work', () => {
  const view = voyageMovesBreakdown('VOY-RD8');
  assert.ok(view);
  assert.equal(view.closed, true);
  assert.equal(view.remaining, 0);
  assert.equal(view.openTasks.length, 0);
  assert.equal(view.pendingContainers.length, 0);
  assert.equal(view.accountedMoves, 0);
  assert.deepEqual(view.byTaskKind, []);
  assert.equal(view.dataGap.exists, false);
});

test('moves breakdown returns undefined for unknown voyages', () => {
  assert.equal(voyageMovesBreakdown('VOY-NOPE'), undefined);
});
