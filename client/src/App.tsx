import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Dashboard = { activeVoyages: number; berthMoves: number; yardUtilization: number; gateQueue: number; pendingTasks: number; blockedTasks: number; reeferAlerts: number; hazmatHolds: number; lateVessels: number };
type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; size: '20'|'40'|'45'; isoType: string; direction: 'import'|'export'|'transshipment'; status: string; weightT: number; reefer: boolean; temperature?: number; hazmatClass?: string; customs: 'released'|'inspection'|'hold'; priority: string; yardSlot: string; appointmentId?: string; lastEvent: string };
type Block = { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; heat: number; utilization: number; freeSlots: number; pressure: string };
type Conflict = { severity: string; appointmentId: string; reason: string };
type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: 'north'|'south'|'rail'; status: string; exception?: string };
type Task = { id: string; kind: string; containerId: string; from: string; to: string; equipmentId?: string; priority: number; score: number; status: string; blockingReasons: string[]; estimatedMinutes: number; scheduledAt: string };
type MovesGroup = { key: string; count: number; taskIds: string[]; containerIds: string[] };
type MovesTaskUnit = { taskId: string; kind: string; containerId: string; status: string; priority: number; score: number; blockingReasons: string[]; scheduledAt: string; estimatedMinutes: number; equipmentId?: string };
type MovesContainerUnit = { containerId: string; status: string; direction: string; customs: string; priority: string; yardSlot: string; taskIds: string[] };
type MovesBreakdown = {
  voyage: { id: string; vessel: string; status: string; eta: string; etd: string; berth: string; lateRisk: string };
  closed: boolean; movesPlanned: number; movesDone: number; remaining: number; accountedMoves: number;
  byContainerStatus: MovesGroup[]; byTaskKind: MovesGroup[]; byBlockingReason: MovesGroup[]; byPriority: MovesGroup[];
  openTasks: MovesTaskUnit[]; pendingContainers: MovesContainerUnit[]; staleTasks: MovesTaskUnit[]; staleContainers: MovesContainerUnit[];
  dataGap: { exists: boolean; unaccountedMoves: number; uncoveredContainerIds: string[]; note: string }; generatedAt: string;
};
type DrillTarget = { containerIds?: string[]; taskIds?: string[]; reason?: string };
type Drill = { label: string; voyageId: string; target: DrillTarget };
type Equipment = { id: string; name: string; kind: string; status: string; location: string; battery: number; queue: number; movesPerHour: number };
type Section = 'control'|'containers'|'gate'|'yard'|'tasks';
type Editor = { entity: 'container'|'appointment'|'task'; mode: 'create'|'edit'; id?: string; values: Record<string, string|boolean> };

