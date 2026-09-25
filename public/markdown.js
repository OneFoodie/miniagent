/**
 * 轻量 Markdown 渲染（零依赖、纯函数，浏览器与测试共用）。
 *
 * 为什么手写而不用 marked/markdown-it：这个控制台是"零构建直接跑"的（`public/` 原样由
 * node:http 托管），引一个打包器或几百 KB 的解析器都不划算；而模型输出用到的语法是**有界**的
 * ——标题、列表、表格、代码块、引用、图片、链接就够了。
 *
 * 安全前提（这是本文件最要紧的事）：
 *   1. **先转义再拼标签**：全文先过 escapeHtml（含引号），因此模型输出的 HTML 不会被执行，
 *      也不可能从属性里逃逸出去（`"` 已变 `&quot;`）；
 *   2. **URL 白名单**：`javascript:` / `vbscript:` 之类一律拒绝，见 safeUrl；
 *   3. **SVG 走 `<img>` + data: URL**：SVG 里的脚本在 img 上下文里不会执行，等于天然沙箱，
 *      不需要自己写 SVG 消毒器。
 *
 * 输出约定（给 app.js 用）：
 *   - ` ```mermaid ` → `<div class="mermaid">源码</div>`，由 app.js 交给 mermaid 渲染
 *   - ` ```svg `     → `<img class="svg-figure" src="data:image/svg+xml,...">`
 *   - 表格 → `<div class="table-wrap"><table>…</table></div>`（外层负责横向滚动）
 */

const FENCE_MARK = "\u0000CODE";
const TICK_MARK = "\u0000TICK";

/** 渲染 Markdown 片段为 HTML 字符串（调用方用 innerHTML 写入） */
export function renderMarkdown(raw) {
  if (typeof raw !== "string" || raw === "") return "";

  // 1. 先摘出围栏代码块（连同语言标记），避免其内容被后续规则改动
  const fences = [];
  let text = raw.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    fences.push({
      lang: String(lang).trim().toLowerCase(),
      code: String(code).replace(/\n+$/, ""),
    });
    return `${FENCE_MARK}${fences.length - 1}\u0000`;
  });

  // 2. 整体转义：此后所有标签都由本模块自己拼，模型输出只剩下文本
  text = escapeHtml(text);

  // 3. 块级解析
  const html = renderBlocks(text.split("\n"));

  // 4. 还原围栏：mermaid / svg 特判，其余按语言标记成代码块
  // eslint-disable-next-line no-control-regex -- 占位符用 NUL 前缀，正常文本不会出现
  return html.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => {
    const fence = fences[Number(index)];
    if (!fence) return "";
    if (fence.lang === "mermaid") {
      return `<div class="mermaid">${escapeHtml(fence.code)}</div>`;
    }
    if (fence.lang === "svg") return renderSvgFigure(fence.code);
    const cls = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : "";
    return `<pre><code${cls}>${escapeHtml(fence.code)}</code></pre>`;
  });
}

/** 围栏代码块单独成行时的占位符：这类行属于块级，不能被包进 `<p>` */
function isFencePlaceholder(line) {
  // eslint-disable-next-line no-control-regex -- 同上：NUL 前缀是内部占位约定
  return /^\u0000CODE\d+\u0000$/.test(line);
}

/** 块级结构：标题 / 引用 / 分隔线 / 表格 / 列表 / 段落 */
function renderBlocks(lines) {
  const out = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    // 段内的单个换行按软换行处理：模型写中文长句时常这么折行，直接合成一段更接近它的意图
    out.push(`<p>${paragraph.map(inline).join("<br />")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (trimmed === "") {
      flushParagraph();
      closeList();
      continue;
    }

    // 代码块占位符：直接作为块级内容输出（包进 <p> 会得到 <p><pre>…</pre></p> 这种非法结构）
    if (isFencePlaceholder(trimmed)) {
      flushParagraph();
      closeList();
      out.push(trimmed);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push("<hr />");
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // 注意：块级解析发生在转义之后，所以 `>` 到这里已经是 `&gt;`
    if (trimmed.startsWith("&gt;")) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inline(trimmed.replace(/^&gt;\s?/, ""))}</blockquote>`);
      continue;
    }

    // 表格：本行含 | 且下一行是分隔行，才算表格（否则只是正文里的竖线）
    if (trimmed.includes("|") && isDividerRow(lines[index + 1])) {
      flushParagraph();
      closeList();
      const table = renderTable(lines, index);
      out.push(table.html);
      index = table.lastIndex;
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return out.join("\n");
}

