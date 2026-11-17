"use client";

import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection as RFConnection, type Edge, type Node,
} from "@xyflow/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Bot, CheckCircle2, ChevronDown, Download, History, LayoutGrid, Maximize, Pause, Play, Redo2, Rocket, Save, Search, Undo2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Code, Dialog, Input, StatusBadge, Textarea } from "@/components/ui";
import { ApiError, get, issuesFrom, patch, post } from "@/lib/api";
import { useList, useMe } from "@/lib/hooks";
import type { Agent, Connection, Definition, Execution, Issue, KB, NodeSpec, Workflow } from "@/lib/types";
import { ago, can, money } from "@/lib/utils";
import { Inspector } from "./inspector";
import StudioNode, { ICONS, type StudioNodeData } from "./node";

const nodeTypes = { agentos: StudioNode };
type RFNode = Node<StudioNodeData>;
const TERMINAL = new Set(["completed", "failed", "cancelled", "rejected"]);

export function toRF(defn: Definition, specs: Record<string, NodeSpec>): { nodes: RFNode[]; edges: Edge[] } {
  return {
    nodes: defn.nodes.map((n) => ({ id: n.id, type: "agentos", position: n.position ?? { x: 0, y: 0 },
      data: { kind: n.type, label: n.data?.label, config: n.data?.config ?? {}, spec: specs[n.type] } })),
    edges: defn.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined, animated: false })),
  };
}
export function fromRF(nodes: RFNode[], edges: Edge[]): Definition {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: { label: n.data.label, config: n.data.config } })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle && e.sourceHandle !== "default" ? e.sourceHandle : null })),
  };
}

const newId = (kind: string) => `${kind.split(".").pop()!.replace(/[^a-z]/g, "")}_${Math.random().toString(36).slice(2, 6)}`;

function autoLayout(nodes: RFNode[], edges: Edge[]): RFNode[] {
  const inc = new Map<string, string[]>();
  edges.forEach((e) => inc.set(e.target, [...(inc.get(e.target) ?? []), e.source]));
  const depth = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = Math.max(-1, ...(inc.get(id) ?? []).map((s) => d(s, seen))) + 1;
    depth.set(id, v);
    return v;
  };
  nodes.forEach((n) => d(n.id));
  const rows = new Map<number, number>();
  return nodes.map((n) => {
    const col = depth.get(n.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { ...n, position: { x: col * 290, y: row * 150 } };
  });
}

function Palette({ specs, agents, onAdd }: { specs: Record<string, NodeSpec>; agents: Agent[]; onAdd: (kind: string, extra?: Partial<StudioNodeData>) => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const g: Record<string, [string, NodeSpec][]> = {};
    Object.entries(specs).forEach(([k, s]) => { if (!q || `${s.label} ${s.description} ${s.category}`.toLowerCase().includes(q.toLowerCase())) (g[s.category] ??= []).push([k, s]); });
    return g;
  }, [specs, q]);
  const onDrag = (e: React.DragEvent, payload: object) => { e.dataTransfer.setData("application/agentos", JSON.stringify(payload)); e.dataTransfer.effectAllowed = "move"; };
  const shownAgents = agents.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex h-full flex-col">
      <div className="relative p-3"><Search className="pointer-events-none absolute left-5 top-5.5 h-4 w-4 text-text-3" aria-hidden />
        <Input aria-label="Search components" placeholder="Search components…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="flex-1 space-y-4 overflow-y-auto px-3 pb-6">
        {shownAgents.length > 0 && <div><h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">Your agents</h3>
          {shownAgents.map((a) => (
            <button key={a.id} draggable onDragStart={(e) => onDrag(e, { kind: "agent", label: a.name, config: { agent_id: a.id } })}
              onClick={() => onAdd("agent", { label: a.name, config: { ...defaults(specs.agent), agent_id: a.id } })}
              className="mb-1 flex w-full cursor-grab items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-left text-sm hover:border-accent/50 active:cursor-grabbing">
              <Bot className="h-4 w-4 text-accent" aria-hidden /><span className="truncate">{a.name}</span>{a.status !== "active" && <span className="ml-auto text-[10px] text-text-3">{a.status}</span>}</button>))}
        </div>}
        {Object.entries(groups).map(([cat, items]) => (
          <div key={cat}><h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">{cat}</h3>
            {items.map(([k, s]) => { const Icon = ICONS[s.icon] ?? Bot; return (
              <button key={k} draggable onDragStart={(e) => onDrag(e, { kind: k })} onClick={() => onAdd(k)} title={s.description}
                className="mb-1 flex w-full cursor-grab items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-left text-sm hover:border-accent/50 active:cursor-grabbing">
                <Icon className="h-4 w-4 text-text-2" aria-hidden /><span className="truncate">{s.label}</span></button>); })}
          </div>))}
      </div>
      <p className="border-t border-border p-3 text-xs text-text-3">Drag onto the canvas or click to add.</p>
    </div>
  );
}

