import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fromRF, toRF } from "@/components/studio/editor";
import { StatusBadge } from "@/components/ui";
import type { Definition, NodeSpec } from "@/lib/types";
import { can, money } from "@/lib/utils";

const spec = { category: "Triggers", label: "Manual", icon: "play", description: "", fields: [], outputs: ["default"] } as NodeSpec;

describe("workflow definition mapping", () => {
  it("round-trips nodes and edges, normalising the default handle", () => {
    const defn: Definition = {
      nodes: [{ id: "t", type: "trigger.manual", position: { x: 10.4, y: 20.6 }, data: { label: "Start", config: { a: 1 } } },
        { id: "c", type: "logic.condition", position: { x: 300, y: 0 }, data: { config: {} } }],
      edges: [{ id: "e1", source: "t", target: "c", sourceHandle: null }, { id: "e2", source: "c", target: "t", sourceHandle: "true" }],
    };
    const rf = toRF(defn, { "trigger.manual": spec });
    expect(rf.nodes[0].data.spec).toBe(spec);
    const back = fromRF(rf.nodes, rf.edges);
    expect(back.nodes[0].position).toEqual({ x: 10, y: 21 });
    expect(back.edges[0].sourceHandle).toBeNull();
    expect(back.edges[1].sourceHandle).toBe("true");
    expect(back.nodes[0].data).toEqual({ label: "Start", config: { a: 1 } });
  });
});

describe("utils", () => {
  it("formats small costs precisely and checks roles", () => {
    expect(money(0.0012)).toBe("$0.0012");
    expect(can("manager", "employee")).toBe(true);
    expect(can("viewer", "manager")).toBe(false);
    expect(can(undefined, "viewer")).toBe(false);
  });
});

describe("StatusBadge", () => {
  it("never relies on colour alone — renders a text label", () => {
    render(<StatusBadge status="awaiting_approval" />);
    expect(screen.getByText("awaiting approval")).toBeInTheDocument();
  });
});
