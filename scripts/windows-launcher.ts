import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const exeDir = dirname(process.execPath);
const ps1Path = join(exeDir, "windows-tray-launcher.ps1");
const psExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const localAppData = process.env.LOCALAPPDATA || exeDir;
const logDir = join(localAppData, "SlippiWorld");
const logPath = join(logDir, "launcher-debug.log");
const psLogPath = join(logDir, "powershell-spawn.log");

function log(msg: string) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logPath, `[${new Date().toISOString()}] [launcher] ${msg}\n`, "utf8");
  } catch {
    // ignore logging errors
  }
}

log(`Boot launcher. exeDir=${exeDir}`);
log(`PowerShell script path=${ps1Path}`);
log(`PowerShell exe path=${psExe}`);
log(`PowerShell spawn log path=${psLogPath}`);

const ps1Esc = ps1Path.replace(/'/g, "''");
const psLogEsc = psLogPath.replace(/'/g, "''");
const inlineCommand = [
  "$ErrorActionPreference='Continue'",
  `New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${psLogEsc}') | Out-Null`,
  `"[$(Get-Date -Format o)] [launcher-inline] start" | Out-File -FilePath '${psLogEsc}' -Append`,
  "try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}",
  `try { $src = Get-Content -Raw '${ps1Esc}'; & ([ScriptBlock]::Create($src)) 2>&1 | Out-File -FilePath '${psLogEsc}' -Append } catch { "[$(Get-Date -Format o)] [launcher-inline] ERROR: $($_.Exception.Message)" | Out-File -FilePath '${psLogEsc}' -Append }`,
].join("; ");
const encodedCommand = Buffer.from(inlineCommand, "utf16le").toString("base64");

try {
  log("Spawning powershell visible for debugging...");
  const child = Bun.spawn({
    cmd: [
      psExe,
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedCommand,
    ],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      SLIPPI_DEBUG_LOG: "1",
      SLIPPI_LOG_PATH: logPath,
      SLIPPI_PS_LOG_PATH: psLogPath,
    },
  });
  child.unref();
  log(`Spawn visible OK (pid=${child.pid})`);
  // If PowerShell crashes immediately, capture that in launcher log.
  setTimeout(async () => {
    try {
      const code = await Promise.race([
        child.exited,
        new Promise<number>((resolve) => setTimeout(() => resolve(-999), 600)),
      ]);
      if (code !== -999) {
        log(`PowerShell exited early with code=${code}`);
      }
    } catch {
      log("PowerShell early-exit probe failed");
    }
    process.exit(0);
  }, 50);
} catch {
  log("Primary visible spawn failed, trying fallback...");
  // Fallback: try visible launch if hidden mode fails.
  try {
    const fallback = Bun.spawn({
      cmd: [psExe, "-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        SLIPPI_DEBUG_LOG: "1",
        SLIPPI_LOG_PATH: logPath,
        SLIPPI_PS_LOG_PATH: psLogPath,
      },
    });
    fallback.unref();
    log(`Visible fallback spawn OK (pid=${fallback.pid})`);
    process.exit(0);
  } catch {
    log("Visible fallback spawn failed");
    process.exit(1);
  }
}
