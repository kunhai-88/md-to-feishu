# MD to Feishu

[English](README.md)

这是一个 Codex skill，也是一套零依赖 Node.js CLI，用于把本地 Markdown 发布成飞书/Lark 新版文档。

它适合技术文档、研究文档、教程、笔记和资料库同步，尤其适合包含表格、代码块、图片、视频、附件、HTML 片段和 Mermaid/流程图源码的 Markdown。

## 它能做什么

- 把 Markdown 转成飞书/Lark Docx blocks。
- 通过稳定的 `--key` 复用同一个飞书文档，重复发布时更新原文档。
- 把标准 Markdown/HTML 表格转成飞书原生 table block。
- 如果表格无法安全转换，会回退成可读字段列表，避免发布失败。
- 保留加粗、斜体、外部链接、内联代码等飞书富文本样式。
- 把代码块转成飞书 code block，并尽量写入代码语言。
- 把本地或远程图片上传成飞书图片 block。
- 把视频和附件上传成飞书文件 block。
- 自动剥离 YAML frontmatter。
- 支持先 `inspect` 预检查，不写入飞书。

## 作为 Codex Skill 安装

这个仓库本身就是一个 Codex skill。把它安装到 Codex skills 目录即可。

macOS / Linux：

```bash
git clone https://github.com/kunhai-88/md-to-feishu.git
cd md-to-feishu
npm run install-skill
```

Windows PowerShell：

```powershell
git clone https://github.com/kunhai-88/md-to-feishu.git
cd md-to-feishu
npm run install-skill
```

安装脚本会复制 skill 到：

```text
$CODEX_HOME/skills/md-to-feishu
```

如果没有设置 `CODEX_HOME`，则使用：

```text
<用户目录>/.codex/skills/md-to-feishu
```

安装后，重启 Codex 或开启新的 Codex 会话。之后你可以直接让 Codex 把 Markdown 发布到飞书。

## 需要飞书授权

需要。把 Markdown 写入飞书文档，必须由用户自己提供飞书/Lark 授权。

这个项目不包含任何凭证，不会替你创建飞书应用，也不会把 token 存到仓库里。它只读取你本地环境里已经配置好的凭证。

CLI 按以下顺序读取凭证：

1. `FEISHU_OAUTH_CREDENTIALS_PATH`
2. `$HOME/.feishu-user-plugin/credentials.json`
3. `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`

如果没有传 `--folder-token`，则会读取 `FEISHU_FOLDER_TOKEN`。

实际需要的权限取决于你的飞书应用或 OAuth 配置。发布流程至少需要：

- 创建、读取、更新飞书新版文档
- 使用 `create-folder` 时创建飞书目录
- 上传图片、视频和附件素材

如果授权缺失或权限不足，CLI 会返回飞书 API 错误，不会假装写入成功。

## CLI 用法

只检查转换结果，不写飞书：

```bash
node scripts/md-to-feishu.mjs inspect --file examples/smoke.md
```

创建飞书目录：

```bash
node scripts/md-to-feishu.mjs create-folder --name "Markdown 文档库"
```

发布文档：

```bash
node scripts/md-to-feishu.mjs publish \
  --file examples/smoke.md \
  --key smoke-doc \
  --title "Markdown Smoke" \
  --folder-token <feishu-folder-token> \
  --skip-review-check \
  --force
```

## 发布状态

默认状态文件：

```text
.md-to-feishu/feishu-doc-state.json
```

使用稳定的 `--key` 可以在后续发布中更新同一个飞书文档。使用 `--state <path>` 可以做隔离测试。

## 渲染规则

- 标准 Markdown/HTML 表格会优先转成飞书原生 table block，让列宽自然展开。
- 如果表格无法安全转换，会回退成 `表格内容：` 加字段行。
- 代码块语言会映射到飞书 `code.style.language`。
- `mermaid` 会作为 Markdown 语言的代码块保存，因为飞书没有 Mermaid 专用语言枚举。
- 图片会变成 Docx image block。
- 视频和附件会变成 Docx file block。
- 文档开头的 frontmatter 会被剥离。

## 跨平台说明

- 需要 Node.js 18 或更高版本。
- 只使用 Node.js 标准库。
- 在 macOS、Linux、Windows 上，只要有 Git、Node.js、Codex 和飞书凭证，就可以使用。
- 安装脚本优先使用 `$CODEX_HOME`，否则通过 Node.js 解析当前用户目录。

## 限制

- 单个文件超过 20MB 暂不支持，因为需要飞书分片上传。
- 复杂合并表格目前仍会回退成可读文本行。
- Mermaid 目前不会渲染成图片，只保留源码代码块。
- 深层嵌套列表、任务复选框、脚注、数学公式、MDX 组件不保证完整还原。

## License

MIT
