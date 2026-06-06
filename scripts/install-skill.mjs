#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const skillsDir = path.join(codexHome, "skills");
const targetDir = path.join(skillsDir, "md-to-feishu");
const args = parseArgs(process.argv.slice(2));

if (path.resolve(sourceDir) === path.resolve(targetDir)) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "already-installed",
    target: targetDir
  }, null, 2));
  process.exit(0);
}

if (fs.existsSync(targetDir)) {
  if (!args.force) {
    throw new Error(`Target already exists: ${targetDir}. Re-run with --force to replace it.`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
}

fs.mkdirSync(skillsDir, { recursive: true });
copyDirectory(sourceDir, targetDir);

console.log(JSON.stringify({
  ok: true,
  source: sourceDir,
  target: targetDir,
  codex_home: codexHome,
  next: "Restart Codex or start a new Codex session, then ask it to publish a Markdown file to Feishu."
}, null, 2));

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".md-to-feishu") continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(src, dst);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      fs.symlinkSync(link, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--force") parsed.force = true;
    else throw new Error(`Unsupported option: ${arg}`);
  }
  return parsed;
}
