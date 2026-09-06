"use client";

import { useRef, useState } from "react";
import { resizeImageToDataUrl } from "@/lib/images/resizeImage";
import { setTeamLogoAction } from "./actions";

export function LogoUploadForm({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPending(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      if (hiddenInputRef.current) hiddenInputRef.current.value = dataUrl;
      formRef.current?.requestSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't process that image.");
      setPending(false);
    }
  }

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await setTeamLogoAction(leagueId, teamId, formData);
        setPending(false);
      }}
    >
      <input ref={hiddenInputRef} type="hidden" name="logoDataUrl" />
      <label className="cursor-pointer rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-tint">
        {pending ? "Uploading…" : "Change logo"}
        <input type="file" accept="image/*" className="hidden" disabled={pending} onChange={handleFileChange} />
      </label>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </form>
  );
}
