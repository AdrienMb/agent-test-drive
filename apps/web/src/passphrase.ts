import { PASSPHRASE_COOKIE } from "@atd/shared";

const ONE_YEAR = 60 * 60 * 24 * 365;

export function savePassphrase(passphrase: string): void {
  // Secure would stop the cookie being set at all on the plain-http dev server.
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PASSPHRASE_COOKIE}=${encodeURIComponent(passphrase)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Strict${secure}`;
}

export function forgetPassphrase(): void {
  document.cookie = `${PASSPHRASE_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`;
}

/** Whether the server accepts the stored passphrase. Also true when the server has no passphrase set. */
export async function checkPassphrase(): Promise<boolean> {
  const res = await fetch("/api/session");
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return true;
}
