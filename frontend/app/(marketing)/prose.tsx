export function Prose({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {lead && <p className="mt-3 text-lg text-text-2">{lead}</p>}
      <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-text-2 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text [&_li]:ml-5 [&_li]:list-disc [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm">{children}</div>
    </article>
  );
}
