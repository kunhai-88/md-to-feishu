import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_OAUTH_CREDENTIALS_PATH = path.join(process.env.HOME || ".", ".feishu-user-plugin", "credentials.json");
const DEFAULT_STATE_PATH = ".md-to-feishu/feishu-doc-state.json";
const DEFAULT_AGENT_RUNS_PATH = ".md-to-feishu/agent-runs.jsonl";
const RENDERER_VERSION = "md-to-feishu-v3-native-table";
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const TABLE_PLACEHOLDER_PREFIX = "@@FEISHU_TABLE_BLOCK_";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".txt",
  ".csv",
  ".json"
]);

export async function publishMarkdownFile(options) {
  const root = path.resolve(options.root || process.cwd());
  const file = path.resolve(root, options.file || "");
  if (!options.file) throw new Error("Missing --file.");
  if (!fs.existsSync(file)) throw new Error(`Markdown file not found: ${file}`);

  const statePath = path.resolve(root, options.statePath || DEFAULT_STATE_PATH);
  const agentRunsPath = path.resolve(root, options.agentRunsPath || DEFAULT_AGENT_RUNS_PATH);
  if (!options.skipReviewCheck) {
    assertReviewPassed(path.dirname(file));
  }

  const markdown = fs.readFileSync(file, "utf8");
  const title = options.title || extractTitle(markdown) || path.basename(file, path.extname(file));
  const key = options.key || slugify(path.relative(root, file));
  const state = loadState(statePath);
  const previous = state.documents?.[key] || {};
  const hash = sha256(`${RENDERER_VERSION}\n${markdown}`);

  if (!options.force && previous.hash === hash && previous.doc_token) {
    return {
      ok: true,
      skipped: true,
      reason: "unchanged",
      key,
      title,
      document_id: previous.doc_token,
      url: previous.url
    };
  }

  const blocks = markdownToBlocks(markdown, {
    sourceDir: path.dirname(file),
    tableMode: options.tableMode || "readable",
    mediaMode: options.mediaMode || "upload"
  });

  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      key,
      title,
      would_create: !previous.doc_token,
      blocks: blocks.length,
      media_blocks: blocks.filter((block) => block.media).length
    };
  }

  const auth = await getFeishuAccessToken({
    credentialsPath: options.credentialsPath,
    profileName: options.profileName
  });
  const folderToken = options.folderToken || process.env.FEISHU_FOLDER_TOKEN;
  const doc = previous.doc_token
    ? { document_id: previous.doc_token, url: previous.url || `https://my.feishu.cn/docx/${previous.doc_token}` }
    : await createDocument({ token: auth.token, title, folderToken });

  const deleted = await clearDocumentContent({ token: auth.token, documentId: doc.document_id });
  const writeResult = await writeBlocks({
    token: auth.token,
    documentId: doc.document_id,
    blocks
  });

  state.documents ||= {};
  state.documents[key] = {
    key,
    source: path.relative(root, file),
    title,
    doc_token: doc.document_id,
    url: doc.url,
    hash,
    updated_at: nowIso()
  };
  writeJson(statePath, state);

  const result = {
    ok: true,
    key,
    title,
    source: path.relative(root, file),
    document_id: doc.document_id,
    url: doc.url,
    created: !previous.doc_token,
    blocks_deleted: deleted,
    blocks_added: writeResult.blocks_added,
    images_uploaded: writeResult.images_uploaded,
    files_uploaded: writeResult.files_uploaded,
    auth_source: auth.source
  };

  writeJson(path.join(path.dirname(file), "feishu-publish-result.json"), result);
  appendJsonl(agentRunsPath, {
    id: `run-${Date.now()}`,
    agent: "md_to_feishu_publisher",
    status: "passed",
    started_at: nowIso(),
    completed_at: nowIso(),
    checks: ["docx_written"],
    result
  });
  return result;
}

