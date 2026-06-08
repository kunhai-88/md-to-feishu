#!/usr/bin/env node
import { createFolder, markdownToBlocks, publishMarkdownFile } from "./lib/feishu-doc-publisher.mjs";

const command = process.argv[2] || "";
const args = parseArgs(process.argv.slice(3));

try {
  const result = await run(command, args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}

async function run(name, options) {
  if (name === "publish") {
    return publishMarkdownFile({
      root: process.cwd(),
      file: options.file,
      key: options.key,
      title: options.title,
      folderToken: options.folderToken,
      statePath: options.state,
      credentialsPath: options.credentialsPath,
      profileName: options.profile,
      tableMode: options.tableMode || "native",
      mediaMode: options.mediaMode || "upload",
      dryRun: Boolean(options.dryRun),
      force: Boolean(options.force),
      skipReviewCheck: Boolean(options.skipReviewCheck)
    });
  }

  if (name === "create-folder") {
    const folder = await createFolder({
      name: options.name,
      folderToken: options.parentFolderToken || "",
      credentialsPath: options.credentialsPath,
      profileName: options.profile
    });
    return { ok: true, folder };
  }

  if (name === "inspect") {
    if (!options.file) throw new Error("Missing --file.");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(process.cwd(), options.file);
    const markdown = fs.readFileSync(file, "utf8");
    const blocks = markdownToBlocks(markdown, {
      sourceDir: path.dirname(file),
      tableMode: options.tableMode || "native",
      mediaMode: options.mediaMode || "upload"
    });
    return {
      ok: true,
      file: options.file,
      blocks: blocks.length,
      media_blocks: blocks.filter((block) => block.media).length
    };
  }

  throw new Error("Usage: node harness/md-to-feishu.mjs <publish|create-folder|inspect> [options]");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = toCamelCase(arg.slice(2));
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
