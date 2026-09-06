const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Browser-only — resizes/compresses an image file client-side before
 * upload, so a phone photo doesn't get shipped at full resolution. Draws
 * onto an offscreen canvas and returns a data URL; the server (setTeamLogo)
 * re-validates independently rather than trusting this. */
export async function resizeImageToDataUrl(file: File, maxDim = 200, quality = 0.85): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("That image is too large (max 8MB).");

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  return canvas.toDataURL("image/webp", quality);
}
