/**
 * 技能包加载器。
 *
 * 技能 = 一个目录：
 *   <skills>/<skill-name>/SKILL.md          元信息（frontmatter）+ 操作指引（正文）
 *   <skills>/<skill-name>/resources/...     可选资源文件
 *
 * 渐进式披露：目录里只把 name/description/when_to_use 放进系统提示词，
 * 完整正文只在模型调用 load_skill 时才返回，避免一次性吃掉上下文。
 *
 * 注册表是**可刷新**的（refresh）：模型用 create_skill 写出技能后当场重扫，
 * 于是它能自己造技能、当轮就用（下一轮起进入系统提示词的技能目录）。
 *
 * 健壮性：单个技能包损坏（缺字段、正文为空、文件读不了）只记警告并跳过，
 * 绝不因为一个坏技能导致整个服务起不来。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "../core/logging.js";
import { parseFrontmatter } from "./frontmatter.js";

const logger = getLogger("miniagent.skills");

export interface SkillManifest {
  name: string;
  description: string;
  whenToUse: string;
  /** 技能声明的依赖工具名（仅作提示，不做强制校验） */
  tools: string[];
  /** 技能目录绝对路径 */
  dir: string;
  /** SKILL.md 正文，仅 load_skill 时交给模型 */
  body: string;
  /** resources/ 下的文件名列表 */
  resources: string[];
}

/** 技能目录中只暴露给提示词的部分 */
export interface SkillSummary {
  name: string;
  description: string;
  whenToUse: string;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillManifest>();

  private constructor(private readonly root: string) {}

  /** 扫描目录并加载全部技能；目录不存在时返回空注册表而非报错 */
  static async load(skillsDir: string): Promise<SkillRegistry> {
    const registry = new SkillRegistry(skillsDir);
    await registry.refresh();
    return registry;
  }

  /** 技能目录（即配置里的 MINIAGENT_SKILLS_DIR） */
  get dir(): string {
    return this.root;
  }

  /**
   * 重新扫描技能目录，**原地**替换全部条目。
   *
   * 为什么必须原地：系统提示词的技能目录（每次 run 调 catalog）与 load_skill 都持有
   * 同一个注册表引用。原地刷新后它们不必重新接线就能看到刚写进磁盘的技能，
   * 这是「自己创建技能 → 当即生效」的关键（见 create_skill）。
   */
  async refresh(): Promise<void> {
    const loaded = await scanSkills(this.root);
    this.skills.clear();
    for (const [name, manifest] of loaded) {
      this.skills.set(name, manifest);
    }
    logger.info(`技能加载完成: ${this.skills.size} 个`);
  }

  /** 供系统提示词使用的目录摘要 */
  catalog(): SkillSummary[] {
    return [...this.skills.values()].map(({ name, description, whenToUse }) => ({
      name,
      description,
      whenToUse,
    }));
  }

  get(name: string): SkillManifest | undefined {
    return this.skills.get(name);
  }

  names(): string[] {
    return [...this.skills.keys()];
  }

  get size(): number {
    return this.skills.size;
  }
}

/** 扫描目录下的全部技能包；单个坏包只警告并跳过，绝不因为一个坏技能拖垮整个服务 */
async function scanSkills(skillsDir: string): Promise<Map<string, SkillManifest>> {
  const found = new Map<string, SkillManifest>();

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    logger.warning(`技能目录不存在，跳过加载: ${skillsDir}`);
    return found;
  }

  for (const entry of entries) {
    const dir = join(skillsDir, entry);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      const manifest = await loadSkill(dir, entry);
      found.set(manifest.name, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(`技能包加载失败，已跳过: ${entry}（${message}）`);
    }
  }
  return found;
}

async function loadSkill(dir: string, dirName: string): Promise<SkillManifest> {
  const raw = await readFile(join(dir, "SKILL.md"), "utf-8");
  const { data, body } = parseFrontmatter(raw);

  const name = readField(data, "name") ?? dirName;
  const description = readField(data, "description");
  if (!description) {
    throw new Error("frontmatter 缺少 description");
  }
  if (!body) {
    throw new Error("SKILL.md 正文为空");
  }

  return {
    name,
    description,
    whenToUse: readField(data, "when_to_use") ?? description,
    tools: readList(data, "tools"),
    dir,
    body,
    resources: await listResources(dir),
  };
}

/** 列出 resources/ 下的文件名；目录不存在则返回空数组 */
async function listResources(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dir, "resources"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readField(
  data: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = data[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.join(", ");
  return undefined;
}

function readList(data: Record<string, string | string[]>, key: string): string[] {
  const value = data[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
