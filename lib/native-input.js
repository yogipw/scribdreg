import { spawnSync } from "child_process";

/**
 * Clipboard level OS (dipakai pasteField di lib/pw-human.js).
 * Satu-satunya export yang dipakai — sisanya kode Win32/Selenium lama
 * sudah dibuang (tak ada pengimpor).
 */
export function setClipboard(text) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      "[Console]::InputEncoding=[System.Text.UTF8Encoding]::UTF8; $input | Set-Clipboard",
    ],
    { input: text, encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error("Clipboard gagal");
  }
}