/** 分隔行：| --- | :--: | 这类，只由 -、:、|、空格组成且至少有一个 - */
function isDividerRow(line) {
  if (line === undefined) return false;
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  return /^\|?[\s:|-]+\|?$/.test(trimmed);
}

/** 拆一行表格：去掉首尾竖线，支持 `\|` 转义 */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 对齐方式：:--- 左 / :---: 中 / ---: 右 */
function alignOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : "";
}

/**
 * 渲染整张表格。
 * 列数以表头为准：单元格多的截断、少的补空——模型偶尔会写歪一行，
 * 那种情况下"少一列"比"整张表崩掉"好得多。
 */
function renderTable(lines, startIndex) {
  const header = splitRow(lines[startIndex]);
  const aligns = splitRow(lines[startIndex + 1]).map(alignOf);
  const bodyRows = [];

  let index = startIndex + 2;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed === "" || !trimmed.includes("|")) break;
    bodyRows.push(splitRow(lines[index]));
    index += 1;
  }

  const cell = (tag, text, column) => {
    const align = aligns[column];
    const cls = align ? ` class="ta-${align}"` : "";
    return `<${tag}${cls}>${inline(text)}</${tag}>`;
  };
  const normalize = (cells) =>
    header.map((_item, column) => cells[column] ?? "");

  const head = normalize(header).map((text, column) => cell("th", text, column));
  const body = bodyRows.map(
    (row) =>
      `<tr>${normalize(row)
        .map((text, column) => cell("td", text, column))
        .join("")}</tr>`,
  );

  const html = [
    '<div class="table-wrap"><table>',
    `<thead><tr>${head.join("")}</tr></thead>`,
    body.length > 0 ? `<tbody>${body.join("")}</tbody>` : "",
    "</table></div>",
  ]
    .filter(Boolean)
    .join("");

  return { html, lastIndex: index - 1 };
}

/** ```svg 围栏 → <img data:>；内容不是 SVG 时退回代码块，别把图弄丢 */
function renderSvgFigure(code) {
  const trimmed = code.trim();
  if (!/^<svg[\s>]/i.test(trimmed)) {
    return `<pre><code class="language-svg">${escapeHtml(code)}</code></pre>`;
  }
  // encodeURIComponent 会把 " < > 全部转义，因此塞进属性不可能逃逸；img 上下文也不执行脚本
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
  return `<img class="svg-figure" src="${dataUrl}" alt="模型生成的矢量图" loading="lazy" />`;
}

/** 行内样式：行内代码 → 图片 → 链接 → 粗体 → 斜体（顺序不能换） */
function inline(text) {
  // 行内代码先摘成占位符：否则 `![a](b)` 这种"写在反引号里的示例"会被后面的规则真的渲染出来
  const ticks = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code) => {
    ticks.push(code);
    return `${TICK_MARK}${ticks.length - 1}\u0000`;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) =>
      imageTag(alt, url),
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) =>
      linkTag(label, url),
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return out.replace(
    // eslint-disable-next-line no-control-regex -- 同上：NUL 前缀是内部占位约定
    /\u0000TICK(\d+)\u0000/g,
    (_match, index) => {
      const code = ticks[Number(index)] ?? "";
      return `<code>${code}</code>`;
    },
  );
}

function imageTag(alt, url) {
  const safe = safeUrl(url, { allowImageData: true });
  if (!safe) return escapeHtml(`![${alt}](${url})`);
  return `<img src="${safe}" alt="${alt}" loading="lazy" />`;
}

function linkTag(label, url) {
  const safe = safeUrl(url, { allowImageData: false });
  if (!safe) return escapeHtml(`[${label}](${url})`);
  return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * URL 白名单。
 * 只放行 http(s)、mailto、站内相对路径与锚点；`javascript:` / `vbscript:` 之类一律拒绝。
 * `data:image/` 只允许出现在图片位置——data: 链接一旦被点击就是 XSS 入口。
 */
function safeUrl(url, options) {
  const trimmed = String(url).trim();
  if (trimmed === "") return "";
  if (/^(https?:\/\/|mailto:|\/|#|\.{1,2}\/)/i.test(trimmed)) return trimmed;
  if (options.allowImageData && /^data:image\//i.test(trimmed)) return trimmed;
  return "";
}

/** 转义文本：引号也一并转掉，这样拼进属性时不可能逃逸 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
