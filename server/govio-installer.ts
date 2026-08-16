import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { finished } from "node:stream/promises";

const GOVIO_REPO = "chenxinma/govio";
const SKILLS_ZIP_NAME = "govio-skills.zip";

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

export async function ensureGovioCli(): Promise<void> {
  try {
    const version = await runGovioCliVersion();
    console.log(`[govio] govio-cli available: ${version}`);
    return;
  } catch {
    console.log("[govio] govio-cli not found, installing via uv...");
    await installGovioCli();
    const version = await runGovioCliVersion();
    console.log(`[govio] govio-cli installed: ${version}`);
  }
}

async function installGovioCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["tool", "install", "govio"], {
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
  const piDir = join(cwd, ".pi");
  const skillsDir = join(piDir, "skills");
  const zipPath = join(piDir, SKILLS_ZIP_NAME);

  if (await skillsAlreadyInstalled(skillsDir)) {
    console.log(`[govio] Skills already installed at ${skillsDir}`);
    return;
  }

  const url = `https://github.com/${GOVIO_REPO}/releases/download/v${version}/${SKILLS_ZIP_NAME}`;
  console.log(`[govio] Downloading skills from ${url}...`);

  await mkdir(piDir, { recursive: true });
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