export async function createFolder({ name, folderToken = "", credentialsPath, profileName } = {}) {
  if (!name) throw new Error("Missing folder name.");
  const auth = await getFeishuAccessToken({ credentialsPath, profileName });
  const payload = await feishuFetch("/drive/v1/files/create_folder", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      name,
      folder_token: folderToken
    })
  });
  const data = payload.data || {};
  if (!data.token) throw new Error("Feishu create_folder response did not include folder token.");
  return {
    name,
    token: data.token,
    url: data.url || `https://my.feishu.cn/drive/folder/${data.token}`,
    auth_source: auth.source
  };
}

export function markdownToBlocks(markdown, options = {}) {
  const prepared = normalizeMarkdownForFeishu(markdown, options);
  const preparedText = typeof prepared === "string" ? prepared : prepared.text;
  const preparedTables = typeof prepared === "string" ? [] : prepared.tables || [];
  const blocks = [];
  let codeFence = null;
  let codeLines = [];

  for (const rawLine of preparedText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      if (codeFence) {
        blocks.push(codeBlock(codeLines.join("\n"), codeFence));
        codeFence = null;
        codeLines = [];
      } else {
        codeFence = fence[1] || "text";
        codeLines = [];
      }
      continue;
    }
    if (codeFence) {
      codeLines.push(rawLine);
      continue;
    }
    if (!line.trim()) continue;

    const tablePlaceholder = line.trim().match(/^@@FEISHU_TABLE_BLOCK_(\d+)@@$/);
    if (tablePlaceholder) {
      const table = preparedTables[Number(tablePlaceholder[1])];
      if (table?.rows?.length) {
        blocks.push({ table });
        continue;
      }
    }

    const media = parseMarkdownMediaLine(line, options.sourceDir || process.cwd());
    if (media) {
      blocks.push({ media });
      if (media.alt) blocks.push(textBlock(2, "text", `说明：${media.alt}`));
      continue;
    }

    if (line.startsWith("# ")) blocks.push(textBlock(3, "heading1", line.slice(2).trim()));
    else if (line.startsWith("## ")) blocks.push(textBlock(4, "heading2", line.slice(3).trim()));
    else if (line.startsWith("### ")) blocks.push(textBlock(5, "heading3", line.slice(4).trim()));
    else if (line.startsWith("- ")) blocks.push(textBlock(12, "bullet", line.slice(2).trim()));
    else if (/^\d+\.\s+/.test(line)) blocks.push(textBlock(13, "ordered", line.replace(/^\d+\.\s+/, "").trim()));
    else if (line.startsWith("> ")) blocks.push(textBlock(15, "quote", line.slice(2).trim()));
    else blocks.push(textBlock(2, "text", line.trim()));
  }

  if (codeFence) blocks.push(codeBlock(codeLines.join("\n"), codeFence));
  return blocks.length ? blocks : [textBlock(2, "text", " ")];
}

export function normalizeMarkdownForFeishu(markdown, options = {}) {
  const withoutFrontmatter = stripFrontmatter(markdown);
  const fenced = protectFencedCode(withoutFrontmatter);
  const tableMode = options.tableMode || "native";
  const tables = [];
  const htmlConverted = restoreFencedCode(htmlToMarkdown(fenced.text, { tableMode, tables }), fenced.blocks);
  const convertedTables = tableMode === "preserve" ? htmlConverted : convertMarkdownTables(htmlConverted, { tableMode, tables });
  const lines = [];
  let inCode = false;

  for (const raw of convertedTables.split(/\r?\n/)) {
    let line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      lines.push(line);
      continue;
    }
    if (inCode) {
      lines.push(line);
      continue;
    }
    line = line
      .replace(/^#{4,9}\s+/, "### ")
      .replace(/^\s*---+\s*$/, "")
      .replace(/^\s*>\s?/, "> ");
    lines.push(line);
  }
  return {
    text: lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim(),
    tables
  };
}

