export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
        <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--accent)" />
        <circle cx="8.5" cy="12" r="2.2" fill="white" /><circle cx="15.5" cy="8" r="2.2" fill="white" /><circle cx="15.5" cy="16" r="2.2" fill="white" />
        <path d="M10.5 11l3-2M10.5 13l3 2" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      AgentOS
    </span>
  );
}
