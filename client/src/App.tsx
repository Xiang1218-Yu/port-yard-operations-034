import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Dashboard = { activeVoyages: number; berthMoves: number; yardUtilization: number; gateQueue: number; pendingTasks: number; blockedTasks: number; reeferAlerts: number; hazmatHolds: number; lateVessels: number };
type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; size: '20'|'40'|'45'; isoType: string; direction: 'import'|'export'|'transshipment'; status: string; weightT: number; reefer: boolean; temperature?: number; hazmatClass?: string; customs: 'released'|'inspection'|'hold'; priority: string; yardSlot: string; appointmentId?: string; lastEvent: string };
type Block = { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; heat: number; utilization: number; freeSlots: number; pressure: string };
type Conflict = { severity: string; appointmentId: string; reason: string };
type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: 'north'|'south'|'rail'; status: string; exception?: string };
type Task = { id: string; kind: string; containerId: string; from: string; to: string; equipmentId?: string; priority: number; score: number; status: string; blockingReasons: string[]; estimatedMinutes: number; scheduledAt: string };
type Equipment = { id: string; name: string; kind: string; status: string; location: string; battery: number; queue: number; movesPerHour: number };
type Section = 'control'|'containers'|'gate'|'yard'|'tasks';
type Editor = { entity: 'container'|'appointment'|'task'; mode: 'create'|'edit'; id?: string; values: Record<string, string|boolean> };
type BreakdownTaskRow = { task: Task; score: number; container?: Container; orphan: boolean; priorityBasis: string[] };
type MovesBreakdown = {
  voyage: Voyage; departed: boolean;
  accounting: { planned: number; done: number; remaining: number; openTaskMoves: number; gapMoves: number; overrunMoves: number };
  byContainerStatus: { key: string; label: string; count: number }[];
  byTaskKind: { key: string; label: string; count: number; blocked: number }[];
  byBlockingReason: { reason: string; count: number; taskRefs: { taskId: string; containerId: string }[] }[];
  rows: BreakdownTaskRow[]; untaskedContainers: Container[];
  dataGaps: { code: string; severity: 'warning'|'critical'; message: string }[];
};
type Drill = { scope: 'container'|'task'; containerId?: string; taskId?: string; voyageId?: string; statusKey?: string; taskKind?: string; reason?: string; label: string };

const TASK_KIND_LABELS: Record<string, string> = { receive: '进场接箱', deliver: '提箱送闸', rehandle: '翻箱移位', load: '装船', discharge: '卸船', inspect: '海关查验' };
const CONTAINER_STATUS_LABELS: Record<string, string> = { 'in-transit': '在途未进场', 'at-gate': '闸口待作业', 'in-yard': '场内堆存', 'on-quay': '码头边待吊', hold: '挂起待处理', released: '已放行离场' };
const TASK_STATUS_LABELS: Record<string, string> = { queued: '排队中', assigned: '已指派', executing: '执行中', blocked: '阻塞', done: '已完成' };
const PRIORITY_LABELS: Record<string, string> = { normal: '普通', hot: '急箱', reefer: '冷藏优先', hazmat: '危险品监管' };
const taskKindLabel = (kind: string) => TASK_KIND_LABELS[kind] ?? kind;
const containerStatusLabel = (status: string) => CONTAINER_STATUS_LABELS[status] ?? status;
const taskStatusLabel = (status: string) => TASK_STATUS_LABELS[status] ?? status;
const priorityLabel = (priority: string) => PRIORITY_LABELS[priority] ?? priority;

// 判断箱务是否属于某航次且未放行（任务页按航次筛选时复用）
const isVoyageOpenContainer = (container: Container, voyageId: string) => container.voyageId === voyageId && container.status !== 'released';