export function htmlToMarkdown(input, options = {}) {
  let text = String(input || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<div[^>]*class="[^"]*\bmermaid\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, (_, body) => {
      return `\n\n\`\`\`mermaid\n${decodeHtml(stripTags(body)).trim()}\n\`\`\`\n\n`;
    })
    .replace(/<table[\s\S]*?<\/table>/gi, (table) => {
      const tableData = parseHtmlTable(table);
      if (options.tableMode === "native" && tableData?.rows?.length) {
        return `\n\n${registerTablePlaceholder(tableData, options.tables || [])}\n\n`;
      }
      return `\n\n${htmlTableToReadableMarkdown(table)}\n\n`;
    })
    .replace(/<\/(h1|h2|h3|p|li|tr|table|section|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<img\b([^>]*)>/gi, (_, attrs) => {
      const src = htmlAttribute(attrs, "src");
      const alt = htmlAttribute(attrs, "alt");
      if (!src) return "";
      return `\n![${alt || ""}](${src})\n`;
    })
    .replace(/<video\b([^>]*)>[\s\S]*?<\/video>/gi, (_, attrs) => {
      const src = htmlAttribute(attrs, "src");
      if (!src) return "";
      return `\n[视频素材](${src})\n`;
    })
    .replace(/<code[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<strong[^>]*>/gi, "**")
    .replace(/<\/strong>/gi, "**")
    .replace(/<em[^>]*>/gi, "*")
    .replace(/<\/em>/gi, "*")
    .replace(/<[^>]+>/g, "");
  text = text
    .split(/\r?\n/)
    .map((line) => decodeHtml(line).replace(/[ \t]+/g, " ").trimEnd())
    .join("\n");
  return text;
}

async function writeBlocks({ token, documentId, blocks }) {
  let blocksAdded = 0;
  let imagesUploaded = 0;
  let filesUploaded = 0;
  let textBatch = [];

  for (const block of blocks) {
    if (block.media || block.table) {
      if (textBatch.length) {
        blocksAdded += await writeTextBlockBatch({ token, documentId, blocks: textBatch });
        textBatch = [];
      }
      const result = block.table
        ? await insertTableBlock({ token, documentId, table: block.table })
        : await insertMediaBlock({ token, documentId, media: block.media });
      blocksAdded += result.blocks_added;
      imagesUploaded += result.images_uploaded;
      filesUploaded += result.files_uploaded;
      continue;
    }

    textBatch.push(block);
    if (textBatch.length >= 40) {
      blocksAdded += await writeTextBlockBatch({ token, documentId, blocks: textBatch });
      textBatch = [];
    }
  }

  if (textBatch.length) {
    blocksAdded += await writeTextBlockBatch({ token, documentId, blocks: textBatch });
  }
  return { blocks_added: blocksAdded, images_uploaded: imagesUploaded, files_uploaded: filesUploaded };
}

async function insertMediaBlock({ token, documentId, media }) {
  if (media.kind === "image") {
    await insertImageBlock({ token, documentId, media });
    return { blocks_added: 1, images_uploaded: 1, files_uploaded: 0 };
  }
  await insertFileBlock({ token, documentId, media });
  return { blocks_added: 1, images_uploaded: 0, files_uploaded: 1 };
}

async function insertTableBlock({ token, documentId, table }) {
  const rows = normalizeTableRows(table.rows);
  if (!rows.length || !rows[0].length) {
    return { blocks_added: 0, images_uploaded: 0, files_uploaded: 0 };
  }

  const columnSize = Math.max(...rows.map((row) => row.length));
  const paddedRows = rows.map((row) => padRow(row, columnSize));
  const created = await createChildBlock({
    token,
    documentId,
    child: {
      block_type: 31,
      table: {
        property: {
          row_size: paddedRows.length,
          column_size: columnSize
        }
      }
    }
  });
  const cellIds = created.children || created.table?.cells || [];
  if (cellIds.length !== paddedRows.length * columnSize) {
    throw new Error(`Feishu table creation returned ${cellIds.length} cells, expected ${paddedRows.length * columnSize}.`);
  }

  let insertedChildren = 1;
  for (let rowIndex = 0; rowIndex < paddedRows.length; rowIndex += 1) {
    const row = paddedRows[rowIndex];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const cellId = cellIds[rowIndex * columnSize + columnIndex];
      const text = row[columnIndex] || " ";
      await createChildBlock({
        token,
        documentId,
        parentBlockId: cellId,
        child: textBlock(2, "text", text)
      });
      insertedChildren += 1;
    }
  }

  return { blocks_added: insertedChildren, images_uploaded: 0, files_uploaded: 0 };
}

