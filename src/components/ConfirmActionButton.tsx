"use client";

import { Button, type ButtonVariant, type ButtonSize } from "./Button";

export function ConfirmActionButton({
  action,
  confirmText,
  label,
  variant = "secondary",
  size = "md",
  className,
}: {
  action: () => Promise<void>;
  confirmText: string;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
    >
      <Button type="submit" variant={variant} size={size} className={className}>
        {label}
      </Button>
    </form>
  );
}
