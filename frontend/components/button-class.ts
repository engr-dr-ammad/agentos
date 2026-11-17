import { cva } from "class-variance-authority";

/** Server-safe button styles (usable in server components for links). */
export const buttonClass = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap",
  {
    variants: {
      variant: {
        primary: "bg-accent text-white hover:bg-accent-strong",
        secondary: "border border-border bg-surface text-text hover:bg-surface-2",
        ghost: "text-text-2 hover:bg-surface-2 hover:text-text",
        danger: "bg-critical text-white hover:opacity-90",
        link: "text-accent hover:underline px-0 h-auto",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", lg: "h-11 px-6 text-base", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

