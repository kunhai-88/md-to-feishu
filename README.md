# MD to Feishu

Codex skill and zero-dependency Node.js CLI for publishing local Markdown files as Feishu/Lark Docx documents.

It is designed for technical and research documents that contain tables, code blocks, images, videos, attachments, HTML snippets, and Mermaid source blocks.

## Features

- Convert Markdown into Feishu Docx blocks.
- Reuse the same Feishu document with a stable `--key`.
- Convert Markdown/HTML tables into readable field-list blocks.
- Preserve rich text styles for bold, italic, external links, and inline code.
- Preserve code fences as Feishu code blocks and set language metadata when available.
- Upload local or remote images as Feishu image blocks.
- Upload videos and attachments as Feishu file blocks.
- Strip YAML frontmatter from the published body.
- Dry-run with `inspect` before writing to Feishu.

## Install As A Codex Skill

Clone or copy this repository into your Codex skills directory:

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/kunhai-88/md-to-feishu.git ~/.codex/skills/md-to-feishu
```

Then ask Codex to publish a Markdown file to Feishu. The skill metadata in `SKILL.md` should trigger automatically for Markdown-to-Feishu requests.

## CLI Usage

Inspect without writing to Feishu:

```bash
node scripts/md-to-feishu.mjs inspect --file examples/smoke.md
```

Create a Feishu folder:

```bash
node scripts/md-to-feishu.mjs create-folder --name "Markdown 文档库"
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

## Credentials

The CLI checks credentials in this order:

1. `FEISHU_OAUTH_CREDENTIALS_PATH`
2. `$HOME/.feishu-user-plugin/credentials.json`
3. `FEISHU_APP_ID` and `FEISHU_APP_SECRET`

If `--folder-token` is omitted, `FEISHU_FOLDER_TOKEN` is used when present.

## Output State

By default, publish state is stored in:

```text
.md-to-feishu/feishu-doc-state.json
```

Use a stable `--key` to update the same Feishu document on later runs. Use `--state <path>` for isolated smoke tests.

## Rendering Rules

- Tables are converted to `表格内容：` plus bullet field rows for reliable readability.
- Code block languages are mapped to Feishu `code.style.language` when supported.
- `mermaid` is stored as a Markdown-language code block because Feishu has no Mermaid language enum.
- Images become docx image blocks.
- Videos and attachments become docx file blocks.
- Frontmatter is stripped.

## Limitations

- Files over 20MB are not supported yet because they require Feishu multipart upload.
- Native Feishu table blocks are not implemented.
- Mermaid is not rendered to an image.
- Deep nesting, task checkboxes, footnotes, math, and MDX are not fully supported.

## License

MIT
