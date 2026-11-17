"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { label: string; value: number };

/** Single-series bar chart (no legend; the card title names the series). Hover tooltip + hidden data table. */
export function BarSeries({ data, format = (v) => String(v), caption }: { data: Point[]; format?: (v: number) => string; caption: string }) {
  return (
    <figure>
      <div className="h-56 w-full" aria-hidden>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--border)" }} tick={{ fill: "var(--text-3)", fontSize: 11 }} minTickGap={16} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={{ fill: "var(--text-3)", fontSize: 11 }} tickFormatter={format} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} formatter={(v) => [format(Number(v)), caption]}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" }}
              labelStyle={{ color: "var(--text-2)" }} />
            <Bar dataKey="value" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only"><caption>{caption}</caption><tbody>{data.map((d) => <tr key={d.label}><th scope="row">{d.label}</th><td>{format(d.value)}</td></tr>)}</tbody></table>
    </figure>
  );
}