async function writeTextBlockBatch({ token, documentId, blocks }) {
  let blocksAdded = 0;
  for (const chunk of chunks(blocks, 40)) {
    const payload = await feishuFetch(`/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      method: "POST",
      token,
      body: JSON.stringify({ children: chunk })
    });
    blocksAdded += payload.data?.children?.length || chunk.length;
    await sleep(350);
  }
  return blocksAdded;
}

async function insertImageBlock({ token, documentId, media }) {
  const created = await createChildBlock({
    token,
    documentId,
    child: {
      block_type: 27,
      image: {}
    }
  });
  const imageBlockId = created.block_id;
  if (!imageBlockId) throw new Error(`Feishu did not create image block for ${media.src}`);

  const file = await readMedia(media);
  const fileToken = await uploadMedia({
    token,
    file,
    parentType: "docx_image",
    parentNode: imageBlockId
  });
  await patchBlock({
    token,
    documentId,
    blockId: imageBlockId,
    body: {
      replace_image: {
        token: fileToken
      }
    }
  });
}

async function insertFileBlock({ token, documentId, media }) {
  const created = await createChildBlock({
    token,
    documentId,
    child: {
      block_type: 23,
      file: {}
    }
  });
  const fileBlockId = created.block_type === 23 ? created.block_id : created.children?.[0];
  if (!fileBlockId) throw new Error(`Feishu did not create file block for ${media.src}`);

  const file = await readMedia(media);
  const fileToken = await uploadMedia({
    token,
    file,
    parentType: "docx_file",
    parentNode: fileBlockId
  });
  await patchBlock({
    token,
    documentId,
    blockId: fileBlockId,
    body: {
      replace_file: {
        token: fileToken
      }
    }
  });
}

async function createChildBlock({ token, documentId, parentBlockId = documentId, child }) {
  const created = await feishuFetch(`/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`, {
    method: "POST",
    token,
    body: JSON.stringify({ children: [child] })
  });
  await sleep(350);
  return created.data?.children?.[0] || {};
}

async function patchBlock({ token, documentId, blockId, body }) {
  await feishuFetch(`/docx/v1/documents/${documentId}/blocks/${blockId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(body)
  });
  await sleep(350);
}

async function uploadMedia({ token, file, parentType, parentNode }) {
  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error(`Feishu media upload_all limit is 20MB; ${file.fileName} is ${file.size} bytes. Use multipart media upload before publishing this file.`);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const form = new FormData();
    form.append("file_name", file.fileName);
    form.append("parent_type", parentType);
    form.append("parent_node", parentNode);
    form.append("size", String(file.size));
    form.append("file", new Blob([file.buffer], { type: file.contentType }), file.fileName);

    let response;
    let payload = {};
    try {
      response = await fetch(`${BASE_URL}/drive/v1/medias/upload_all`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`
        },
        body: form,
        signal: AbortSignal.timeout(90000)
      });
      payload = await response.json().catch(() => ({}));
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`media upload failed after ${attempt} attempts: ${error.message || error}`);
    }

    if (!response.ok || payload.code !== 0) {
      const message = payload.msg || response.status;
      lastError = new Error(`media upload failed: ${message}`);
      if (attempt < 4 && isRetriableMediaUploadFailure(response.status)) {
        await sleep(1000 * attempt);
        continue;
      }
      throw lastError;
    }

    const fileToken = payload.data?.file_token;
    if (!fileToken) throw new Error("media upload did not return file_token");
    return fileToken;
  }

  throw lastError || new Error("media upload failed");
}

function isRetriableMediaUploadFailure(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function readMedia(media) {
  if (/^https?:\/\//i.test(media.src)) {
    const response = await fetch(media.src, {
      headers: {
        "user-agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new Error(`Media download failed ${response.status}: ${media.src}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error(`Media download returned empty body: ${media.src}`);
    const contentType = response.headers.get("content-type") || contentTypeFromPath(media.src);
    return {
      buffer,
      size: buffer.length,
      contentType,
      fileName: fileNameFromUrl(media.src, contentType)
    };
  }

  const filePath = path.resolve(media.baseDir || process.cwd(), media.src);
  if (!fs.existsSync(filePath)) throw new Error(`Media file not found: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (!stat.size) throw new Error(`Cannot upload empty media file: ${filePath}`);
  return {
    buffer: fs.readFileSync(filePath),
    size: stat.size,
    contentType: contentTypeFromPath(filePath),
    fileName: path.basename(filePath)
  };
}

async function getFeishuAccessToken({ credentialsPath, profileName } = {}) {
  const resolvedCredentialsPath = credentialsPath || process.env.FEISHU_OAUTH_CREDENTIALS_PATH || DEFAULT_OAUTH_CREDENTIALS_PATH;
  const resolvedProfileName = profileName || process.env.FEISHU_OAUTH_PROFILE || "default";
  const oauth = loadOAuthProfile(resolvedCredentialsPath, resolvedProfileName);
  if (oauth?.accessToken) {
    if (oauth.expiresAt && oauth.expiresAt - nowSeconds() < 300 && oauth.refreshToken) {
      return refreshOAuthProfile({
        credentialsPath: resolvedCredentialsPath,
        profileName: resolvedProfileName,
        profile: oauth.raw
      });
    }
    return {
      token: oauth.accessToken,
      source: "oauth_user_access_token",
      credentialsPath: resolvedCredentialsPath,
      profileName: resolvedProfileName
    };
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("No Feishu OAuth profile and FEISHU_APP_ID/FEISHU_APP_SECRET are not configured.");
  }
  const response = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) throw new Error(`tenant_access_token failed: ${payload.msg || payload.code || response.status}`);
  return { token: payload.tenant_access_token, source: "tenant_access_token" };
}

async function createDocument({ token, title, folderToken }) {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  const payload = await feishuFetch("/docx/v1/documents", {
    method: "POST",
    token,
    body: JSON.stringify(body)
  });
  const doc = payload.data?.document;
  if (!doc?.document_id) throw new Error("Feishu did not return document_id.");
  return {
    document_id: doc.document_id,
    url: doc.url || `https://my.feishu.cn/docx/${doc.document_id}`
  };
}

async function clearDocumentContent({ token, documentId }) {
  let deleted = 0;
  while (true) {
    const list = await feishuFetch(`/docx/v1/documents/${documentId}/blocks?page_size=500`, {
      method: "GET",
      token
    });
    const children = (list.data?.items || []).filter((block) => block.parent_id === documentId && block.block_type !== 1);
    if (!children.length) return deleted;
    await feishuFetch(`/docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_delete`, {
      method: "DELETE",
      token,
      body: JSON.stringify({
        start_index: 0,
        end_index: children.length
      })
    });
    deleted += children.length;
    await sleep(350);
  }
}

async function feishuFetch(apiPath, options = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
  };
  const response = await fetch(`${BASE_URL}${apiPath}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || 60000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) {
    const error = new Error(`${apiPath} failed: ${payload.msg || response.status}`);
    error.response = payload;
    throw error;
  }
  return payload;
}

function convertMarkdownTables(markdown, options = {}) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  for (let index = 0; index < lines.length;) {
    if (isMarkdownTableLine(lines[index]) && isMarkdownTableSeparator(lines[index + 1] || "")) {
      const block = [];
      while (index < lines.length && isMarkdownTableLine(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }
      const tableRows = parseMarkdownTable(block);
      if (options.tableMode === "native" && tableRows?.rows?.length) {
        out.push("", registerTablePlaceholder(tableRows, options.tables || []), "");
      } else {
        out.push(...markdownTableToReadableLines(block));
      }
      continue;
    }
    out.push(lines[index]);
    index += 1;
  }
  return out.join("\n");
}

function markdownTableToReadableLines(block) {
  const parsed = parseMarkdownTable(block);
  const rows = parsed.rows;
  if (!rows.length) return [];
  const [headers, ...bodyRows] = rows;
  const useHeaders = bodyRows.length > 0 && headers.length > 1;
  const dataRows = useHeaders ? bodyRows : rows;
  const output = ["", "表格内容："];
  for (const row of dataRows) {
    const cells = row.map(cleanInline);
    if (useHeaders && cells.length === headers.length) {
      output.push(`- ${headers.map((header, index) => `${cleanInline(header)}：${cells[index] || ""}`).join("；")}`);
    } else if (cells.length === 2) {
      output.push(`- ${cells[0]}：${cells[1]}`);
    } else {
      output.push(`- ${cells.join("；")}`);
    }
  }
  output.push("");
  return output;
}

function htmlTableToReadableMarkdown(tableHtml) {
  const parsed = parseHtmlTable(tableHtml);
  const rows = parsed.rows;
  if (!rows.length) return "";
  const [headers, ...bodyRows] = rows;
  const useHeaders = bodyRows.length && headers.length > 1;
  const dataRows = useHeaders ? bodyRows : rows;
  const lines = ["表格内容："];
  for (const row of dataRows) {
    if (useHeaders && row.length === headers.length) {
      lines.push(`- ${headers.map((header, index) => `${header}：${row[index] || ""}`).join("；")}`);
    } else if (row.length === 2) {
      lines.push(`- ${row[0]}：${row[1]}`);
    } else {
      lines.push(`- ${row.join("；")}`);
    }
  }
  return lines.join("\n");
}

function parseMarkdownMediaLine(line, sourceDir) {
  const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (image) {
    const src = parseMarkdownDestination(image[2]).url;
    const ext = extensionFromSrc(src);
    const kind = VIDEO_EXTENSIONS.has(ext) ? "file" : "image";
    return { kind, alt: image[1] || "", src, baseDir: sourceDir };
  }

  const link = line.match(/^\[([^\]]+)\]\(([^)]+)\)\s*$/);
  if (link) {
    const src = parseMarkdownDestination(link[2]).url;
    const ext = extensionFromSrc(src);
    if (VIDEO_EXTENSIONS.has(ext) || isLikelyAttachmentExtension(ext)) {
      return { kind: "file", alt: link[1] || "", src, baseDir: sourceDir };
    }
  }
  return null;
}

function parseMarkdownDestination(value) {
  const raw = String(value || "").trim();
  const quotedTitle = raw.match(/^(.+?)\s+"[^"]*"$/);
  return {
    url: (quotedTitle ? quotedTitle[1] : raw).trim().replace(/^<|>$/g, "")
  };
}

function isMarkdownTableLine(line) {
  const trimmed = String(line || "").trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|", 1);
}

function isMarkdownTableSeparator(line) {
  const row = splitMarkdownTableRow(line);
  return row.length > 0 && row.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdownTable(block) {
  return {
    rows: block
      .map(splitMarkdownTableRow)
      .filter((row) => row.length && !row.every((cell) => /^:?-{2,}:?$/.test(cell.trim())))
      .map((row) => row.map(cleanInline))
      .filter((row) => row.some(Boolean))
  };
}

function parseHtmlTable(tableHtml) {
  return {
    rows: [...String(tableHtml || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((match) => {
        return [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
          .map((cell) => cleanInline(stripTags(cell[1])));
      })
      .filter((row) => row.length && row.some((cell) => cell !== ""))
  };
}

function registerTablePlaceholder(table, tables) {
  const index = tables.push(table) - 1;
  return `${TABLE_PLACEHOLDER_PREFIX}${index}@@`;
}

function normalizeTableRows(rows) {
  return (rows || [])
    .map((row) => row.map((cell) => cleanInline(cell || "")))
    .filter((row) => row.length && row.some((cell) => cell !== ""));
}

function padRow(row, width) {
  const next = row.slice(0, width);
  while (next.length < width) next.push("");
  return next;
}

function cleanInline(value) {
  const codeSpans = [];
  let text = decodeHtml(String(value || ""))
    .replace(/`([^`]+)`/g, (_, code) => {
      const marker = `@@CODESPAN${codeSpans.length}@@`;
      codeSpans.push(code);
      return marker;
    });
  text = text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
      if (!url || url.startsWith("#") || /^[./]/.test(url)) return label;
      return `${label}（${url}）`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/@@CODESPAN(\d+)@@/g, (_, index) => codeSpans[Number(index)] || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function textBlock(blockType, key, content, options = {}) {
  const elements = options.parseInline === false
    ? plainTextElements(String(content || " "))
    : parseInlineElements(String(content || " "));
  return {
    block_type: blockType,
    [key]: {
      elements,
      style: {}
    }
  };
}

function codeBlock(content, language) {
  const block = textBlock(14, "code", content || " ", { parseInline: false });
  const codeLanguage = codeLanguageId(language);
  block.code.style = {
    ...block.code.style,
    wrap: true,
    ...(codeLanguage ? { language: codeLanguage } : {})
  };
  return block;
}

function parseInlineElements(content) {
  const text = String(content || " ");
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"]*")?\))/g;
  const elements = [];
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      pushTextElement(elements, text.slice(cursor, match.index), {});
    }
    const token = match[0];
    if (token.startsWith("`")) {
      pushTextElement(elements, token.slice(1, -1), { inline_code: true });
    } else if (token.startsWith("**") && token.endsWith("**")) {
      pushTextElement(elements, token.slice(2, -2), { bold: true });
    } else if (token.startsWith("__") && token.endsWith("__")) {
      pushTextElement(elements, token.slice(2, -2), { bold: true });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      pushTextElement(elements, token.slice(1, -1), { italic: true });
    } else {
      const parsedLink = token.match(/^\[([^\]\n]+)\]\(([^) \n]+)(?:\s+"[^"]*")?\)$/);
      if (parsedLink) {
        const [, label, url] = parsedLink;
        if (/^https?:\/\//i.test(url)) {
          pushTextElement(elements, label, { link: { url } });
        } else {
          pushTextElement(elements, label, {});
        }
      } else {
        pushTextElement(elements, token, {});
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    pushTextElement(elements, text.slice(cursor), {});
  }
  return elements.length ? elements : plainTextElements(" ");
}

function plainTextElements(content) {
  return [
    {
      text_run: {
        content: decodeHtml(String(content || " ")),
        text_element_style: {}
      }
    }
  ];
}

function pushTextElement(elements, content, style) {
  const decoded = decodeHtml(String(content || ""));
  if (!decoded) return;
  elements.push({
    text_run: {
      content: decoded,
      text_element_style: style || {}
    }
  });
}

function protectFencedCode(markdown) {
  const blocks = [];
  const text = String(markdown || "").replace(/```[A-Za-z0-9_-]*\s*\n[\s\S]*?\n```/g, (block) => {
    const marker = `@@FENCEDCODE${blocks.length}@@`;
    blocks.push(block);
    return marker;
  });
  return { text, blocks };
}

function restoreFencedCode(text, blocks) {
  return String(text || "").replace(/@@FENCEDCODE(\d+)@@/g, (_, index) => blocks[Number(index)] || "");
}

function codeLanguageId(language) {
  const key = String(language || "").trim().toLowerCase();
  if (!key) return 1;
  const aliases = {
    text: 1,
    plaintext: 1,
    plain: 1,
    sh: 60,
    shell: 60,
    bash: 7,
    zsh: 60,
    powershell: 46,
    ps1: 46,
    csharp: 8,
    cs: 8,
    cpp: 9,
    "c++": 9,
    c: 10,
    css: 12,
    dart: 15,
    dockerfile: 18,
    go: 22,
    golang: 22,
    html: 24,
    http: 26,
    json: 28,
    java: 29,
    js: 30,
    javascript: 30,
    jsx: 30,
    kotlin: 32,
    kt: 32,
    latex: 33,
    lua: 36,
    makefile: 38,
    make: 38,
    md: 39,
    markdown: 39,
    mermaid: 39,
    nginx: 40,
    objectivec: 41,
    "objective-c": 41,
    php: 43,
    perl: 44,
    protobuf: 48,
    proto: 48,
    py: 49,
    python: 49,
    r: 50,
    rb: 52,
    ruby: 52,
    rs: 53,
    rust: 53,
    scss: 55,
    sql: 56,
    scala: 57,
    swift: 61,
    thrift: 62,
    ts: 63,
    typescript: 63,
    tsx: 63,
    vb: 65,
    visualbasic: 65,
    xml: 66,
    yml: 67,
    yaml: 67,
    cmake: 68,
    diff: 69,
    patch: 69,
    gherkin: 70,
    graphql: 71,
    glsl: 72,
    properties: 73,
    solidity: 74,
    sol: 74,
    toml: 75
  };
  return aliases[key] || 1;
}

function assertReviewPassed(runDir) {
  const reviewPath = path.join(runDir, "review-report.final.json");
  if (!fs.existsSync(reviewPath)) throw new Error(`Final review report not found: ${reviewPath}`);
  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  if (review.status !== "pass") throw new Error(`Final review has not passed: ${review.status}`);
}

function loadOAuthProfile(credentialsPath, profileName) {
  if (!credentialsPath || !fs.existsSync(credentialsPath)) return null;
  const store = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  const profile = store.profiles?.[profileName || store.active || "default"];
  if (!profile?.LARK_USER_ACCESS_TOKEN) return null;
  return {
    raw: profile,
    accessToken: profile.LARK_USER_ACCESS_TOKEN,
    refreshToken: profile.LARK_USER_REFRESH_TOKEN,
    expiresAt: Number(profile.LARK_UAT_EXPIRES || 0)
  };
}

async function refreshOAuthProfile({ credentialsPath, profileName, profile }) {
  const appId = profile.LARK_APP_ID;
  const appSecret = profile.LARK_APP_SECRET;
  const refreshToken = profile.LARK_USER_REFRESH_TOKEN;
  if (!appId || !appSecret || !refreshToken) {
    throw new Error("OAuth profile cannot refresh because app id, app secret, or refresh token is missing.");
  }
  const response = await fetch(`${BASE_URL}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshToken
    }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) {
    throw new Error(`OAuth refresh failed: ${payload.msg || response.status}`);
  }
  const tokenData = payload.data || payload;
  const nextAccessToken = tokenData.access_token || tokenData.user_access_token;
  const nextRefreshToken = tokenData.refresh_token || refreshToken;
  const expiresIn = Number(tokenData.expires_in || 6900);
  if (!nextAccessToken) throw new Error("OAuth refresh response did not include access_token.");

  const store = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  const target = store.profiles?.[profileName || store.active || "default"];
  if (!target) throw new Error(`OAuth profile not found while refreshing: ${profileName}`);
  target.LARK_USER_ACCESS_TOKEN = nextAccessToken;
  target.LARK_USER_REFRESH_TOKEN = nextRefreshToken;
  target.LARK_UAT_EXPIRES = nowSeconds() + expiresIn;
  fs.writeFileSync(credentialsPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return {
    token: nextAccessToken,
    source: "oauth_user_access_token_refreshed",
    credentialsPath,
    profileName
  };
}

function loadState(file) {
  if (!fs.existsSync(file)) return { documents: {} };
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.documents ||= {};
  return state;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function extractTitle(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || "";
}

function stripTags(value) {
  return String(value || "")
    .replace(/<code[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripFrontmatter(markdown) {
  return String(markdown || "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, "");
}

function htmlAttribute(attrs, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = String(attrs || "").match(pattern);
  return decodeHtml(match?.[2] || match?.[3] || match?.[4] || "");
}

function extensionFromSrc(src) {
  try {
    const url = /^https?:\/\//i.test(src) ? new URL(src) : null;
    return path.extname(url ? url.pathname : src).toLowerCase();
  } catch {
    return path.extname(src).toLowerCase();
  }
}

function isLikelyAttachmentExtension(ext) {
  return ATTACHMENT_EXTENSIONS.has(ext);
}

function contentTypeFromPath(value) {
  const ext = extensionFromSrc(value);
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".md": "text/markdown",
    ".txt": "text/plain"
  };
  return map[ext] || "application/octet-stream";
}

function fileNameFromUrl(value, contentType) {
  try {
    const url = new URL(value);
    const name = path.basename(url.pathname);
    if (name && name.includes(".")) return name;
  } catch {
    // fall through
  }
  const ext = contentType?.split("/")?.[1] || "bin";
  return `media-${Date.now()}.${ext.replace("jpeg", "jpg")}`;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