const api = '/api';
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
  const [breakdownId, setBreakdownId] = useState<string>();
  const [drill, setDrill] = useState<Drill>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
  const remaining = selected ? selected.movesPlanned - selected.movesDone : 0;

  // 从分解视图跳到箱务/任务页：关闭弹窗、切页、按分解维度筛选并高亮具体行
  const applyDrill = useCallback((next: Drill) => {
    setBreakdownId(undefined);
    setDrill(current => current?.label === next.label && current.scope === next.scope && (current.taskId === next.taskId || current.containerId === next.containerId) ? undefined : next);
    setTab(next.scope === 'container' ? 'containers' : 'tasks');
  }, []);
  // 从分解视图为“有箱无任务”的缺口箱直接预填新建任务
  const createTaskForContainer = useCallback((container: Container) => {
    setBreakdownId(undefined); setError('');
    setEditor({ entity: 'task', mode: 'create', values: { ...defaultValues('task'), containerId: container.id } });
    setTab('tasks');
  }, []);
  const shownContainers = useMemo(() => drill?.scope === 'container' ? containers.filter(c => {
    if (drill.containerId) return c.id === drill.containerId;
    return c.voyageId === drill.voyageId && (!drill.statusKey || c.status === drill.statusKey);
  }) : containers, [drill, containers]);
  const shownTasks = useMemo(() => drill?.scope === 'task' ? tasks.filter(t => {
    if (drill.taskId) return t.id === drill.taskId;
    const container = containers.find(c => c.id === t.containerId);
    if (drill.voyageId) {
      const belongs = container ? container.voyageId === drill.voyageId : t.to.includes(drill.voyageId) || t.from.includes(drill.voyageId);
      if (!belongs) return false;
    }
    if (drill.statusKey && container && container.status !== drill.statusKey) return false;
    if (drill.taskKind && t.kind !== drill.taskKind) return false;
    if (drill.reason && !t.blockingReasons.includes(drill.reason)) return false;
    return true;
  }) : tasks, [drill, tasks, containers]);
  const spotlightRef = useCallback((row: HTMLElement | null, match: boolean) => { if (row && match) setTimeout(() => row.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60); }, []);
  const maxHeat = useMemo(() => Math.max(...blocks.map(block => block.heat), 1), [blocks]);

  if (!dashboard && error) return <main className="connection-error"><div className="eyebrow">API CONNECTION ERROR</div><h1>无法连接港口作业服务</h1><p>{error}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5178 和 API 4107 均已启动。</p><button onClick={() => { setError(''); void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }}>重新连接</button></main>;
  if (!dashboard) return <div className="loading">正在连接码头实时作业中台…</div>;

  return <main>
    <header><div><div className="eyebrow">PORT OPS / YARD & GATE CONTROL</div><h1>HarborGrid <span>港口集装箱堆场协同与闸口调度</span></h1><p>把船期、箱务、堆场容量、危险品/冷藏约束、闸口预约与场内设备任务放在同一条作业链路上。</p></div><div className="header-right"><span className="live"><i/> TOS LINKED</span><span className="clock">LIVE · {new Date().toLocaleTimeString()}</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <section className="kpis"><div><small>ACTIVE VESSELS</small><b>{dashboard.activeVoyages}<em> 艘</em></b><span>{dashboard.lateVessels} 艘存在延误风险</span></div><div><small>YARD UTILIZATION</small><b>{pct(dashboard.yardUtilization)}</b><span>可用堆位 / 危险品隔离纳管</span></div><div><small>GATE QUEUE</small><b>{dashboard.gateQueue}<em> 车</em></b><span>预约、已进场与车道排队</span></div><div><small>EXCEPTIONS</small><b>{dashboard.blockedTasks + dashboard.reeferAlerts + dashboard.hazmatHolds}<em> 项</em></b><span>{dashboard.blockedTasks} 作业阻塞 · {dashboard.reeferAlerts} 冷藏告警</span></div></section>
    <nav className="tabs"><button className={tab==='control'?'active':''} onClick={() => setTab('control')}>作业驾驶舱</button><button className={tab==='containers'?'active':''} onClick={() => setTab('containers')}>箱务台账 / CRUD</button><button className={tab==='gate'?'active':''} onClick={() => setTab('gate')}>闸口预约</button><button className={tab==='yard'?'active':''} onClick={() => setTab('yard')}>堆场热区</button><button className={tab==='tasks'?'active':''} onClick={() => setTab('tasks')}>设备任务</button><span>最后同步 {new Date().toLocaleTimeString()}</span></nav>
    {tab === 'control' && <div className="layout"><section className="panel vessel-panel"><div className="panel-head"><div><div className="eyebrow">VESSEL WINDOW / 船期窗口</div><h2>泊位作业进度</h2></div><span className="muted">点击右侧 REMAINING 查看未完成作业分解</span></div>{voyages.map(voyage => <button key={voyage.id} className={`vessel ${selectedVoyage===voyage.id?'selected':''}`} onClick={() => setSelectedVoyage(voyage.id)}><span className={`vessel-dot ${voyage.status}`}/><span className="vessel-main"><b>{voyage.vessel}</b><small>{voyage.id} · {voyage.service} · {voyage.berth}</small><i><em style={{ width: `${Math.min(100, voyage.movesDone / voyage.movesPlanned * 100)}%` }}/></i></span><span className="vessel-move"><b>{voyage.movesDone.toLocaleString()}</b><small>/ {voyage.movesPlanned.toLocaleString()} moves</small></span><strong className={voyage.lateRisk}>{voyage.lateRisk==='high'?'HIGH':voyage.lateRisk==='medium'?'WATCH':'ON TIME'}</strong></button>)}</section><section className="panel focus-panel"><div className="panel-head"><div><div className="eyebrow">SELECTED VOYAGE / {selected?.id}</div><h2>{selected?.vessel}</h2></div><span className={`badge ${selected?.lateRisk}`}>{selected?.status}</span></div><div className="voyage-stats"><div><small>ETA</small><b>{selected&&time(selected.eta)}</b><span>预计靠泊</span></div><div><small>ETD</small><b>{selected&&time(selected.etd)}</b><span>计划离港</span></div><div><small>REMAINING</small>{selected && (selected.status === 'departed'
  ? <button type="button" className="remaining-trigger departed" title="已离港航次：打开只用于核对的分解视图" onClick={() => setBreakdownId(selected.id)}><b>{remaining}</b><i className="lock-tag">已离港 · 对账</i></button>
  : <button type="button" className="remaining-trigger" title="按箱务状态 / 任务类型 / 阻塞原因 / 优先级查看剩余 moves 分解" onClick={() => setBreakdownId(selected.id)}><b>{remaining}</b><i className="drill-hint">查看分解 →</i></button>)}<span>{selected?.status === 'departed' ? '非现场待执行作业' : '剩余 moves · 点击分解'}</span></div></div><div className="berth-map"><div className="water"><span>岸线 / BERTH</span><i className="ship" style={{ left: `${selected?.berth==='B07'?50:24}%` }}>{selected?.vessel}</i><b>B01</b><b>B04</b><b>B07</b><b>B10</b></div></div><div className="callout"><strong>调度策略</strong><span>已把 {dashboard.blockedTasks} 个阻塞任务、{dashboard.gateQueue} 车闸口压力纳入当前窗口；优先保护冷藏与危险品安全约束。</span></div></section><section className="panel wide"><div className="panel-head"><h3>异常与联动信号</h3><span>{conflicts.length} gate conflicts detected</span></div><div className="signal-grid"><div><strong className="critical">{dashboard.blockedTasks}</strong><span>设备/约束阻塞</span><small>最高优先级：海关查验任务</small></div><div><strong className="warning">{conflicts.length}</strong><span>闸口预约冲突</span><small>同车重叠窗口需人工重排</small></div><div><strong className="warning">{dashboard.reeferAlerts}</strong><span>冷藏与温控风险</span><small>查验区电源余量接近阈值</small></div><div><strong className="ok">{equipment.filter(item => item.status==='available').length}</strong><span>可调度设备</span><small>场桥 / 正面吊 / 集卡</small></div></div></section></div>}
    {tab === 'containers' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">CONTAINER REGISTER / CRUD</div><h2>箱务台账</h2><span className="muted">新增、查询、编辑、删除；危险品与冷藏箱受堆场约束校验</span></div><button className="primary-action" onClick={() => openCreate('container')}>＋ 新增箱务</button></div>{drill?.scope === 'container' && <div className="drill-banner"><span>来自剩余 moves 分解 · 当前筛选：<b>{drill.label}</b></span><button type="button" onClick={() => setDrill(undefined)}>清除筛选 ×</button></div>}<div className="table container-table"><div className="tr th"><span>箱号 / 航次</span><span>尺寸 / 流向</span><span>箱况 / 海关</span><span>堆位</span><span>重量 / 属性</span><span>操作</span></div>{shownContainers.map(container => <div className={`tr${drill?.scope === 'container' && drill.containerId === container.id ? ' spotlight' : ''}`} id={`container-row-${container.id}`} key={container.id} ref={row => spotlightRef(row, drill?.scope === 'container' && drill.containerId === container.id)}><span><b>{container.id}</b><small>{container.voyageId} · {container.lastEvent}</small></span><span>{container.size}ft · {container.direction}<small>{container.isoType}</small></span><span><b>{containerStatusLabel(container.status)}</b><small>海关：{container.customs}</small></span><span>{container.yardSlot}</span><span>{container.weightT}t<small>{container.reefer?`冷藏 ${container.temperature}°C`:container.hazmatClass?`危险品 ${container.hazmatClass} 类`:'普通箱'}</small></span><span className="row-actions"><button onClick={() => openEdit('container', container.id, { ...container, weightT: String(container.weightT), temperature: String(container.temperature ?? 4), hazmatClass: container.hazmatClass ?? '' })}>编辑</button><button className="danger-action" onClick={() => void remove('container', container.id)}>删除</button></span></div>)}</div>{shownContainers.length === 0 && <div className="empty-filter">该分解条件下没有匹配的箱务记录——剩余 moves 与箱务台账之间可能存在数据缺口。</div>}</section>}
    {tab === 'gate' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">GATE APPOINTMENT / SLOT CONTROL</div><h2>闸口预约与车道状态</h2><span className="muted">支持新增预约、编辑时隙、签到/完成和删除</span></div><button className="primary-action" onClick={() => openCreate('appointment')}>＋ 新增预约</button></div>{conflicts.map(conflict => <div className="conflict" key={`${conflict.appointmentId}-${conflict.reason}`}><strong>{conflict.severity}</strong><b>{conflict.appointmentId}</b><span>{conflict.reason}</span></div>)}<div className="table"><div className="tr th"><span>预约</span><span>箱号 / 车辆</span><span>窗口</span><span>车道</span><span>状态</span><span>操作</span></div>{appointments.map(appointment => <div className="tr" key={appointment.id}><span><b>{appointment.id}</b><small>{appointment.type}</small></span><span><b>{appointment.containerId}</b><small>{appointment.truckNo} · {appointment.driver}</small></span><span>{time(appointment.windowStart)}—{time(appointment.windowEnd)}</span><span>{appointment.lane}</span><span className={`pill ${appointment.status}`}>{appointment.status}</span><span className="row-actions">{appointment.status==='booked'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'checked-in')}>签到</button>:appointment.status==='checked-in'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'completed')}>完成</button>:null}<button onClick={() => openEdit('appointment', appointment.id, { ...appointment, windowStart: toLocalInput(appointment.windowStart), windowEnd: toLocalInput(appointment.windowEnd) })}>编辑</button><button className="danger-action" onClick={() => void remove('appointment', appointment.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'yard' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">YARD HEATMAP / STACK DENSITY</div><h2>堆场容量与安全约束</h2></div><span className="muted">实时区块压力</span></div><div className="yard-grid">{blocks.map(block => <div className={`block ${block.pressure}`} key={block.id}><div className="block-top"><b>{block.id}</b><strong>{pct(block.utilization)}</strong></div><span>{block.zone}</span><div className="heat"><i style={{ width: `${block.heat / maxHeat * 100}%` }}/></div><div className="block-stats"><span>空位 {block.freeSlots}</span><span>冷插 {block.usedPlugs}/{block.reeferPlugs}</span><span>{block.hazmatAllowed?'危险品可入':'普通区'}</span></div></div>)}</div><div className="yard-note"><span>堆位推荐会同时考虑容量、热区、危险品隔离、冷藏插座和设备可达性。</span><b>A01 → C03 重排建议可释放 21 个低热度堆位</b></div></section>}
    {tab === 'tasks' && <div className="layout"><section className="panel wide"><div className="panel-head"><div><div className="eyebrow">TASK DISPATCH / EQUIPMENT POOL</div><h2>场内任务优先级与设备指派</h2><span className="muted">支持新增、编辑、删除和设备指派</span></div><button className="primary-action" onClick={() => openCreate('task')}>＋ 新建任务</button></div>{drill?.scope === 'task' && <div className="drill-banner"><span>来自剩余 moves 分解 · 当前筛选：<b>{drill.label}</b></span><button type="button" onClick={() => setDrill(undefined)}>清除筛选 ×</button></div>}<div className="table task-table"><div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>优先级</span><span>状态</span><span>设备 / 操作</span></div>{shownTasks.map(task => <div className={`tr${drill?.scope === 'task' && drill.taskId === task.id ? ' spotlight' : ''}`} id={`task-row-${task.id}`} key={task.id} ref={row => spotlightRef(row, drill?.scope === 'task' && drill.taskId === task.id)}><span><b>{task.id}</b><small>{taskKindLabel(task.kind)} · {task.estimatedMinutes}min</small></span><span>{task.containerId}</span><span>{task.from} → {task.to}</span><span className={task.score>95?'critical':''}>{task.score}</span><span><span className={`pill ${task.status}`}>{taskStatusLabel(task.status)}</span>{task.blockingReasons.length>0&&<small className="blocked-text">{task.blockingReasons[0]}</small>}</span><span className="task-actions"><select value={task.equipmentId??''} onChange={event => void assign(task.id, event.target.value)}><option value="">未指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => openEdit('task', task.id, { kind: task.kind, containerId: task.containerId, from: task.from, to: task.to, equipmentId: task.equipmentId ?? '', priority: String(task.priority), estimatedMinutes: String(task.estimatedMinutes), scheduledAt: toLocalInput(task.scheduledAt), status: task.status })}>编辑</button><button className="danger-action" onClick={() => void remove('task', task.id)}>删除</button></span></div>)}</div>{shownTasks.length === 0 && <div className="empty-filter">该分解维度下没有任何现场任务——这部分剩余 moves 当前无人认领，需要尽快补录任务。</div>}</section><section className="panel"><div className="panel-head"><h3>设备池</h3><span>{equipment.length} assets</span></div>{equipment.map(item => <div className="equipment" key={item.id}><i className={`equip-dot ${item.status}`}/><div><b>{item.name}</b><small>{item.location} · 队列 {item.queue}</small></div><strong>{item.battery}%</strong></div>)}</section></div>}
    <footer>HarborGrid · 内存种子数据 + REST API · 箱务台账、闸口预约、场内任务提供完整增删改查操作</footer>
    {breakdownId && <BreakdownModal voyageId={breakdownId} onClose={() => setBreakdownId(undefined)} onDrill={applyDrill} onCreateTask={createTaskForContainer}/>}
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
  </main>;
}

