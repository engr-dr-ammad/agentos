"use client";

import { useParams } from "next/navigation";
import { StudioEditor } from "@/components/studio/editor";
import { Loading } from "@/components/ui";
import { useList } from "@/lib/hooks";
import type { Execution, NodeSpec, Workflow } from "@/lib/types";

export default function ExecutionPage() {
  const { id } = useParams<{ id: string }>();
  const ex = useList<Execution>(["execution", id], `/executions/${id}`);
  const specs = useList<Record<string, NodeSpec>>(["node-types"], "/node-types", { refetchInterval: false });
  if (!ex.data || !specs.data) return <div className="p-10"><Loading rows={5} /></div>;
  const wf: Workflow = { id: ex.data.workflow_id ?? "", name: ex.data.workflow_name ?? (ex.data.workflow_id ? "Workflow run" : "Agent task run"),
    description: "", status: "active", published_version: ex.data.version, node_count: ex.data.definition?.nodes.length ?? 0, updated_at: ex.data.created_at };
  return <StudioEditor key={ex.data.id} wf={wf} specs={specs.data} readOnlyExecution={ex.data} />;
}
