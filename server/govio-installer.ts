import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { finished } from "node:stream/promises";

const GOVIO_REPO = "chenxinma/govio";
const SKILLS_ZIP_NAME = "govio-skills.zip";

/**
 * govio-cli 最低支持版本。
 * govio-map 与 govio-cli 自 0.6.1 起独立发版（不再保持版本号一致），
 * 通过此常量声明本应用所需的最低 govio-cli 版本：未安装或低于该版本时
 * 统一走 uv 安装/升级到最新版。
 * 升级 govio-map 时如依赖了新的 govio-cli 能力，请同步提升此版本号。
 */
export const MIN_GOVIO_CLI_VERSION = "0.5.6";

export async function runGovioCliVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("govio-cli", ["-V"], { encoding: "utf-8", timeout: 15000 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function parseVersion(versionOutput: string): string {
  const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(`Unable to parse govio version from: ${versionOutput}`);
  }
  return match[1];
}

/** 比较 x.y.z 版本号：a < b 返回 -1，a === b 返回 0，a > b 返回 1。 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function ensureGovioCli(): Promise<void> {
  let installed: string | null = null;
  try {
    installed = parseVersion(await runGovioCliVersion());
  } catch {
    console.log("[govio] govio-cli not found, installing via uv...");
  }

  if (installed && compareVersions(installed, MIN_GOVIO_CLI_VERSION) >= 0) {
    console.log(`[govio] govio-cli ${installed} satisfies minimum ${MIN_GOVIO_CLI_VERSION}`);
    return;
  }

  if (installed) {
    console.log(`[govio] govio-cli ${installed} is below minimum ${MIN_GOVIO_CLI_VERSION}, upgrading via uv...`);
  }
  await installGovioCli();
  const version = parseVersion(await runGovioCliVersion());
  if (compareVersions(version, MIN_GOVIO_CLI_VERSION) < 0) {
    throw new Error(
      `govio-cli ${version} is still below the minimum supported version ${MIN_GOVIO_CLI_VERSION} after uv install`,
    );
  }
  console.log(`[govio] govio-cli installed: ${version}`);
}

async function installGovioCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["tool", "install", "--compile-bytecode", "--force", "-p", "3.13", "govio"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start uv tool install: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`uv tool install govio exited with code ${code}`));
      }
    });
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, url).toString();
        file.close();
        downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed with status ${response.statusCode}: ${url}`));
        return;
      }

      response.pipe(file);
      finished(file).then(resolve).catch(reject);
    });

    request.on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", zipPath, "-C", destDir], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start tar extraction: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extraction exited with code ${code}`));
      }
    });
  });
}

async function skillsAlreadyInstalled(skillsDir: string): Promise<boolean> {
  try {
    await access(join(skillsDir, "govio", "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

export async function downloadGovioSkills(): Promise<void> {
  const versionOutput = await runGovioCliVersion();
  const version = parseVersion(versionOutput);
  const cwd = process.cwd();
  const agentsDir = join(cwd, ".agents");
  const skillsDir = join(agentsDir, "skills");
  const zipPath = join(agentsDir, SKILLS_ZIP_NAME);

  if (await skillsAlreadyInstalled(skillsDir)) {
    console.log(`[govio] Skills already installed at ${skillsDir}`);
    return;
  }

  const url = `https://github.com/${GOVIO_REPO}/releases/download/v${version}/${SKILLS_ZIP_NAME}`;
  console.log(`[govio] Downloading skills from ${url}...`);

  await mkdir(agentsDir, { recursive: true });
  await downloadFile(url, zipPath);

  console.log(`[govio] Extracting skills to ${skillsDir}...`);
  await mkdir(skillsDir, { recursive: true });
  await extractZip(zipPath, skillsDir);

  // Clean up the downloaded archive.
  try {
    await rm(zipPath);
  } catch {
    // Non-fatal: leave the zip for diagnostics if removal fails.
  }

  console.log(`[govio] Skills installed at ${skillsDir}`);
}