const api = '/api';
const containerStatusLabels: Record<string, string> = { 'in-transit': '未到港 / 在途', 'at-gate': '在闸口', 'in-yard': '在场', 'on-quay': '在船边', released: '已提离/放行', hold: '挂起', unknown: '箱务缺失' };
const taskKindLabels: Record<string, string> = { receive: '进场收箱', deliver: '提箱出场', rehandle: '翻箱移位', load: '装船', discharge: '卸船', inspect: '海关查验', unplanned: '尚未派任务' };
const priorityLabels: Record<string, string> = { urgent: '紧急 (≥100)', high: '高 (80–99)', medium: '中 (50–79)', normal: '常规 (<50)', unplanned: '未排程（数据缺口）' };
const taskStatusLabels: Record<string, string> = { queued: '待派发', assigned: '已指派', executing: '执行中', blocked: '阻塞', done: '已完成' };
const blockingReasonLabels: Record<string, string> = { unblocked: '暂无阻塞' };
const blockingLabel = (reason: string) => blockingReasonLabels[reason] ?? reason;
const pct = (value: number) => `${Math.round(value * 100)}%`;
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (value?: string) => {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const defaultValues = (entity: Editor['entity']): Record<string, string|boolean> => {
  if (entity === 'container') return { id: '', voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'import', status: 'in-yard', weightT: '20', reefer: false, temperature: '4', hazmatClass: '', customs: 'released', priority: 'normal', yardSlot: 'C03-R01-T1' };
  if (entity === 'appointment') return { containerId: '', truckNo: '', driver: '', type: 'pickup', windowStart: toLocalInput(), windowEnd: toLocalInput(new Date(Date.now() + 60 * 60000).toISOString()), lane: 'north' };
  return { kind: 'receive', containerId: '', from: '闸口', to: 'C03-R01-T1', equipmentId: '', priority: '50', scheduledAt: toLocalInput(), estimatedMinutes: '20', status: 'queued' };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

type BreakdownModalProps = { view: MovesBreakdown; error: string; busy: boolean; onClose: () => void; onJump: (target: DrillTarget, label: string) => void; onCreateTask: (containerId: string) => void };

function BreakdownModal({ view, error, busy, onClose, onJump, onCreateTask }: BreakdownModalProps) {
  const groupChip = (group: MovesGroup, label: string, targetKind: 'task' | 'container') => {
    const target: DrillTarget = targetKind === 'task'
      ? { taskIds: group.taskIds.length ? group.taskIds : undefined, containerIds: group.taskIds.length ? undefined : group.containerIds }
      : { containerIds: group.containerIds };
    return <button key={group.key} type="button" className="drill-chip" onClick={() => onJump(target, label)} title="跳转到对应台账/任务并筛选"><b>{group.count}</b><span>{label}</span><i>查看 →</i></button>;
  };
  const dimCard = (title: string, hint: string, groups: MovesGroup[], labelOf: (key: string) => string, targetKind: 'task' | 'container') => <div className="dim-card">
    <div className="dim-head"><b>{title}</b><small>{hint}</small></div>
    {groups.length ? <div className="dim-chips">{groups.map(group => groupChip(group, labelOf(group.key), targetKind))}</div> : <div className="dim-empty">该航次作业窗口已关闭，无待执行分组</div>}
  </div>;
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="editor-modal breakdown-modal">
      <div className="modal-head"><div><div className="eyebrow">REMAINING MOVES / 剩余作业分解 · {view.voyage.id}</div><h2>{view.voyage.vessel} · {view.closed ? '作业窗口已关闭' : '未完成 moves 明细'}</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div>
      {error && <div className="form-error">{error}</div>}
      <div className="breakdown-kpis">
        <div><small>计划 moves</small><b>{view.movesPlanned.toLocaleString()}</b></div>
        <div><small>已完成</small><b className="ok">{view.movesDone.toLocaleString()}</b></div>
        <div><small>{view.closed ? '剩余 / 待执行' : '剩余 moves'}</small><b className={view.closed ? '' : 'warning'}>{view.remaining.toLocaleString()}</b></div>
        {!view.closed && <div><small>已对上明细</small><b>{view.accountedMoves}</b></div>}
        {!view.closed && <div><small>数据缺口</small><b className={view.dataGap.exists ? 'critical' : 'ok'}>{Math.max(0, view.remaining - view.accountedMoves)}</b></div>}
      </div>
      {view.closed ? <div className="closed-notice"><strong>该航次已离港（{view.voyage.berth}），不存在仍待执行的现场作业。</strong><span>剩余 moves 已按 0 处理；下方仅列出系统中未闭环的台账残留，属于数据治理问题，不会计入调度任务队列。</span></div>
        : view.dataGap.exists && <div className="gap-notice">
          <strong className="warning">⚠ 数据缺口 · {view.dataGap.unaccountedMoves} moves 对不上任务/箱务明细</strong>
          <span>{view.dataGap.note}。计划数字大于可跟踪作业时，不能直接派工，需要先补齐 TOS 作业清单。</span>
          {view.dataGap.uncoveredContainerIds.length > 0 && <div className="gap-boxes"><small>有箱务但无任务的箱：</small>{view.dataGap.uncoveredContainerIds.map(id => <span key={id} className="gap-box"><button type="button" onClick={() => onJump({ containerIds: [id] }, `箱务 ${id}`)}>{id}</button><button type="button" className="primary-action" disabled={busy} onClick={() => onCreateTask(id)}>＋ 建任务</button></span>)}</div>}
        </div>}
      <div className="dim-grid">
        {dimCard('按箱务状态', '点击跳到箱务台账', view.byContainerStatus, key => containerStatusLabels[key] ?? key, 'container')}
        {dimCard('按任务类型', '点击跳到设备任务', view.byTaskKind, key => taskKindLabels[key] ?? key, 'task')}
        {dimCard('按阻塞原因', '点击跳到受阻塞任务', view.byBlockingReason, blockingLabel, 'task')}
        {dimCard('按优先级', '分数 = 优先级 + 状态加权', view.byPriority, key => priorityLabels[key] ?? key, 'task')}
      </div>
      {view.closed ? <div className="drill-lists">
        {view.staleTasks.length > 0 && <div className="drill-col"><div className="dim-head"><b>未关闭任务（台账残留）</b><small>不应再执行，请在任务页核销</small></div>{view.staleTasks.map(task => <div key={task.taskId} className="drill-row stale"><button type="button" onClick={() => onJump({ taskIds: [task.taskId] }, `任务 ${task.taskId}`)}><b>{task.taskId}</b></button><span>{taskKindLabels[task.kind] ?? task.kind} · {task.containerId} · <em>{taskStatusLabels[task.status] ?? task.status}</em></span></div>)}</div>}
        {view.staleContainers.length > 0 && <div className="drill-col"><div className="dim-head"><b>未闭环箱务</b><small>离港后仍未结案的箱记录</small></div>{view.staleContainers.map(container => <div key={container.containerId} className="drill-row stale"><button type="button" onClick={() => onJump({ containerIds: [container.containerId] }, `箱务 ${container.containerId}`)}><b>{container.containerId}</b></button><span>{containerStatusLabels[container.status] ?? container.status} · {container.yardSlot}</span></div>)}</div>}
        {view.staleTasks.length === 0 && view.staleContainers.length === 0 && <div className="dim-empty">无残留记录，作业全部闭环。</div>}
      </div> : <div className="drill-lists">
        <div className="drill-col">
          <div className="dim-head"><b>未完成任务（{view.openTasks.length}）</b><small>按调度分数排序，点任务号跳转</small></div>
          {view.openTasks.length ? view.openTasks.map(task => <div key={task.taskId} className={`drill-row ${task.status === 'blocked' ? 'is-blocked' : ''}`}>
            <button type="button" onClick={() => onJump({ taskIds: [task.taskId] }, `任务 ${task.taskId}`)}><b>{task.taskId}</b></button>
            <span className="drill-line">{taskKindLabels[task.kind] ?? task.kind} · {task.estimatedMinutes}min · 计划 {time(task.scheduledAt)}</span>
            <span className={`pill ${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
            <span className={`drill-score ${task.score > 95 ? 'critical' : ''}`}>分数 {task.score}</span>
            {task.blockingReasons.length > 0 && <small className="blocked-text" title={task.blockingReasons.join('；')}>⛓ {task.blockingReasons.join('；')}</small>}
            <button type="button" className="drill-box-link" onClick={() => onJump({ containerIds: [task.containerId] }, `箱务 ${task.containerId}`)}>{task.containerId} → 箱务</button>
          </div>) : <div className="dim-empty">当前没有可跟踪的未完成任务（可能是缺口的一部分）。</div>}
        </div>
        <div className="drill-col">
          <div className="dim-head"><b>在途/在场未闭环箱（{view.pendingContainers.length}）</b><small>点箱号跳箱务页</small></div>
          {view.pendingContainers.length ? view.pendingContainers.map(container => <div key={container.containerId} className="drill-row">
            <button type="button" onClick={() => onJump({ containerIds: [container.containerId] }, `箱务 ${container.containerId}`)}><b>{container.containerId}</b></button>
            <span className="drill-line">{containerStatusLabels[container.status] ?? container.status} · {container.yardSlot} · 海关 {container.customs}</span>
            <span className={`pill ${container.priority === 'hot' || container.priority === 'hazmat' || container.priority === 'reefer' ? 'warning' : ''}`}>{container.priority}</span>
            {container.taskIds.length ? <button type="button" className="drill-box-link" onClick={() => onJump({ taskIds: container.taskIds }, `${container.containerId} 的任务`)}>{container.taskIds.length} 个任务 →</button> : <em className="gap-inline">无任务 · 缺口</em>}
          </div>) : <div className="dim-empty">该航次箱务均已闭环。</div>}
        </div>
      </div>}
      <div className="modal-actions"><button type="button" onClick={onClose}>关闭</button></div>
    </div>
  </div>;
}

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [voyages, setVoyages] = useState<Voyage[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [tab, setTab] = useState<Section>('control');
  const [selectedVoyage, setSelectedVoyage] = useState('VOY-AX7');
  const [editor, setEditor] = useState<Editor>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [breakdown, setBreakdown] = useState<MovesBreakdown>();
  const [breakdownError, setBreakdownError] = useState('');
  const [drill, setDrill] = useState<Drill>();

  const load = useCallback(async () => {
    const [d, v, ctn, b, cf, a, t, e] = await Promise.all([
      request<Dashboard>('/dashboard'), request<Voyage[]>('/voyages'), request<Container[]>('/containers'),
      request<Block[]>('/yard/heatmap'), request<Conflict[]>('/gate/conflicts'), request<Appointment[]>('/gate/appointments'),
      request<Task[]>('/tasks'), request<Equipment[]>('/equipment')
    ]);
    setDashboard(d); setVoyages(v); setContainers(ctn); setBlocks(b); setConflicts(cf); setAppointments(a); setTasks(t); setEquipment(e);
  }, []);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }, [load]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await load(); setEditor(undefined); setMessage('操作已保存，作业台数据已刷新');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openCreate = (entity: Editor['entity']) => { setError(''); setEditor({ entity, mode: 'create', values: defaultValues(entity) }); };
  const openEdit = (entity: Editor['entity'], id: string, values: Record<string, string|boolean>) => { setError(''); setEditor({ entity, mode: 'edit', id, values: { ...values } }); };
  const updateField = (key: string, value: string|boolean) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current);
  const saveEditor = async (event: FormEvent) => {
    event.preventDefault(); if (!editor) return;
    const { entity, mode, id, values } = editor;
    const payload: Record<string, unknown> = entity === 'container' ? {
      ...(mode === 'create' ? { id: values.id } : {}), voyageId: values.voyageId, size: values.size, isoType: values.isoType,
      direction: values.direction, status: values.status, weightT: Number(values.weightT), reefer: Boolean(values.reefer),
      ...(values.reefer ? { temperature: Number(values.temperature) } : {}), ...(values.hazmatClass ? { hazmatClass: values.hazmatClass } : {}),
      customs: values.customs, priority: values.priority, yardSlot: values.yardSlot
    } : entity === 'appointment' ? {
      containerId: values.containerId, truckNo: values.truckNo, driver: values.driver, type: values.type,
      windowStart: new Date(String(values.windowStart)).toISOString(), windowEnd: new Date(String(values.windowEnd)).toISOString(), lane: values.lane
    } : {
      kind: values.kind, containerId: values.containerId, from: values.from, to: values.to, priority: Number(values.priority),
      scheduledAt: new Date(String(values.scheduledAt)).toISOString(), estimatedMinutes: Number(values.estimatedMinutes),
      ...(values.equipmentId ? { equipmentId: values.equipmentId } : {}), ...(mode === 'edit' ? { status: values.status } : {})
    };
    await mutate(entity === 'container' ? `/containers${mode === 'edit' ? `/${id}` : ''}` : entity === 'appointment' ? `/gate/appointments${mode === 'edit' ? `/${id}` : ''}` : `/tasks${mode === 'edit' ? `/${id}` : ''}`, mode === 'create' ? 'POST' : 'PATCH', payload);
  };
  const remove = async (entity: Editor['entity'], id: string) => {
    if (!window.confirm(`确认删除 ${id}？相关数据的联动处理会写入审计记录。`)) return;
    const path = entity === 'container' ? `/containers/${id}` : entity === 'appointment' ? `/gate/appointments/${id}` : `/tasks/${id}`;
    await mutate(path, 'DELETE');
  };
  const updateAppointmentStatus = async (id: string, status: string) => mutate(`/gate/appointments/${id}`, 'PATCH', { status });
  const assign = async (id: string, equipmentId: string) => equipmentId ? mutate(`/tasks/${id}/assign`, 'PATCH', { equipmentId }) : mutate(`/tasks/${id}`, 'PATCH', { equipmentId: '', status: 'queued' });
  const selected = voyages.find(voyage => voyage.id === selectedVoyage);
  const selectedClosed = selected?.status === 'departed';
  const remaining = selected && !selectedClosed ? Math.max(0, selected.movesPlanned - selected.movesDone) : 0;
  const openBreakdown = async () => {
    setBreakdownError(''); setBreakdown(undefined);
    try { setBreakdown(await request<MovesBreakdown>(`/voyages/${selectedVoyage}/moves-breakdown`)); }
    catch (reason) { setBreakdownError(reason instanceof Error ? reason.message : '分解数据加载失败'); }
  };
  const jumpFromBreakdown = (target: DrillTarget, label: string) => {
    setDrill({ label, voyageId: selectedVoyage, target });
    setBreakdown(undefined);
    setTab(target.taskIds?.length ? 'tasks' : 'containers');
  };
  const createTaskForContainer = (containerId: string) => {
    setBreakdown(undefined); setError('');
    setEditor({ entity: 'task', mode: 'create', values: { ...defaultValues('task'), containerId } });
  };
  const listRefs = new Map<string, HTMLDivElement | null>();
  const visibleContainers = useMemo(() => drill?.target.containerIds ? containers.filter(container => drill.target.containerIds!.includes(container.id)) : containers, [containers, drill]);
  const visibleTasks = useMemo(() => {
    if (!drill) return tasks;
    if (drill.target.taskIds?.length) return tasks.filter(task => drill.target.taskIds!.includes(task.id));
    if (drill.target.containerIds?.length) return tasks.filter(task => drill.target.containerIds!.includes(task.containerId));
    if (drill.target.reason) return tasks.filter(task => task.blockingReasons.includes(drill.target.reason!));
    return tasks;
  }, [tasks, drill]);
  useEffect(() => {
    if (!drill) return;
    const id = drill.target.taskIds?.[0] ?? drill.target.containerIds?.[0];
    const frame = requestAnimationFrame(() => { if (id) listRefs.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    return () => cancelAnimationFrame(frame);
  }, [drill, tab, visibleContainers.length, visibleTasks.length]);
  const maxHeat = useMemo(() => Math.max(...blocks.map(block => block.heat), 1), [blocks]);

  if (!dashboard && error) return <main className="connection-error"><div className="eyebrow">API CONNECTION ERROR</div><h1>无法连接港口作业服务</h1><p>{error}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5178 和 API 4107 均已启动。</p><button onClick={() => { setError(''); void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }}>重新连接</button></main>;
  if (!dashboard) return <div className="loading">正在连接码头实时作业中台…</div>;

  return <main>
    <header><div><div className="eyebrow">PORT OPS / YARD & GATE CONTROL</div><h1>HarborGrid <span>港口集装箱堆场协同与闸口调度</span></h1><p>把船期、箱务、堆场容量、危险品/冷藏约束、闸口预约与场内设备任务放在同一条作业链路上。</p></div><div className="header-right"><span className="live"><i/> TOS LINKED</span><span className="clock">LIVE · {new Date().toLocaleTimeString()}</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <section className="kpis"><div><small>ACTIVE VESSELS</small><b>{dashboard.activeVoyages}<em> 艘</em></b><span>{dashboard.lateVessels} 艘存在延误风险</span></div><div><small>YARD UTILIZATION</small><b>{pct(dashboard.yardUtilization)}</b><span>可用堆位 / 危险品隔离纳管</span></div><div><small>GATE QUEUE</small><b>{dashboard.gateQueue}<em> 车</em></b><span>预约、已进场与车道排队</span></div><div><small>EXCEPTIONS</small><b>{dashboard.blockedTasks + dashboard.reeferAlerts + dashboard.hazmatHolds}<em> 项</em></b><span>{dashboard.blockedTasks} 作业阻塞 · {dashboard.reeferAlerts} 冷藏告警</span></div></section>
    <nav className="tabs"><button className={tab==='control'?'active':''} onClick={() => setTab('control')}>作业驾驶舱</button><button className={tab==='containers'?'active':''} onClick={() => setTab('containers')}>箱务台账 / CRUD</button><button className={tab==='gate'?'active':''} onClick={() => setTab('gate')}>闸口预约</button><button className={tab==='yard'?'active':''} onClick={() => setTab('yard')}>堆场热区</button><button className={tab==='tasks'?'active':''} onClick={() => setTab('tasks')}>设备任务</button><span>最后同步 {new Date().toLocaleTimeString()}</span></nav>
    {tab === 'control' && <div className="layout"><section className="panel vessel-panel"><div className="panel-head"><div><div className="eyebrow">VESSEL WINDOW / 船期窗口</div><h2>泊位作业进度</h2></div><span className="muted">剩余作业动态计算</span></div>{voyages.map(voyage => <button key={voyage.id} className={`vessel ${selectedVoyage===voyage.id?'selected':''}`} onClick={() => setSelectedVoyage(voyage.id)}><span className={`vessel-dot ${voyage.status}`}/><span className="vessel-main"><b>{voyage.vessel}</b><small>{voyage.id} · {voyage.service} · {voyage.berth}</small><i><em style={{ width: `${Math.min(100, voyage.movesDone / voyage.movesPlanned * 100)}%` }}/></i></span><span className="vessel-move"><b>{voyage.movesDone.toLocaleString()}</b><small>/ {voyage.movesPlanned.toLocaleString()} moves</small></span><strong className={voyage.lateRisk}>{voyage.lateRisk==='high'?'HIGH':voyage.lateRisk==='medium'?'WATCH':'ON TIME'}</strong></button>)}</section><section className="panel focus-panel"><div className="panel-head"><div><div className="eyebrow">SELECTED VOYAGE / {selected?.id}</div><h2>{selected?.vessel}</h2></div><span className={`badge ${selected?.lateRisk}`}>{selected?.status}</span></div><div className="voyage-stats"><div><small>ETA</small><b>{selected&&time(selected.eta)}</b><span>预计靠泊</span></div><div><small>ETD</small><b>{selected&&time(selected.etd)}</b><span>计划离港</span></div><div><small>REMAINING</small>{selectedClosed ? <button type="button" className="remaining-trigger closed" onClick={() => void openBreakdown()} title="已离港航次：查看闭环台账与数据残留"><i>已离港 · 查看 →</i></button> : <button type="button" className="remaining-trigger" onClick={() => void openBreakdown()} title="点击分解剩余 moves：箱务状态 / 任务类型 / 阻塞原因 / 优先级">{remaining}<i>分解 →</i></button>}<span>{selectedClosed ? '作业窗口已关闭，不显示待执行作业' : '剩余 moves · 可点击分解'}</span></div></div><div className="berth-map"><div className="water"><span>岸线 / BERTH</span><i className="ship" style={{ left: `${selected?.berth==='B07'?50:24}%` }}>{selected?.vessel}</i><b>B01</b><b>B04</b><b>B07</b><b>B10</b></div></div><div className="callout"><strong>调度策略</strong><span>已把 {dashboard.blockedTasks} 个阻塞任务、{dashboard.gateQueue} 车闸口压力纳入当前窗口；优先保护冷藏与危险品安全约束。</span></div></section><section className="panel wide"><div className="panel-head"><h3>异常与联动信号</h3><span>{conflicts.length} gate conflicts detected</span></div><div className="signal-grid"><div><strong className="critical">{dashboard.blockedTasks}</strong><span>设备/约束阻塞</span><small>最高优先级：海关查验任务</small></div><div><strong className="warning">{conflicts.length}</strong><span>闸口预约冲突</span><small>同车重叠窗口需人工重排</small></div><div><strong className="warning">{dashboard.reeferAlerts}</strong><span>冷藏与温控风险</span><small>查验区电源余量接近阈值</small></div><div><strong className="ok">{equipment.filter(item => item.status==='available').length}</strong><span>可调度设备</span><small>场桥 / 正面吊 / 集卡</small></div></div></section></div>}
    {tab === 'containers' && <>{drill && <section className="panel wide drill-banner"><small>来自航次 {drill.voyageId} 的剩余 moves 分解 · {drill.label} · 命中 {visibleContainers.length} 个箱</small><button type="button" onClick={() => setDrill(undefined)}>清除筛选 ×</button></section>}<section className="panel wide"><div className="panel-head"><div><div className="eyebrow">CONTAINER REGISTER / CRUD</div><h2>箱务台账</h2><span className="muted">新增、查询、编辑、删除；危险品与冷藏箱受堆场约束校验</span></div><button className="primary-action" onClick={() => openCreate('container')}>＋ 新增箱务</button></div><div className="table container-table"><div className="tr th"><span>箱号 / 航次</span><span>尺寸 / 流向</span><span>箱况 / 海关</span><span>堆位</span><span>重量 / 属性</span><span>操作</span></div>{visibleContainers.map(container => <div className={`tr ${drill?.target.containerIds?.includes(container.id) ? 'drill-hit' : ''}`} key={container.id} ref={node => { listRefs.set(container.id, node); }}><span><b>{container.id}</b><small>{container.voyageId} · {container.lastEvent}</small></span><span>{container.size}ft · {container.direction}<small>{container.isoType}</small></span><span><b>{container.status}</b><small>海关：{container.customs}</small></span><span>{container.yardSlot}</span><span>{container.weightT}t<small>{container.reefer?`冷藏 ${container.temperature}°C`:container.hazmatClass?`危险品 ${container.hazmatClass} 类`:'普通箱'}</small></span><span className="row-actions"><button onClick={() => openEdit('container', container.id, { ...container, weightT: String(container.weightT), temperature: String(container.temperature ?? 4), hazmatClass: container.hazmatClass ?? '' })}>编辑</button><button className="danger-action" onClick={() => void remove('container', container.id)}>删除</button></span></div>)}{visibleContainers.length === 0 && <div className="dim-empty">该分解条件下没有命中的箱务记录（可能已提离或数据未同步）。</div>}</div></section></>}
    {tab === 'gate' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">GATE APPOINTMENT / SLOT CONTROL</div><h2>闸口预约与车道状态</h2><span className="muted">支持新增预约、编辑时隙、签到/完成和删除</span></div><button className="primary-action" onClick={() => openCreate('appointment')}>＋ 新增预约</button></div>{conflicts.map(conflict => <div className="conflict" key={`${conflict.appointmentId}-${conflict.reason}`}><strong>{conflict.severity}</strong><b>{conflict.appointmentId}</b><span>{conflict.reason}</span></div>)}<div className="table"><div className="tr th"><span>预约</span><span>箱号 / 车辆</span><span>窗口</span><span>车道</span><span>状态</span><span>操作</span></div>{appointments.map(appointment => <div className="tr" key={appointment.id}><span><b>{appointment.id}</b><small>{appointment.type}</small></span><span><b>{appointment.containerId}</b><small>{appointment.truckNo} · {appointment.driver}</small></span><span>{time(appointment.windowStart)}—{time(appointment.windowEnd)}</span><span>{appointment.lane}</span><span className={`pill ${appointment.status}`}>{appointment.status}</span><span className="row-actions">{appointment.status==='booked'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'checked-in')}>签到</button>:appointment.status==='checked-in'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'completed')}>完成</button>:null}<button onClick={() => openEdit('appointment', appointment.id, { ...appointment, windowStart: toLocalInput(appointment.windowStart), windowEnd: toLocalInput(appointment.windowEnd) })}>编辑</button><button className="danger-action" onClick={() => void remove('appointment', appointment.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'yard' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">YARD HEATMAP / STACK DENSITY</div><h2>堆场容量与安全约束</h2></div><span className="muted">实时区块压力</span></div><div className="yard-grid">{blocks.map(block => <div className={`block ${block.pressure}`} key={block.id}><div className="block-top"><b>{block.id}</b><strong>{pct(block.utilization)}</strong></div><span>{block.zone}</span><div className="heat"><i style={{ width: `${block.heat / maxHeat * 100}%` }}/></div><div className="block-stats"><span>空位 {block.freeSlots}</span><span>冷插 {block.usedPlugs}/{block.reeferPlugs}</span><span>{block.hazmatAllowed?'危险品可入':'普通区'}</span></div></div>)}</div><div className="yard-note"><span>堆位推荐会同时考虑容量、热区、危险品隔离、冷藏插座和设备可达性。</span><b>A01 → C03 重排建议可释放 21 个低热度堆位</b></div></section>}
    {tab === 'tasks' && <div className="layout">{drill && <section className="panel wide drill-banner"><small>来自航次 {drill.voyageId} 的剩余 moves 分解 · {drill.label} · 命中 {visibleTasks.length} 个任务</small><button type="button" onClick={() => setDrill(undefined)}>清除筛选 ×</button></section>}<section className="panel wide"><div className="panel-head"><div><div className="eyebrow">TASK DISPATCH / EQUIPMENT POOL</div><h2>场内任务优先级与设备指派</h2><span className="muted">支持新增、编辑、删除和设备指派</span></div><button className="primary-action" onClick={() => openCreate('task')}>＋ 新建任务</button></div><div className="table task-table"><div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>优先级</span><span>状态</span><span>设备 / 操作</span></div>{visibleTasks.map(task => <div className={`tr ${drill && ((drill.target.taskIds?.includes(task.id)) || (drill.target.containerIds?.includes(task.containerId)) || (drill.target.reason && task.blockingReasons.includes(drill.target.reason))) ? 'drill-hit' : ''}`} key={task.id} ref={node => { listRefs.set(task.id, node); }}><span><b>{task.id}</b><small>{task.kind} · {task.estimatedMinutes}min</small></span><span>{task.containerId}</span><span>{task.from} → {task.to}</span><span className={task.score>95?'critical':''}>{task.score}</span><span><span className={`pill ${task.status}`}>{task.status}</span>{task.blockingReasons.length>0&&<small className="blocked-text">{task.blockingReasons[0]}</small>}</span><span className="task-actions"><select value={task.equipmentId??''} onChange={event => void assign(task.id, event.target.value)}><option value="">未指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => openEdit('task', task.id, { kind: task.kind, containerId: task.containerId, from: task.from, to: task.to, equipmentId: task.equipmentId ?? '', priority: String(task.priority), estimatedMinutes: String(task.estimatedMinutes), scheduledAt: toLocalInput(task.scheduledAt), status: task.status })}>编辑</button><button className="danger-action" onClick={() => void remove('task', task.id)}>删除</button></span></div>)}{visibleTasks.length === 0 && <div className="dim-empty">该分解条件下没有命中的任务——这正是数据缺口：剩余 moves 尚未落到任务队列。</div>}</div></section><section className="panel"><div className="panel-head"><h3>设备池</h3><span>{equipment.length} assets</span></div>{equipment.map(item => <div className="equipment" key={item.id}><i className={`equip-dot ${item.status}`}/><div><b>{item.name}</b><small>{item.location} · 队列 {item.queue}</small></div><strong>{item.battery}%</strong></div>)}</section></div>}
    <footer>HarborGrid · 内存种子数据 + REST API · 箱务台账、闸口预约、场内任务提供完整增删改查操作</footer>
    {editor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setEditor(undefined); }}><form className="editor-modal" onSubmit={saveEditor}><div className="modal-head"><div><div className="eyebrow">{editor.mode.toUpperCase()} / {editor.entity.toUpperCase()}</div><h2>{editor.mode==='create'?'创建':'编辑'}{editor.entity==='container'?'箱务记录':editor.entity==='appointment'?'闸口预约':'作业任务'}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(undefined)}>×</button></div>
      {editor.entity === 'container' && <div className="form-grid">
        <label>集装箱号<input required disabled={editor.mode==='edit'} value={String(editor.values.id)} onChange={event => updateField('id', event.target.value.toUpperCase())}/></label>
        <label>关联航次<select value={String(editor.values.voyageId)} onChange={event => updateField('voyageId', event.target.value)}>{voyages.filter(voyage => voyage.status!=='departed').map(voyage => <option key={voyage.id} value={voyage.id}>{voyage.id} · {voyage.vessel}</option>)}</select></label>
        <label>尺寸<select value={String(editor.values.size)} onChange={event => updateField('size', event.target.value)}><option value="20">20 ft</option><option value="40">40 ft</option><option value="45">45 ft</option></select></label>
        <label>ISO 箱型<input required value={String(editor.values.isoType)} onChange={event => updateField('isoType', event.target.value)}/></label>
        <label>作业流向<select value={String(editor.values.direction)} onChange={event => updateField('direction', event.target.value)}><option value="import">进口</option><option value="export">出口</option><option value="transshipment">中转</option></select></label>
        <label>箱状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['in-transit','at-gate','in-yard','on-quay','released','hold'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>重量 (吨)<input type="number" min="0.1" step="0.1" required value={String(editor.values.weightT)} onChange={event => updateField('weightT', event.target.value)}/></label>
        <label>海关状态<select value={String(editor.values.customs)} onChange={event => updateField('customs', event.target.value)}><option value="released">已放行</option><option value="inspection">查验中</option><option value="hold">扣留</option></select></label>
        <label>优先级<select value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}><option value="normal">普通</option><option value="hot">急箱</option><option value="reefer">冷藏</option><option value="hazmat">危险品</option></select></label>
        <label>堆位<input required placeholder="例如 B07-R03-T2" value={String(editor.values.yardSlot)} onChange={event => updateField('yardSlot', event.target.value.toUpperCase())}/></label>
        <label>危险品类别<input placeholder="非危险品留空" value={String(editor.values.hazmatClass)} onChange={event => updateField('hazmatClass', event.target.value)}/></label>
        <label className="check-label"><input type="checkbox" checked={Boolean(editor.values.reefer)} onChange={event => updateField('reefer', event.target.checked)}/>冷藏箱</label>
        {Boolean(editor.values.reefer) && <label>目标温度 (°C)<input type="number" step="0.1" value={String(editor.values.temperature)} onChange={event => updateField('temperature', event.target.value)}/></label>}
      </div>}
      {editor.entity === 'appointment' && <div className="form-grid">
        <label>集装箱<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id} · {container.status}</option>)}</select></label>
        <label>预约类型<select value={String(editor.values.type)} onChange={event => updateField('type', event.target.value)}><option value="pickup">提箱</option><option value="dropoff">进场</option></select></label>
        <label>车牌号<input required value={String(editor.values.truckNo)} onChange={event => updateField('truckNo', event.target.value)}/></label><label>司机<input required value={String(editor.values.driver)} onChange={event => updateField('driver', event.target.value)}/></label>
        <label>窗口开始<input type="datetime-local" required value={String(editor.values.windowStart)} onChange={event => updateField('windowStart', event.target.value)}/></label><label>窗口结束<input type="datetime-local" required value={String(editor.values.windowEnd)} onChange={event => updateField('windowEnd', event.target.value)}/></label>
        <label>闸口车道<select value={String(editor.values.lane)} onChange={event => updateField('lane', event.target.value)}><option value="north">北闸口</option><option value="south">南闸口</option><option value="rail">铁路闸口</option></select></label>
      </div>}
      {editor.entity === 'task' && <div className="form-grid">
        <label>任务类型<select value={String(editor.values.kind)} onChange={event => updateField('kind', event.target.value)}>{['receive','deliver','rehandle','load','discharge','inspect'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>关联箱号<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id}</option>)}</select></label>
        <label>起点<input required value={String(editor.values.from)} onChange={event => updateField('from', event.target.value)}/></label><label>终点<input required value={String(editor.values.to)} onChange={event => updateField('to', event.target.value)}/></label>
        <label>优先级 (1–100)<input type="number" min="1" max="100" required value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}/></label><label>预计时长 (分钟)<input type="number" min="1" required value={String(editor.values.estimatedMinutes)} onChange={event => updateField('estimatedMinutes', event.target.value)}/></label>
        <label>计划时间<input type="datetime-local" required value={String(editor.values.scheduledAt)} onChange={event => updateField('scheduledAt', event.target.value)}/></label><label>指派设备<select value={String(editor.values.equipmentId)} onChange={event => updateField('equipmentId', event.target.value)}><option value="">暂不指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
        {editor.mode==='edit' && <label>任务状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['queued','assigned','executing','blocked','done'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>}
      {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" onClick={() => setEditor(undefined)}>取消</button><button className="primary-action" disabled={busy}>{busy?'保存中…':'保存'}</button></div>
    </form></div>}
    {breakdown && <BreakdownModal view={breakdown} error={breakdownError} busy={busy} onClose={() => setBreakdown(undefined)} onJump={jumpFromBreakdown} onCreateTask={createTaskForContainer} />}
    {breakdownError && !breakdown && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setBreakdownError(''); }}><div className="editor-modal" style={{ width: 'min(440px,100%)' }}><div className="modal-head"><div><div className="eyebrow">MOVES BREAKDOWN ERROR</div><h2>剩余 moves 分解加载失败</h2></div><button type="button" className="icon-button" onClick={() => setBreakdownError('')}>×</button></div><div className="form-error">{breakdownError}</div><div className="modal-actions"><button type="button" onClick={() => setBreakdownError('')}>关闭</button><button type="button" className="primary-action" onClick={() => void openBreakdown()}>重试</button></div></div></div>}
  </main>;
}
