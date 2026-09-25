/**
 * 前端 Markdown 渲染器测试。
 *
 * 渲染器是纯函数（`public/markdown.js`），因此可以在 Node 里直接验证——
 * 这类"拼 HTML 字符串"的代码最值得测的恰恰是**转义与 URL 白名单**：
 * 一旦漏了，模型输出就能在用户浏览器里执行脚本。
 */

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../public/markdown.js";

describe("表格", () => {
  it("渲染表头、数据行与对齐方式", () => {
    const html = renderMarkdown(
      [
        "| 项 | 值 | 备注 |",
        "| :-- | :-: | --: |",
        "| 模型 | deepseek | 已接入 |",
        "| 工具 | 10 | 含 MCP |",
      ].join("\n"),
    );

    expect(html).toContain("<table>");
    expect(html).toContain('<th class="ta-left">项</th>');
    expect(html).toContain('<th class="ta-center">值</th>');
    expect(html).toContain('<th class="ta-right">备注</th>');
    expect(html).toContain('<td class="ta-center">deepseek</td>');
    expect(html.match(/<tr>/g)).toHaveLength(3); // 1 表头 + 2 数据行
    // 外层负责横向滚动：窄屏下整张表仍可用
    expect(html).toContain('<div class="table-wrap">');
  });

  it("列数不齐时按表头补齐或截断，而不是让整张表崩掉", () => {
    const html = renderMarkdown(
      ["| a | b | c |", "| - | - | - |", "| 只有一列 |", "| 1 | 2 | 3 | 4 |"].join("\n"),
    );

    const rows = html.split("<tr>").slice(1);
    for (const row of rows) {
      expect((row.match(/<t[hd][ >]/g) ?? []).length).toBe(3);
    }
    expect(html).toContain("<td></td>");
  });

  it("支持用 \\| 在单元格里写字面竖线", () => {
    const html = renderMarkdown(["| 表达式 |", "| --- |", "| a \\| b |"].join("\n"));
    expect(html).toContain("<td>a | b</td>");
  });

  it("只含竖线的普通文本不会被误判成表格", () => {
    const html = renderMarkdown("这一行里有 | 一个竖线，但下一行不是分隔行");
    expect(html).not.toContain("<table>");
    expect(html).toContain("|");
  });
});

describe("行内语法", () => {
  it("图片、链接、粗体、斜体、行内代码", () => {
    const html = renderMarkdown(
      "![架构图](https://example.com/a.png) 与 [文档](https://example.com/doc) " +
        "**重点** *次要* `code`",
    );

    expect(html).toContain('<img src="https://example.com/a.png" alt="架构图"');
    expect(html).toContain(
      '<a href="https://example.com/doc" target="_blank" rel="noopener noreferrer">文档</a>',
    );
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<em>次要</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("写在反引号里的 Markdown 示例不被二次渲染", () => {
    const html = renderMarkdown("示例：`![图](https://x/y.png)`");
    expect(html).toBe("<p>示例：<code>![图](https://x/y.png)</code></p>");
  });

  it("非白名单协议不生成标签，原样显示", () => {
    const link = renderMarkdown("[点我](javascript:alert(1))");
    expect(link).not.toContain("<a ");
    expect(link).toContain("javascript:alert(1)");

    const img = renderMarkdown("![x](vbscript:msgbox)");
    expect(img).not.toContain("<img ");
  });

  it("图片位置允许 data:image，链接位置不允许", () => {
    const img = renderMarkdown("![内嵌](data:image/png;base64,AAAA)");
    expect(img).toContain('<img src="data:image/png;base64,AAAA"');

    // data: 链接点开就是 XSS 入口，必须拒绝
    const link = renderMarkdown("[点我](data:text/html,<script>alert(1)</script>)");
    expect(link).not.toContain("<a ");
  });
});

describe("转义与注入防护", () => {
  it("模型输出里的 HTML 标签被转义", () => {
    const html = renderMarkdown('<script>alert("x")</script> 与 <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("URL 里的引号无法逃出属性（否则可以注入 onerror 之类）", () => {
    const html = renderMarkdown('[x](https://example.com/"onmouseover="alert(1))');
    // 引号被转义成 &quot;，因此始终待在一个属性值里
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&quot;");
  });
});

describe("块级结构", () => {
  it("标题层级 h1–h4", () => {
    const html = renderMarkdown("# 一\n## 二\n### 三\n#### 四");
    expect(html).toContain("<h1>一</h1>");
    expect(html).toContain("<h4>四</h4>");
  });

  it("段内软换行合成一段并用 <br /> 换行", () => {
    const html = renderMarkdown("第一行\n第二行\n\n新段落");
    expect(html).toBe("<p>第一行<br />第二行</p>\n<p>新段落</p>");
  });

  it("引用、分隔线、有序与无序列表", () => {
    const html = renderMarkdown("> 引用\n\n---\n\n- 甲\n- 乙\n\n1. 一\n2. 二");
    expect(html).toContain("<blockquote>引用</blockquote>");
    expect(html).toContain("<hr />");
    expect(html).toContain("<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>");
    expect(html).toContain("<ol>\n<li>一</li>\n<li>二</li>\n</ol>");
  });
});

describe("代码块与图表", () => {
  it("保留语言标记，便于按语言配色", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain('<code class="language-ts">const a = 1;</code>');
  });

  it("代码块内的 HTML 被转义", () => {
    const html = renderMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
  });

  it("```mermaid 输出 mermaid 容器（由前端交给 mermaid 渲染）", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
    // 源码按 HTML 转义（`-->` 成了 `--&gt;`）：div 里若出现真的标签会被浏览器当元素，
    // 而 mermaid 读的是 textContent，转义后再解回来仍是原始源码
    expect(html).toBe('<div class="mermaid">graph TD; A--&gt;B;</div>');
  });

  it("```svg 输出 data: URL 图片（img 上下文不执行脚本，天然沙箱）", () => {
    const html = renderMarkdown(
      '```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" /></svg>\n```',
    );
    expect(html).toContain('<img class="svg-figure" src="data:image/svg+xml;charset=utf-8,');
    expect(html).toContain("%3Csvg");
  });

  it("```svg 里不是 SVG 时退回代码块，内容不丢", () => {
    const html = renderMarkdown("```svg\n这里忘了写标签\n```");
    expect(html).toContain('<pre><code class="language-svg">这里忘了写标签</code></pre>');
  });
});
