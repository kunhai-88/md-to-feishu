---
name: md-to-feishu
description: Publish local Markdown files as polished Feishu/Lark Docx documents. Use when the user asks to sync, upload, publish, or convert Markdown/MD files to Feishu docs, especially when the document contains tables, code blocks, images, videos, attachments, HTML snippets, or Mermaid/flowchart code.
---

# MD To Feishu

Use this skill to publish local Markdown into Feishu/Lark Docs with a stable, reusable workflow instead of ad-hoc conversion.

## Workflow

1. Resolve the Markdown file path from the user request.
2. Run inspect first:

   ```bash
   node <skill-dir>/scripts/md-to-feishu.mjs inspect --file <markdown-file>
   ```

3. If a target folder is missing and the user wants a new folder, create it:

   ```bash
   node <skill-dir>/scripts/md-to-feishu.mjs create-folder --name "Markdown 文档库"
   ```

4. Publish:

   ```bash
   node <skill-dir>/scripts/md-to-feishu.mjs publish \
     --file <markdown-file> \
     --key <stable-doc-key> \
     --title "<doc title>" \
     --folder-token <feishu-folder-token> \
     --skip-review-check \
     --force
   ```

5. Report the Feishu URL, `document_id`, `blocks_added`, `images_uploaded`, `files_uploaded`, and any blocker.

## Credentials

The script looks for credentials in this order:

- `FEISHU_OAUTH_CREDENTIALS_PATH`
- `$HOME/.feishu-user-plugin/credentials.json`
- `FEISHU_APP_ID` plus `FEISHU_APP_SECRET`

If no folder token is passed, it uses `FEISHU_FOLDER_TOKEN` when present.

## Publishing Rules

- Use a stable `--key` so repeated publishes update the same Feishu doc.
- Use `--force` after renderer upgrades or when the user wants a guaranteed rewrite.
- Use `--state <path>` for isolated tests or one-off smoke runs.
- Do not claim success from CLI exit alone; for important docs, read back Feishu blocks or inspect the returned counts.

## Supported Rendering

- Headings, paragraphs, quotes, bullets, and ordered lists become Feishu text blocks.
- Markdown tables and HTML tables become readable field-list blocks headed by `表格内容：`.
- Bold, italic, external links, and inline code become Feishu rich text styles.
- Code fences become Feishu code blocks with language metadata when Markdown specifies a known language.
- Mermaid fences are kept as Markdown-language code blocks because Feishu has no Mermaid code language.
- Markdown images and HTML `<img>` tags are uploaded as Feishu docx image blocks.
- Video links and HTML `<video src="...">` are uploaded as Feishu file blocks.
- PDF, Office, zip, audio, JSON, CSV, and text links are uploaded as file blocks.
- YAML frontmatter is removed from the published body.

## Limits

- Single media upload uses Feishu `drive/v1/medias/upload_all`; files over 20MB fail until multipart upload support is added.
- Tables optimize for readability, not native Feishu table blocks.
- Mermaid is not rendered into an image.
- Deeply nested lists, task checkboxes, footnotes, math, and MDX components are not fully supported.

## Quality Bar

For user-facing or reusable docs, verify at least one published document by reading Feishu blocks and checking:

- no Markdown pipe tables remain in normal text
- code blocks have `code.style.language` when the source fence has a language
- image blocks have tokens
- file blocks have tokens and filenames
- rich text styles exist for bold, italic, links, and inline code when present