function defaults(spec?: NodeSpec): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  spec?.fields.forEach((f) => { if (f.default !== null && f.default !== undefined) c[f.key] = f.default; });
  return c;
}

function Editor({ wf, specs, readOnlyExecution }: { wf: Workflow; specs: Record<string, NodeSpec>; readOnlyExecution?: Execution }) {
  const me = useMe();
  const qc = useQueryClient();
  const rf = useReactFlow();
  const manager = can(me.data?.org?.role, "manager") && !readOnlyExecution;
  const initial = useMemo(() => toRF(readOnlyExecution?.definition ?? wf.draft ?? { nodes: [], edges: [] }, specs), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [validated, setValidated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exec, setExec] = useState<Execution | null>(readOnlyExecution ?? null);
  const [testOpen, setTestOpen] = useState(false);
  const [testInput, setTestInput] = useState("{}");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [webhook, setWebhook] = useState<{ url_path: string; signing_secret: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const agents = useList<Agent[]>(["agents"], "/agents");
  const conns = useList<Connection[]>(["connections"], "/connections");
  const kbs = useList<KB[]>(["kbs"], "/knowledge/bases");
  const history = useRef<{ past: Definition[]; future: Definition[] }>({ past: [], future: [] });
  const clipboard = useRef<RFNode[]>([]);

  const snapshot = useCallback(() => { history.current.past.push(fromRF(nodes, edges)); history.current.future = []; if (history.current.past.length > 100) history.current.past.shift(); setDirty(true); }, [nodes, edges]);
  const restore = (d: Definition) => { const r = toRF(d, specs); setNodes(r.nodes); setEdges(r.edges); setDirty(true); };
  const undo = () => { const p = history.current.past.pop(); if (p) { history.current.future.push(fromRF(nodes, edges)); restore(p); } };
  const redo = () => { const f = history.current.future.pop(); if (f) { history.current.past.push(fromRF(nodes, edges)); restore(f); } };

  // decorate nodes with validation and execution status
  const issueCount = useMemo(() => issues.reduce<Record<string, number>>((a, i) => { if (i.node_id && i.severity === "error") a[i.node_id] = (a[i.node_id] ?? 0) + 1; return a; }, {}), [issues]);
  const runByNode = useMemo(() => Object.fromEntries((exec?.nodes ?? []).map((n) => [n.node_id, n])), [exec]);
  const agentName = useMemo(() => Object.fromEntries((agents.data ?? []).map((a) => [a.id, a.name])), [agents.data]);
  const viewNodes = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, issues: issueCount[n.id], status: exec ? runByNode[n.id]?.status ?? "pending" : undefined,
    subtitle: n.data.kind === "agent" ? agentName[String(n.data.config.agent_id)] && n.data.label !== agentName[String(n.data.config.agent_id)] ? agentName[String(n.data.config.agent_id)] : undefined : undefined } })), [nodes, issueCount, exec, runByNode, agentName]);
  const viewEdges = useMemo(() => edges.map((e) => ({ ...e, animated: !!exec && runByNode[e.source]?.status === "completed" && ["running", "pending", undefined].includes(runByNode[e.target]?.status),
    label: e.sourceHandle && e.sourceHandle !== "default" ? { true: "yes", false: "no", ok: "ok", violation: "rule broken", valid: "valid", invalid: "invalid", error: "on error" }[e.sourceHandle] : undefined,
    labelStyle: { fontSize: 10, fill: "var(--text-3)" }, labelBgStyle: { fill: "var(--bg)" } })), [edges, exec, runByNode]);

  const addNode = useCallback((kind: string, extra: Partial<StudioNodeData> = {}, pos?: { x: number; y: number }) => {
    if (!manager) return;
    snapshot();
    const id = newId(kind);
    const center = pos ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: "agentos", position: center, selected: true,
      data: { kind, label: extra.label ?? specs[kind]?.label, config: { ...defaults(specs[kind]), ...(extra.config ?? {}) }, spec: specs[kind] } }]);
    setSelected(id);
  }, [manager, rf, setNodes, snapshot, specs]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/agentos");
    if (!raw) return;
    const p = JSON.parse(raw) as { kind: string; label?: string; config?: Record<string, unknown> };
    addNode(p.kind, { label: p.label, config: p.config }, rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 30 }));
  };
  const onConnect = useCallback((c: RFConnection) => {
    if (!manager || c.source === c.target) return;
    snapshot();
    setEdges((es) => addEdge({ ...c, id: `e_${Math.random().toString(36).slice(2, 8)}` }, es));
  }, [manager, setEdges, snapshot]);

  const updateNode = (id: string, p: { label?: string; config?: Record<string, unknown> }) => {
    setDirty(true);
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, ...(p.label !== undefined ? { label: p.label } : {}), ...(p.config ? { config: p.config } : {}) } } : n));
  };
  const deleteNodes = (ids: string[]) => { snapshot(); setNodes((ns) => ns.filter((n) => !ids.includes(n.id))); setEdges((es) => es.filter((e) => !ids.includes(e.source) && !ids.includes(e.target))); setSelected(null); };
  const duplicate = (ids: string[]) => {
    snapshot();
    const copies = nodes.filter((n) => ids.includes(n.id)).map((n) => ({ ...n, id: newId(n.data.kind), selected: true, position: { x: n.position.x + 40, y: n.position.y + 40 }, data: { ...n.data, config: structuredClone(n.data.config) } }));
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...copies]);
  };

  const save = useCallback(async (silent = false) => {
    if (!manager) return;
    setSaving(true);
    try {
      const defn = fromRF(nodes, edges);
      await patch(`/workflows/${wf.id}`, { draft: defn });
      const v = await post<{ issues: Issue[] }>(`/workflows/${wf.id}/validate`, defn);
      setIssues(v.issues); setValidated(true); setDirty(false);
      if (!silent) toast.success("Draft saved");
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }, [manager, nodes, edges, wf.id]);

  // re-fit once the layout has settled (the sidebar collapses after mount)
  useEffect(() => { const t = setTimeout(() => rf.fitView({ padding: 0.15, maxZoom: 1 }), 200); return () => clearTimeout(t); }, [rf]);

  // validate once on open so problems are visible immediately
  useEffect(() => {
    if (readOnlyExecution) return;
    post<{ issues: Issue[] }>(`/workflows/${wf.id}/validate`).then((v) => { setIssues(v.issues); setValidated(true); }).catch(() => {});
  }, [wf.id, readOnlyExecution]);

  // autosave drafts
  useEffect(() => { if (!dirty || !manager) return; const t = setTimeout(() => save(true), 2500); return () => clearTimeout(t); }, [dirty, nodes, edges, save, manager]);

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable]") || !manager) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key === "y") { e.preventDefault(); redo(); }
      else if (mod && e.key === "s") { e.preventDefault(); save(); }
      else if (mod && e.key === "c") clipboard.current = nodes.filter((n) => n.selected);
      else if (mod && e.key === "v" && clipboard.current.length) duplicate(clipboard.current.map((n) => n.id));
      else if (mod && e.key === "d") { e.preventDefault(); duplicate(nodes.filter((n) => n.selected).map((n) => n.id)); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // poll the running execution
  useEffect(() => {
    if (!exec || TERMINAL.has(exec.status) && exec.nodes) return;
    const t = setInterval(async () => {
      const e = await get<Execution>(`/executions/${exec.id}`);
      setExec(e);
      if (TERMINAL.has(e.status) || e.status === "awaiting_approval") { qc.invalidateQueries({ queryKey: ["approvals"] }); if (TERMINAL.has(e.status)) clearInterval(t); }
    }, 1000);
    return () => clearInterval(t);
  }, [exec?.id, exec?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const runTest = async () => {
    let input: Record<string, unknown>;
    try { input = JSON.parse(testInput || "{}"); } catch { toast.error("Test input must be valid JSON"); return; }
    await save(true);
    try {
      const r = await post<{ execution_id: string }>(`/workflows/${wf.id}/run`, { input, mode: "test" });
      setTestOpen(false);
      setExec({ id: r.execution_id, status: "queued" } as Execution);
      toast.message("Test run started — sandbox delivery, nothing leaves AgentOS");
    } catch (e) { const iss = issuesFrom(e); if (iss.length) { setIssues(iss); toast.error("Fix the highlighted problems first"); } else toast.error((e as Error).message); }
  };
  const openTest = () => {
    const trig = nodes.find((n) => n.data.kind.startsWith("trigger."));
    setTestInput(JSON.stringify(trig?.data.config.sample_input ?? {}, null, 2));
    setTestOpen(true);
  };
  const publish = async () => {
    await save(true);
    try {
      const r = await post<{ version: number; webhook?: { url_path: string; signing_secret: string } }>(`/workflows/${wf.id}/publish`, { activate: true });
      toast.success(`Published version ${r.version} and activated`);
      if (r.webhook) setWebhook(r.webhook);
      qc.invalidateQueries({ queryKey: ["workflow", wf.id] });
    } catch (e) { const iss = issuesFrom(e); if (iss.length) { setIssues(iss); toast.error("Fix the highlighted problems before publishing"); } else toast.error((e as ApiError).message); }
  };
  const setStatus = async (s: "active" | "paused") => {
    try { await post(`/workflows/${wf.id}/status`, { status: s }); toast.success(s === "active" ? "Workflow active" : "Workflow paused"); qc.invalidateQueries({ queryKey: ["workflow", wf.id] }); }
    catch (e) { toast.error((e as Error).message); }
  };
  const runNow = async () => {
    try { const r = await post<{ execution_id: string }>(`/workflows/${wf.id}/run`, { input: {}, mode: "production" }); setExec({ id: r.execution_id, status: "queued" } as Execution); }
    catch (e) { toast.error((e as Error).message); }
  };
  const exportJson = async () => {
    const data = await get(`/workflows/${wf.id}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${wf.name.replace(/\W+/g, "-").toLowerCase()}.agentos.json` });
    a.click(); URL.revokeObjectURL(url);
  };

  const sel = nodes.find((n) => n.id === selected);
  const upstream = useMemo(() => {
    if (!selected) return [];
    const inc = new Map<string, string[]>();
    edges.forEach((e) => inc.set(e.target, [...(inc.get(e.target) ?? []), e.source]));
    const seen = new Set<string>(); const stack = [...(inc.get(selected) ?? [])];
    while (stack.length) { const n = stack.pop()!; if (!seen.has(n)) { seen.add(n); stack.push(...(inc.get(n) ?? [])); } }
    return nodes.filter((n) => seen.has(n.id)).map((n) => ({ id: n.id, label: n.data.label ?? n.id, kind: n.data.kind }));
  }, [selected, edges, nodes]);
  const errors = issues.filter((i) => i.severity === "error");
  const globalIssues = issues.filter((i) => !i.node_id);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
        <Link href={readOnlyExecution ? "/app/analytics" : "/app/studio"} className="rounded-md p-1.5 text-text-2 hover:bg-surface-2" aria-label="Back"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="mr-auto min-w-0">
          <h1 className="truncate font-semibold">{wf.name}{readOnlyExecution && <span className="font-normal text-text-2"> · run {readOnlyExecution.id.slice(0, 8)}</span>}</h1>
          <p className="flex items-center gap-2 text-xs text-text-3">
            {readOnlyExecution ? <>Version {readOnlyExecution.version || "draft"} · {readOnlyExecution.mode}</> : <>
              <StatusBadge status={wf.status} />{wf.published_version ? `Published v${wf.published_version}` : "Not published"} · {saving ? "Saving…" : dirty ? "Unsaved changes" : "Draft saved"}
              {validated && <span className={errors.length ? "text-critical" : "text-good"}>{errors.length ? `${errors.length} problem(s)` : "Valid"}</span>}</>}
          </p>
        </div>
        {exec && <span className="flex items-center gap-2 text-sm"><StatusBadge status={exec.status} />{exec.cost_usd > 0 && <Badge>{money(exec.cost_usd)}</Badge>}
          {exec.status === "awaiting_approval" && <Link href="/app/approvals" className="text-accent hover:underline">Review approval →</Link>}
          {!readOnlyExecution && TERMINAL.has(exec.status) && <Button size="sm" variant="ghost" onClick={() => setExec(null)}>Clear run</Button>}</span>}
        {manager && <>
          <Button size="icon" variant="ghost" onClick={undo} aria-label="Undo"><Undo2 className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" onClick={redo} aria-label="Redo"><Redo2 className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" onClick={() => { snapshot(); setNodes(autoLayout(nodes, edges)); setTimeout(() => rf.fitView({ padding: 0.2 }), 50); }} aria-label="Auto-layout"><LayoutGrid className="h-4 w-4" /></Button>
          <Button size="sm" variant="secondary" onClick={() => save()} loading={saving}><Save className="h-4 w-4" aria-hidden />Save</Button>
          <Button size="sm" variant="secondary" onClick={() => setVersionsOpen(true)}><History className="h-4 w-4" aria-hidden />Versions</Button>
          <Button size="sm" variant="secondary" onClick={openTest}><Play className="h-4 w-4" aria-hidden />Test</Button>
          <Button size="sm" onClick={publish}><Rocket className="h-4 w-4" aria-hidden />Publish</Button>
          {wf.published_version && (wf.status === "active"
            ? <><Button size="sm" variant="secondary" onClick={runNow}>Run now</Button><Button size="sm" variant="ghost" onClick={() => setStatus("paused")}><Pause className="h-4 w-4" aria-hidden />Pause</Button></>
            : <Button size="sm" variant="secondary" onClick={() => setStatus("active")}>Activate</Button>)}
          <Button size="icon" variant="ghost" onClick={exportJson} aria-label="Export JSON"><Download className="h-4 w-4" /></Button>
        </>}
      </header>
      <div className="flex min-h-0 flex-1">
        {manager && <aside className="w-60 shrink-0 border-r border-border bg-surface" aria-label="Component library"><Palette specs={specs} agents={agents.data ?? []} onAdd={addNode} /></aside>}
        <div className="relative min-w-0 flex-1" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
          <ReactFlow nodes={viewNodes} edges={viewEdges} nodeTypes={nodeTypes}
            onNodesChange={manager ? onNodesChange : undefined} onEdgesChange={manager ? onEdgesChange : undefined} onConnect={onConnect}
            onNodeDragStart={() => snapshot()} onNodeClick={(_, n) => { setSelected(n.id); setMenu(null); }} onPaneClick={() => { setSelected(null); setMenu(null); }}
            onNodesDelete={(ns) => { snapshot(); if (ns.some((n) => n.id === selected)) setSelected(null); }} onEdgesDelete={() => snapshot()}
            onNodeContextMenu={(e, n) => { if (!manager) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: n.id }); }}
            nodesDraggable={manager} nodesConnectable={manager} elementsSelectable deleteKeyCode={manager ? ["Backspace", "Delete"] : null}
            multiSelectionKeyCode={["Shift", "Meta", "Control"]} snapToGrid snapGrid={[16, 16]} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            defaultEdgeOptions={{ type: "smoothstep" }} proOptions={{ hideAttribution: true }} minZoom={0.2}>
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => ({ completed: "var(--good)", failed: "var(--critical)", awaiting_approval: "var(--warning)", running: "var(--accent)" } as Record<string, string>)[String((n.data as StudioNodeData).status)] ?? "var(--text-3)"} />
            <Panel position="top-left">
              {globalIssues.length > 0 && !exec && <div className="max-w-sm space-y-1">{globalIssues.map((i, k) => <Alert key={k} tone={i.severity === "error" ? "critical" : "info"}>{i.message}</Alert>)}</div>}
            </Panel>
            <Panel position="bottom-center"><Button size="sm" variant="secondary" onClick={() => rf.fitView({ padding: 0.25, duration: 300 })}><Maximize className="h-3.5 w-3.5" aria-hidden />Fit to screen</Button></Panel>
          </ReactFlow>
          {nodes.length === 0 && manager && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center"><div className="rounded-xl border border-dashed border-border bg-surface/80 px-6 py-5 text-center text-sm text-text-2">
              <p className="font-medium text-text">Start with a trigger</p><p>Drag “Manual / form trigger” from the left, then add agents and actions.</p></div></div>
          )}
          {menu && (
            <div role="menu" className="fixed z-50 min-w-40 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg" style={{ left: menu.x, top: menu.y }}>
              <button role="menuitem" className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => { duplicate([menu.id]); setMenu(null); }}>Duplicate</button>
              <button role="menuitem" className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => { setSelected(menu.id); setMenu(null); }}>Configure</button>
              <button role="menuitem" className="block w-full rounded-md px-2 py-1.5 text-left text-critical hover:bg-surface-2" onClick={() => { deleteNodes([menu.id]); setMenu(null); }}>Delete</button>
            </div>
          )}
        </div>
        <aside className="w-96 shrink-0 overflow-y-auto border-l border-border bg-surface p-5" aria-label="Configuration">
          {sel && sel.data.spec ? (
            <Inspector key={sel.id} nodeId={sel.id} kind={sel.data.kind} label={sel.data.label ?? ""} config={sel.data.config} spec={sel.data.spec}
              agents={agents.data ?? []} connections={conns.data ?? []} kbs={kbs.data ?? []} readOnly={!manager}
              actionNodes={nodes.filter((n) => n.data.spec?.side_effect).map((n) => ({ id: n.id, label: n.data.label ?? n.id }))}
              upstream={upstream} issues={issues.filter((i) => i.node_id === sel.id)} run={runByNode[sel.id]}
              onChange={(p) => updateNode(sel.id, p)} onDelete={() => deleteNodes([sel.id])} onDuplicate={() => duplicate([sel.id])} />
          ) : exec?.nodes ? <RunSummary exec={exec} /> : (
            <div className="space-y-4 text-sm text-text-2">
              <h2 className="font-semibold text-text">Configuration</h2>
              <p>Select a step to configure it. Connect steps by dragging from the dot on the right of one step to another.</p>
              <ul className="space-y-1 text-xs"><li><kbd>⌘/Ctrl Z</kbd> undo · <kbd>⇧⌘Z</kbd> redo</li><li><kbd>⌘/Ctrl C</kbd>/<kbd>V</kbd> copy & paste · <kbd>⌘D</kbd> duplicate</li><li><kbd>Delete</kbd> remove · <kbd>⇧</kbd>+drag multi-select</li><li><kbd>⌘S</kbd> save (drafts also autosave)</li></ul>
              {errors.length > 0 && <div className="space-y-2"><p className="font-medium text-text">Problems</p>{errors.map((i, k) => <button key={k} className="block w-full text-left" onClick={() => i.node_id && setSelected(i.node_id)}><Alert tone="critical">{i.message}</Alert></button>)}</div>}
              {validated && !errors.length && <Alert tone="good">This workflow is valid and ready to publish.</Alert>}
            </div>
          )}
        </aside>
      </div>
      <Dialog open={testOpen} onOpenChange={setTestOpen} title="Test run" description="Runs the current draft. Emails go to the sandbox outbox and API calls are simulated. Approvals still apply."
        footer={<><Button variant="ghost" onClick={() => setTestOpen(false)}>Cancel</Button><Button onClick={runTest}><Play className="h-4 w-4" aria-hidden />Start test</Button></>}>
        <Textarea aria-label="Test input JSON" rows={10} className="font-mono text-xs" value={testInput} onChange={(e) => setTestInput(e.target.value)} />
      </Dialog>
      {versionsOpen && <Versions wf={wf} onClose={() => setVersionsOpen(false)} onRestored={(d) => { snapshot(); restore(d); }} />}
      <Dialog open={!!webhook} onOpenChange={() => setWebhook(null)} title="Webhook created" description="Copy the signing secret now — it is shown only once.">
        {webhook && <div className="space-y-3 text-sm"><p>POST JSON to:</p><Code>{`${typeof window !== "undefined" ? window.location.origin : ""}${webhook.url_path}`}</Code>
          <p>Signing secret (HMAC-SHA256 of the raw body, header <code>X-AgentOS-Signature</code>):</p><Code>{webhook.signing_secret}</Code></div>}
      </Dialog>
    </div>
  );
}