const VOYAGE_STATUS_LABELS: Record<string, string> = { approaching: '在途 approaching', berthed: '靠泊作业 berthed', loading: '装卸中 loading', departed: '已离港 departed' };

function BreakdownModal({ voyageId, onClose, onDrill, onCreateTask }: { voyageId: string; onClose: () => void; onDrill: (drill: Drill) => void; onCreateTask: (container: Container) => void }) {
  const [data, setData] = useState<MovesBreakdown>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    request<MovesBreakdown>(`/voyages/${voyageId}/moves-breakdown`)
      .then(result => { if (active) setData(result); })
      .catch(reason => { if (active) setLoadError(reason instanceof Error ? reason.message : '分解数据加载失败'); });
    return () => { active = false; };
  }, [voyageId]);

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="editor-modal breakdown-modal" role="dialog" aria-modal="true" aria-label="剩余 moves 作业分解">
      <div className="modal-head"><div><div className="eyebrow">MOVES BREAKDOWN / 剩余作业分解</div><h2>{data ? `${data.voyage.vessel} · ${voyageId}` : voyageId}</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div>
      {loadError && <div className="form-error">{loadError}</div>}
      {!data && !loadError && <div className="loading">正在对账任务队列与箱务台账…</div>}
      {data && <>
        {data.departed && <div className="departed-banner"><strong>已离港航次</strong><span>该航次已离港，下面的视图仅用于台账核对；任何未核销 moves 都不是现场待执行作业，也不能再派工。</span></div>}
        {data.dataGaps.map(gap => <div className={`gap-card ${gap.severity}`} key={gap.code}><strong>{gap.severity === 'critical' ? '数据缺口 · 严重' : '数据缺口 · 预警'}</strong><span>{gap.message}</span></div>)}
        {data.departed && data.accounting.remaining === 0 && data.rows.length === 0 && <div className="gap-card ok"><strong>对账一致</strong><span>计划 {data.accounting.planned} / 完成 {data.accounting.done}，无遗留现场作业。</span></div>}
        <div className="account-grid">
          <div><small>计划 moves</small><b>{data.accounting.planned.toLocaleString()}</b></div>
          <div><small>已完成</small><b>{data.accounting.done.toLocaleString()}</b></div>
          <div className={data.accounting.remaining > 0 ? 'pending' : ''}><small>剩余</small><b>{data.accounting.remaining.toLocaleString()}</b></div>
          <div><small>任务已覆盖</small><b>{data.accounting.openTaskMoves}</b><span>未完成任务条数</span></div>
          <div className={data.accounting.gapMoves > 0 ? 'gap' : ''}><small>无任务认领</small><b>{data.accounting.gapMoves}</b><span>数据缺口</span></div>
        </div>
        <p className="reconcile-note">口径说明：1 条未完成任务计 1 个 move。剩余 moves 与任务覆盖数对不上的部分会显式标为数据缺口，而不会被伪装成现场作业。</p>

        <h4 className="breakdown-h4">按箱务状态</h4>
        <div className="breakdown-grid">
          {data.byContainerStatus.map(group => <button type="button" className="breakdown-chip" key={group.key} onClick={() => onDrill({ scope: 'task', voyageId, statusKey: group.key, label: `${group.label}（${group.count} 条任务）` })}><span>{group.label}</span><b>{group.count}</b><i>任务页 →</i></button>)}
          {data.byContainerStatus.length === 0 && <span className="breakdown-empty">当前没有可对应到箱务状态的未完成任务。</span>}
        </div>

        <h4 className="breakdown-h4">按任务类型</h4>
        <div className="breakdown-grid">
          {data.byTaskKind.map(group => <button type="button" className="breakdown-chip" key={group.key} onClick={() => onDrill({ scope: 'task', voyageId, taskKind: group.key, label: `${group.label}（${group.count} 条${group.blocked ? `，${group.blocked} 条阻塞` : ''}）` })}><span>{group.label}</span><b>{group.count}</b>{group.blocked > 0 && <em className="chip-blocked">{group.blocked} 阻塞</em>}<i>任务页 →</i></button>)}
          {data.byTaskKind.length === 0 && <span className="breakdown-empty">任务队列里没有任何与该航次相关的未完成任务。</span>}
        </div>

        <h4 className="breakdown-h4">按阻塞原因</h4>
        <div className="breakdown-list">
          {data.byBlockingReason.map(group => <button type="button" className="breakdown-row" key={group.reason} onClick={() => onDrill({ scope: 'task', voyageId, reason: group.reason, label: `阻塞原因：${group.reason}（${group.count} 条）` })}><span className="row-title">⚠ {group.reason}</span><span className="row-meta">{group.taskRefs.map(ref => ref.taskId).join('、')} · 影响 {group.count} 条任务</span><i>在任务页查看 →</i></button>)}
          {data.byBlockingReason.length === 0 && <span className="breakdown-empty">未完成任务当前没有记录阻塞原因。</span>}
        </div>

        <h4 className="breakdown-h4">任务明细与优先级说明 <small>点击行跳到任务，点击箱号跳到箱务</small></h4>
        <div className="breakdown-list">
          {data.rows.map(row => <div className={`breakdown-row static ${row.orphan ? 'orphan' : ''}`} key={row.task.id}>
            <div className="row-line"><button type="button" className="link-task" onClick={() => onDrill({ scope: 'task', taskId: row.task.id, label: `任务 ${row.task.id}` })}>{row.task.id}</button><span className={`pill ${row.task.status}`}>{taskStatusLabel(row.task.status)}</span><span>{taskKindLabel(row.task.kind)} · {row.task.from} → {row.task.to} · {time(row.task.scheduledAt)}</span></div>
            <div className="row-line sub">{row.orphan
              ? <><b className="missing-tag">箱务台账缺失</b><span>{row.task.containerId} 在箱务台账中不存在，无法跳转箱务页。</span></>
              : <><button type="button" className="link-container" onClick={() => onDrill({ scope: 'container', containerId: row.task.containerId, label: `箱号 ${row.task.containerId}` })}>{row.task.containerId}</button><span>{row.container && containerStatusLabel(row.container.status)} · {row.container && priorityLabel(row.container.priority)} · {row.container?.yardSlot}</span></>}
              <b className={`score-tag ${row.score > 95 ? 'critical' : ''}`}>评分 {row.score}</b>
            </div>
            <ul className="priority-basis">{row.priorityBasis.map((basis, index) => <li key={index}>{basis}</li>)}</ul>
            {row.task.blockingReasons.length > 0 && <div className="row-blockers">{row.task.blockingReasons.map(reason => <button type="button" key={reason} onClick={() => onDrill({ scope: 'task', reason, label: `阻塞原因：${reason}` })}>{reason} ×</button>)}</div>}
          </div>)}
          {data.rows.length === 0 && <span className="breakdown-empty">{data.departed ? '该航次没有任何未完成任务。' : '剩余 moves 尚未拆成现场任务，请先在任务页补录。'}</span>}
        </div>

        {!data.departed && <h4 className="breakdown-h4">有箱务但没有任务的箱 <small>{data.untaskedContainers.length} 个 · 属于无任务认领缺口的具体实例</small></h4>}
        {!data.departed && <div className="breakdown-list">
          {data.untaskedContainers.map(container => <div className="breakdown-row static gap-row" key={container.id}>
            <div className="row-line"><button type="button" className="link-container" onClick={() => onDrill({ scope: 'container', containerId: container.id, label: `箱号 ${container.id}` })}>{container.id}</button><span>{containerStatusLabel(container.status)} · {priorityLabel(container.priority)} · {container.yardSlot}</span><button type="button" className="mini-action" onClick={() => onCreateTask(container)}>＋ 补录任务</button></div>
          </div>)}
          {data.untaskedContainers.length === 0 && <span className="breakdown-empty">本航次在台账中的未放行箱都已挂上任务。</span>}
          {data.accounting.gapMoves > data.untaskedContainers.length && <div className="gap-note">另有约 {data.accounting.gapMoves - data.untaskedContainers.length} 个剩余 moves 连对应箱务都未在台账中找到，需先与船图/计划系统核对。</div>}
        </div>}
        {data.accounting.overrunMoves > 0 && <div className="gap-card warning"><strong>数据缺口 · 预警</strong><span>未完成任务比剩余 moves 多出 {data.accounting.overrunMoves} 个，存在重复派工或计划漏统，请核对任务归属航次。</span></div>}
      </>}
    </section>
  </div>;
}
