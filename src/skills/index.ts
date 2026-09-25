/** 技能模块对外入口：加载注册表 + 注册 load_skill / create_skill 两个元工具。 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { z } from "zod";

import { ToolError } from "../core/errors.js";
import { defineTool } from "../tools/base.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillManifest, SkillRegistry } from "./loader.js";

export { SkillRegistry } from "./loader.js";
export type { SkillManifest, SkillSummary } from "./loader.js";

/** 单个资源文件返回内容的上限，避免把超大文件塞进上下文 */
const MAX_RESOURCE_CHARS = 20000;

/**
 * 技能名同时是目录名：只允许字母数字开头、不含路径分隔符。
 * 这是防目录穿越的唯一防线（write_file 的沙箱管不到技能目录）。
 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 工具名只作提示，但仍要保证写出的 frontmatter 能被自己的解析器读回去 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** 正文上限：技能正文要进上下文，太长就失去了「渐进式披露」的意义 */
const MAX_SKILL_BODY_CHARS = 20000;

/**
 * 注册技能元工具。
 *
 * load_skill 是"渐进式披露"的入口：系统提示词里只有技能目录，
 * 模型判断需要时再调它取回完整正文 / 资源，从而把上下文留给真正有用的信息。
 *
 * create_skill 是反向的写入口：模型把刚跑通、以后还要复用的做法固化成技能。
 * 写完立即重扫注册表，所以当轮 load_skill 就能读到，下一轮起进系统提示词。
 */
export function registerSkillTools(
  registry: ToolRegistry,
  skills: SkillRegistry,
): void {
  registry.register(
    defineTool({
      name: "load_skill",
      description:
        "读取某个技能的完整操作指引（正文）。也可传入 resource 读取该技能附带的资源文件内容。",
      args: z.object({
        name: z.string().describe("技能名，取自系统提示词「可用技能」列表"),
        resource: z
          .string()
          .optional()
          .describe("可选：技能 resources/ 目录下的文件名，用于读取资源内容"),
      }),
      handler: async ({ name, resource }) => {
        const skill = skills.get(name);
        if (!skill) {
          throw new Error(
            `技能不存在: ${name}；可用技能: ${skills.names().join("、") || "（无）"}`,
          );
        }

        if (resource) {
          const content = await readResource(skill, resource);
          return {
            skill: skill.name,
            resource,
            content:
              content.length > MAX_RESOURCE_CHARS
                ? `${content.slice(0, MAX_RESOURCE_CHARS)}\n…（资源过长已截断）`
                : content,
          };
        }

        return {
          skill: skill.name,
          guidance: skill.body,
          resources: skill.resources,
          declared_tools: skill.tools,
          hint: skill.resources.length
            ? "如需资源内容，再次调用 load_skill 并传入 resource 参数（技能资源不在文件沙箱内，read_file 读不到）"
            : undefined,
        };
      },
    }),
  );

  registry.register(
    defineTool({
      name: "create_skill",
      description:
        "把一套可复用的做法固化成技能：写入 <技能目录>/<name>/SKILL.md，" +
        "并立即重扫技能注册表使其生效——本轮即可用 load_skill 读回，下一轮起进入系统提示词的「可用技能」。\n" +
        "适用：用户要求「记下来 / 以后照这个来」，或你自己刚跑通一套多步流程、以后还会重复做。\n" +
        "只写正文指引（步骤 + 用哪些工具 + 注意事项），不要写代码；技能目录不做沙箱，写错了会污染后续所有会话。\n" +
        "注意：同名技能会被覆盖，覆盖前先确认它不是你手写的既有技能。",
      args: z.object({
        name: z
          .string()
          .describe("技能名，同时是目录名：字母或数字开头，可含 . _ -，不超过 64 字符"),
        description: z.string().describe("一句话说明这个技能是什么（会进系统提示词）"),
        when_to_use: z.string().describe("什么条件下该用它（会进系统提示词）"),
        body: z.string().describe("SKILL.md 正文：具体操作指引，写清步骤与注意事项"),
        tools: z
          .array(z.string())
          .optional()
          .describe("建议配合使用的工具名（仅作提示，不做强制校验）"),
      }),
      handler: async ({ name, description, when_to_use, body, tools }) => {
        const skillName = name.trim();
        if (!SKILL_NAME_PATTERN.test(skillName)) {
          throw new ToolError(
            `非法技能名 '${name}'：只能以字母或数字开头，由字母、数字与 . _ - 组成，且不超过 64 字符`,
          );
        }
        const guidance = body.trim();
        if (!guidance) throw new ToolError("body（操作指引正文）不能为空");
        if (guidance.length > MAX_SKILL_BODY_CHARS) {
          throw new ToolError(`body 有 ${guidance.length} 字符，超过上限 ${MAX_SKILL_BODY_CHARS}，请精简`);
        }

        const declared = (tools ?? []).map((item) => item.trim()).filter(Boolean);
        for (const item of declared) {
          if (!TOOL_NAME_PATTERN.test(item)) {
            throw new ToolError(`非法工具名 '${item}'：只允许字母、数字与 . _ -`);
          }
        }

        const dir = join(skills.dir, skillName);
        const replaced = await fileExists(join(dir, "SKILL.md"));
        const content = renderSkillFile(
          {
            name: skillName,
            description: normalizeMeta("description", description),
            whenToUse: normalizeMeta("when_to_use", when_to_use),
            tools: declared,
          },
          guidance,
        );
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), content, "utf-8");

        // 立即重扫：不重扫的话这次写入要等到服务重启才存在
        await skills.refresh();

        return {
          skill: skillName,
          dir,
          replaced,
          bytes_written: Buffer.from(content, "utf-8").length,
          available_skills: skills.names(),
          hint:
            "已生效：本轮可直接按上面写入的正文执行，也可用 load_skill 读回核对；" +
            "下一轮起它会出现在系统提示词的「可用技能」里。",
        };
      },
    }),
  );
}

/** 元信息字段：折成单行、拒绝英文双引号，否则写出的 frontmatter 读不回原值 */
function normalizeMeta(field: string, value: string): string {
  const single = value.replace(/\s*\n\s*/g, " ").trim();
  if (!single) throw new ToolError(`${field} 不能为空`);
  if (single.includes('"')) {
    throw new ToolError(`${field} 里不能有英文双引号（会破坏 frontmatter），请改用中文引号`);
  }
  return single;
}

/** 按本项目的 frontmatter 子集渲染 SKILL.md；值统一加引号，避免被解析成数组（如以 [ 开头） */
function renderSkillFile(
  meta: { name: string; description: string; whenToUse: string; tools: string[] },
  body: string,
): string {
  const lines = [
    "---",
    `name: "${meta.name}"`,
    `description: "${meta.description}"`,
    `when_to_use: "${meta.whenToUse}"`,
  ];
  if (meta.tools.length > 0) lines.push(`tools: [${meta.tools.join(", ")}]`);
  lines.push("---", "", body, "");
  return lines.join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 读取资源文件；路径必须落在该技能的 resources/ 内，防目录穿越 */
async function readResource(skill: SkillManifest, resource: string): Promise<string> {
  const root = join(skill.dir, "resources");
  const target = normalize(join(root, resource));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("非法的资源路径");
  }
  return readFile(target, "utf-8");
}
