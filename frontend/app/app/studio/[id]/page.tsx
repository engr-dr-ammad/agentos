"use client";

import { useParams } from "next/navigation";
import { StudioEditor } from "@/components/studio/editor";
import { Loading } from "@/components/ui";
import { useList } from "@/lib/hooks";
import type { NodeSpec, Workflow } from "@/lib/types";

export default function StudioPage() {
  const { id } = useParams<{ id: string }>();
  const wf = useList<Workflow>(["workflow", id], `/workflows/${id}`);
  const specs = useList<Record<string, NodeSpec>>(["node-types"], "/node-types", { refetchInterval: false });
  if (!wf.data || !specs.data) return <div className="p-10"><Loading rows={5} /></div>;
  return <StudioEditor wf={wf.data} specs={specs.data} />;
}
