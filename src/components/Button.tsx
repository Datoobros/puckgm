// Shared button vocabulary — replaces three incompatible ad hoc systems that
// had grown across the app (a rounded-full pill, a rounded bg-navy square
// CTA, and Players-page-only gold variants). No hooks/browser APIs, so this
// works from both Server and Client Components without a directive.
//
// Shape convention: rounded-md (a small rounded rectangle, matching ESPN's
// actual button shape — boxier than a pill) for every real action. The pill
// shape is kept, but only for Badge — a real action vs. a non-interactive
// tag now differ in shape, not just arbitrarily.

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-4 py-1.5 text-sm",
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-navy text-navy-foreground hover:opacity-90",
  secondary: "border border-border bg-surface text-foreground hover:bg-surface-tint",
  danger: "border border-danger text-danger hover:bg-danger-tint",
  ghost: "text-blue hover:underline underline-offset-2",
};

function buttonClasses(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  // Ghost is a text link, not a boxed control — no padding/size box around it.
  const sized = variant === "ghost" ? "text-sm" : SIZES[size];
  return `${BASE} ${sized} ${VARIANTS[variant]} ${className ?? ""}`.trim();
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClasses(variant, size, className)} {...props} />;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  href,
  children,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}

type BadgeTone = "muted" | "gold" | "navy" | "warning" | "danger" | "success";

const BADGE_TONES: Record<BadgeTone, { soft: string; solid: string }> = {
  muted: { soft: "bg-surface-tint text-muted", solid: "bg-muted text-white" },
  gold: { soft: "bg-gold/15 text-gold", solid: "bg-gold text-gold-foreground" },
  navy: { soft: "bg-navy/10 text-navy", solid: "bg-navy text-navy-foreground" },
  warning: { soft: "bg-warning-tint text-warning", solid: "bg-warning text-white" },
  danger: { soft: "bg-danger-tint text-danger", solid: "bg-danger text-white" },
  success: { soft: "bg-success-tint text-success", solid: "bg-success text-white" },
};

/** Non-interactive tag/status pill — YOU, AUTO, ORPHANED, IR, GP+ threshold,
 * etc. The pill shape belongs here now, not on clickable buttons. */
export function Badge({
  tone = "muted",
  solid = false,
  title,
  children,
  className,
}: {
  tone?: BadgeTone;
  solid?: boolean;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const style = solid ? BADGE_TONES[tone].solid : BADGE_TONES[tone].soft;
  return (
    <span
      title={title}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style} ${className ?? ""}`.trim()}
    >
      {children}
    </span>
  );
}
