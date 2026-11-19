/** Basename with only plain characters, so a name can't hide its extension or create a dotfile. */
export function downloadName(path: string): string {
  const base = path.split("/").pop() ?? "";
  return base.replace(/[^\w.-]/g, "_").replace(/^\.+/, "") || "file";
}

/**
 * Agent output is saved, never opened: a blob URL has this app's origin, so opening an HTML blob
 * in a tab would run the agent's script as us. application/octet-stream makes browsers download it.
 */
export function downloadText(path: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName(path);
  link.rel = "noopener";
  link.click();
  // Some browsers (Safari, older Firefox) start the download after click() returns; revoking at once can fail it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
