"use client";

import { Button } from "./Button";

/** Same onSubmit-confirm shape as ConfirmActionButton/DeleteTeamButton, but
 * with an email input alongside the submit button — those two don't carry
 * extra form fields, so this is its own small component rather than a prop
 * added to one of them. */
export function InviteByEmailForm({
  action,
  label,
  confirmText,
}: {
  action: (formData: FormData) => Promise<void>;
  label: string;
  confirmText?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (confirmText && !confirm(confirmText)) e.preventDefault();
      }}
      className="flex items-center gap-1"
    >
      <input
        type="email"
        name="email"
        required
        placeholder="Email address"
        className="rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-blue"
      />
      <Button type="submit" size="sm">
        {label}
      </Button>
    </form>
  );
}
