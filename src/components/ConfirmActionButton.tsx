"use client";

export function ConfirmActionButton({
  action,
  confirmText,
  label,
  className,
}: {
  action: () => Promise<void>;
  confirmText: string;
  label: string;
  className?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
    >
      <button
        type="submit"
        className={className ?? "rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint"}
      >
        {label}
      </button>
    </form>
  );
}
