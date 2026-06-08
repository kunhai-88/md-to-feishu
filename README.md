# MD to Feishu

[中文文档](README.zh-CN.md)

Codex skill and zero-dependency Node.js CLI for publishing local Markdown files as Feishu/Lark Docx documents.

It is designed for technical and research documents that contain tables, code blocks, images, videos, attachments, HTML snippets, and Mermaid source blocks.

## What It Does

- Converts Markdown into Feishu/Lark Docx blocks.
- Reuses the same Feishu document with a stable `--key`.
- Converts standard Markdown/HTML tables into native Feishu table blocks.
- Falls back to readable field-list blocks when a table cannot be safely converted.
- Preserves rich text styles for bold, italic, external links, and inline code.
- Preserves code fences as Feishu code blocks and sets language metadata when available.
- Uploads local or remote images as Feishu image blocks.
- Uploads videos and attachments as Feishu file blocks.
- Strips YAML frontmatter from the published body.
- Supports dry-run inspection before writing to Feishu.

## Install As A Codex Skill

This repository is itself a Codex skill. Install it into your Codex skills directory.

macOS / Linux:

```bash
git clone https://github.com/kunhai-88/md-to-feishu.git
cd md-to-feishu
npm run install-skill
```

Windows PowerShell:

```powershell
git clone https://github.com/kunhai-88/md-to-feishu.git
cd md-to-feishu
npm run install-skill
```

The installer copies the skill to:

```text
$CODEX_HOME/skills/md-to-feishu
```

If `CODEX_HOME` is not set, it uses:

```text
<home>/.codex/skills/md-to-feishu
```

After installation, restart Codex or start a new Codex session. Then ask Codex to publish a Markdown file to Feishu.

## Authorization Required

Yes. Publishing to Feishu requires user-provided Feishu/Lark authorization.

This project does not include credentials, does not create a Feishu app for you, and does not store tokens in the repository. It only reads credentials from your local environment.

The CLI checks credentials in this order:

1. `FEISHU_OAUTH_CREDENTIALS_PATH`
2. `$HOME/.feishu-user-plugin/credentials.json`
3. `FEISHU_APP_ID` and `FEISHU_APP_SECRET`

If `--folder-token` is omitted, `FEISHU_FOLDER_TOKEN` is used when present.

Minimum practical permissions depend on your Feishu app or OAuth setup. The publishing flow needs permission to:

- create/read/update Feishu Docx documents
- create folders when using `create-folder`
- upload media for images, videos, and attachments

If authorization is missing or insufficient, the CLI fails with a Feishu API error instead of silently skipping writes.

## CLI Usage

Inspect without writing to Feishu:

```bash
node scripts/md-to-feishu.mjs inspect --file examples/smoke.md
```

Create a Feishu folder:

```bash
node scripts/md-to-feishu.mjs create-folder --name "Markdown Docs"
```

Publish a document:

```bash
node scripts/md-to-feishu.mjs publish \
  --file examples/smoke.md \
  --key smoke-doc \
  --title "Markdown Smoke" \
  --folder-token <feishu-folder-token> \
  --skip-review-check \
  --force
```

## Output State

By default, publish state is stored in:

```text
.md-to-feishu/feishu-doc-state.json
```

Use a stable `--key` to update the same Feishu document on later runs. Use `--state <path>` for isolated smoke tests.

## Rendering Rules

- Standard Markdown/HTML tables are converted to native Feishu table blocks so columns can expand naturally.
- If a table cannot be converted safely, it falls back to `表格内容：` plus bullet field rows.
- Code block languages are mapped to Feishu `code.style.language` when supported.
- `mermaid` is stored as a Markdown-language code block because Feishu has no Mermaid language enum.
- Images become Docx image blocks.
- Videos and attachments become Docx file blocks.
- Frontmatter is stripped.

## Cross-Platform Notes

- Requires Node.js 18 or newer.
- Uses only Node.js standard library APIs.
- Works on macOS, Linux, and Windows when Git, Node.js, Codex, and Feishu credentials are available.
- The installer uses `$CODEX_HOME` when set and otherwise resolves the user home directory via Node.js.

## Limitations

- Files over 20MB are not supported yet because they require Feishu multipart upload.
- Complex merged tables still fall back to readable text rows.
- Mermaid is not rendered to an image.
- Deep nesting, task checkboxes, footnotes, math, and MDX are not fully supported.

## License

MIT
