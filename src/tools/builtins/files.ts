/** 沙箱文件工具：所有路径被限制在 workspace 根目录内，禁止越界访问。 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { ToolError } from "../../core/errors.js";
import { defineTool } from "../base.js";
import type { ToolRegistry } from "../registry.js";
import { z } from "zod";

/** 在指定 workspace 上注册读写工具（闭包绑定沙箱根目录） */
export async function registerFileTools(
  registry: ToolRegistry,
  workspace: string,
): Promise<void> {
  const root = resolve(workspace);
  await mkdir(root, { recursive: true });

  function resolveWithin(relativePath: string): string {
    const candidate = resolve(root, relativePath);
    // 防御路径穿越：解析后必须仍在根目录之下（末尾加分隔符，避免前缀同名目录）
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new ToolError(`路径越界，禁止访问沙箱外文件: ${relativePath}`);
    }
    return candidate;
  }

  registry.register(
    defineTool({
      name: "write_file",
      description: "向沙箱内写入文本文件（自动创建父目录），返回写入字节数。",
      args: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      handler: async ({ path, content }) => {
        const target = resolveWithin(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf-8");
        return { path, bytes_written: Buffer.from(content, "utf-8").length };
      },
    }),
  );

  registry.register(
    defineTool({
      name: "read_file",
      description: "读取沙箱内的文本文件，最多返回 max_chars Payload。",
      args: z.object({
        path: z.string().min(1),
        max_chars: z.number().int().positive().default(8000),
      }),
      handler: async ({ path, max_chars }) => {
        const target = resolveWithin(path);
        let text: string;
        try {
          text = await readFile(target, "utf-8");
        } catch {
          throw new ToolError(`文件不存在: ${path}`);
        }
        return {
          path,
          length: text.length,
          truncated: text.length > max_chars,
          text: text.slice(0, max_chars),
        };
      },
    }),
  );
}