function RunSummary({ exec }: { exec: Execution }) {
  return (
    <div className="space-y-4 text-sm">
      <div><h2 className="font-semibold">Run details</h2><p className="text-xs text-text-3">{exec.mode} · started {ago(exec.started_at)} · {money(exec.cost_usd)}</p></div>
      <div className="flex items-center gap-2"><StatusBadge status={exec.status} />{exec.mode === "test" && <Badge tone="warning">Sandbox delivery</Badge>}</div>
      {exec.error && <Alert tone="critical">{exec.error}</Alert>}
      <ol className="space-y-1.5">{exec.nodes?.map((n) => (
        <li key={n.node_id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"><span className="truncate">{n.node_id}</span>
          <span className="flex items-center gap-2 text-xs text-text-3">{n.duration_ms != null && `${(n.duration_ms / 1000).toFixed(1)}s`}<StatusBadge status={n.status} /></span></li>))}</ol>
      {exec.output != null && !exec.redacted && <div><p className="mb-1 font-medium">Result</p><Code>{JSON.stringify(exec.output, null, 2)}</Code></div>}
      <p className="text-xs text-text-3">Click a step on the canvas to see its inputs, output, tokens and cost.</p>
    </div>
  );
}

function Versions({ wf, onClose, onRestored }: { wf: Workflow; onClose: () => void; onRestored: (d: Definition) => void }) {
  const versions = useList<{ version: number; note: string | null; created_at: string; node_count: number }[]>(["versions", wf.id], `/workflows/${wf.id}/versions`);
  const [diff, setDiff] = useState<{ v: number; d: Record<string, unknown> } | null>(null);
  const showDiff = async (v: number) => setDiff({ v, d: await get(`/workflows/${wf.id}/diff?base=${v}`) });
  const restore = async (v: number) => {
    if (!confirm(`Replace the current draft with version ${v}? Publish afterwards to make it live.`)) return;
    const w = await post<Workflow>(`/workflows/${wf.id}/versions/${v}/restore`);
    onRestored(w.draft!); toast.success(`Version ${v} restored into the draft`); onClose();
  };
  const clone = async () => { const w = await post<Workflow>(`/workflows/${wf.id}/clone`); window.location.href = `/app/studio/${w.id}`; };
  return (
    <Dialog open onOpenChange={onClose} title="Version history" description="Published versions are immutable. Running executions always keep the version they started with." wide
      footer={<Button variant="secondary" onClick={clone}>Clone workflow</Button>}>
      {!versions.data?.length ? <p className="text-sm text-text-2">No published versions yet.</p> : (
        <ul className="divide-y divide-border text-sm">{versions.data.map((v) => (
          <li key={v.version} className="py-3">
            <div className="flex items-center justify-between gap-2"><span><span className="font-medium">v{v.version}</span> <span className="text-text-2">{v.note}</span> <span className="text-xs text-text-3">{ago(v.created_at)} · {v.node_count} steps</span></span>
              <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => showDiff(v.version)}><ChevronDown className="h-3.5 w-3.5" aria-hidden />Compare with draft</Button><Button size="sm" variant="secondary" onClick={() => restore(v.version)}>Restore</Button></span></div>
            {diff?.v === v.version && <div className="mt-2"><Code>{JSON.stringify(diff.d, null, 2)}</Code></div>}
          </li>))}</ul>
      )}
      <p className="mt-3 flex items-center gap-1 text-xs text-text-3"><CheckCircle2 className="h-3 w-3" aria-hidden />Current: {wf.published_version ? `v${wf.published_version}` : "none"}</p>
    </Dialog>
  );
}

export function StudioEditor(props: { wf: Workflow; specs: Record<string, NodeSpec>; readOnlyExecution?: Execution }) {
  return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>;
}
