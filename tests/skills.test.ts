/** 技能模块：frontmatter 解析、目录加载（损坏包跳过）、重扫刷新、load_skill / create_skill 元工具。 */

import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFrontmatter } from "../src/skills/frontmatter.js";
import { registerSkillTools, SkillRegistry } from "../src/skills/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

/** 造一个含「1 个正常技能 + 1 个损坏技能」的目录 */
async function makeSkillsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miniagent-skills-"));

  const good = join(root, "demo");
  await mkdir(join(good, "resources"), { recursive: true });
  await writeFile(
    join(good, "SKILL.md"),
    [
      "---",
      "name: demo",
      "description: 演示技能",
      "when_to_use: 需要演示时",
      "tools: [calculator]",
      "---",
      "",
      "# 操作步骤",
      "",
      "先做 A，再做 B。",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(join(good, "resources", "tpl.md"), "模板内容", "utf-8");

  // 缺 description，应当被跳过
  const broken = join(root, "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "SKILL.md"), "---\nname: broken\n---\n\n正文\n", "utf-8");

  return root;
}

describe("parseFrontmatter", () => {
  it("解析键值、引号与内联数组", () => {
    const { data, body } = parseFrontmatter(
      '---\nname: "demo"\ntools: [a, b]\n---\n\n正文内容\n',
    );
    expect(data.name).toBe("demo");
    expect(data.tools).toEqual(["a", "b"]);
    expect(body).toBe("正文内容");
  });

  it("没有 frontmatter 时把全文当正文", () => {
    const { data, body } = parseFrontmatter("只有正文");
    expect(data).toEqual({});
    expect(body).toBe("只有正文");
  });
});

describe("SkillRegistry", () => {
  it("加载合法技能，跳过损坏技能", async () => {
    const registry = await SkillRegistry.load(await makeSkillsDir());

    expect(registry.names()).toEqual(["demo"]);
    const skill = registry.get("demo")!;
    expect(skill.description).toBe("演示技能");
    expect(skill.tools).toEqual(["calculator"]);
    expect(skill.resources).toEqual(["tpl.md"]);
    expect(skill.body).toContain("先做 A");
  });

  it("目录不存在时返回空注册表而非抛错", async () => {
    const registry = await SkillRegistry.load(join(tmpdir(), "miniagent-not-exist"));
    expect(registry.size).toBe(0);
  });

  it("catalog 只暴露摘要字段", async () => {
    const registry = await SkillRegistry.load(await makeSkillsDir());
    const [item] = registry.catalog();
    expect(item).toEqual({
      name: "demo",
      description: "演示技能",
      whenToUse: "需要演示时",
    });
  });

  it("refresh 原地重扫：运行期新增的技能立即可见，无需重启服务", async () => {
    const root = await makeSkillsDir();
    const registry = await SkillRegistry.load(root);
    expect(registry.names()).toEqual(["demo"]);

    // 模拟「模型在运行期写了一个新技能」：磁盘上多了一个包
    const added = join(root, "runtime_made");
    await mkdir(added, { recursive: true });
    await writeFile(
      join(added, "SKILL.md"),
      "---\nname: runtime_made\ndescription: 运行期新增\n---\n\n正文\n",
      "utf-8",
    );

    // 未刷新前看不到——这正是「只在启动时扫一次」的旧行为
    expect(registry.names()).toEqual(["demo"]);

    await registry.refresh();
    expect(registry.names().sort()).toEqual(["demo", "runtime_made"]);
    // 系统提示词每轮读 catalog，所以刷新后自动带上新技能
    expect(registry.catalog().map((item) => item.name)).toContain("runtime_made");
  });
});

describe("load_skill 元工具", () => {
  it("返回技能正文与资源列表", async () => {
    const skills = await SkillRegistry.load(await makeSkillsDir());
    const registry = new ToolRegistry();
    registerSkillTools(registry, skills);

    const result = await registry.get("load_skill").run({ name: "demo" });
    expect(result.ok).toBe(true);
    const data = result.data as { guidance: string; resources: string[] };
    expect(data.guidance).toContain("先做 A");
    expect(data.resources).toEqual(["tpl.md"]);
  });

  it("按名读取资源内容", async () => {
    const skills = await SkillRegistry.load(await makeSkillsDir());
    const registry = new ToolRegistry();
    registerSkillTools(registry, skills);

    const result = await registry.get("load_skill").run({
      name: "demo",
      resource: "tpl.md",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toBe("模板内容");
  });

  it("技能不存在或资源越界时返回失败结果而非抛异常", async () => {
    const skills = await SkillRegistry.load(await makeSkillsDir());
    const registry = new ToolRegistry();
    registerSkillTools(registry, skills);

    const missing = await registry.get("load_skill").run({ name: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("技能不存在");

    const escaped = await registry.get("load_skill").run({
      name: "demo",
      resource: "../SKILL.md",
    });
    expect(escaped.ok).toBe(false);
  });
});

describe("create_skill 元工具", () => {
  /** 空技能目录 + 已注册两个元工具的注册表 */
  async function setup(): Promise<{ root: string; registry: ToolRegistry; skills: SkillRegistry }> {
    const root = await mkdtemp(join(tmpdir(), "miniagent-skill-create-"));
    const skills = await SkillRegistry.load(root);
    const registry = new ToolRegistry();
    registerSkillTools(registry, skills);
    return { root, registry, skills };
  }

  const validArgs = {
    name: "daily_report",
    description: "每日盘面简报",
    when_to_use: "用户要当天行情总结时",
    body: "1. 用 powershell 取当天时间\n2. 用 web_search 查行情\n3. 按结论先行输出",
    tools: ["powershell", "web_search"],
  };

  it("写完立即生效：当轮 load_skill 能读回，落的盘能被自己的解析器读回", async () => {
    const { root, registry, skills } = await setup();

    const result = await registry.get("create_skill").run(validArgs);
    expect(result.ok).toBe(true);
    const data = result.data as { replaced: boolean; available_skills: string[] };
    expect(data.replaced).toBe(false);
    expect(data.available_skills).toEqual(["daily_report"]);

    // 同一轮内 load_skill 就能读到正文（无需等下一轮、更无需重启）
    const loaded = await registry.get("load_skill").run({ name: "daily_report" });
    expect(loaded.ok).toBe(true);
    expect((loaded.data as { guidance: string }).guidance).toContain("用 powershell 取当天时间");

    // 声明的工具、目录摘要都要能对上：说明 frontmatter 被正确解析
    const manifest = skills.get("daily_report")!;
    expect(manifest.tools).toEqual(["powershell", "web_search"]);
    expect(manifest.dir).toBe(join(root, "daily_report"));
    expect(skills.catalog().map((item) => item.name)).toEqual(["daily_report"]);
  });

  it("同名技能报告 replaced=true 并以新正文覆盖", async () => {
    const { registry } = await setup();
    await registry.get("create_skill").run(validArgs);

    const again = await registry.get("create_skill").run({
      ...validArgs,
      description: "第二版",
      body: "改成了另一种做法",
    });
    expect(again.ok).toBe(true);
    expect((again.data as { replaced: boolean }).replaced).toBe(true);

    const loaded = await registry.get("load_skill").run({ name: "daily_report" });
    expect((loaded.data as { guidance: string }).guidance).toBe("改成了另一种做法");
  });

  it("拒绝越界技能名、破坏 frontmatter 的元信息与非法工具名", async () => {
    const { root, registry, skills } = await setup();
    const run = (override: Record<string, unknown>) =>
      registry.get("create_skill").run({ ...validArgs, ...override });

    // 技能名同时是目录名，../ 与路径分隔符必须挡住
    for (const bad of ["../evil", "a/b", "a b", "", "-lead", "x".repeat(65)]) {
      const result = await run({ name: bad });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("非法技能名");
    }

    const quoted = await run({ description: '带"引号"的描述' });
    expect(quoted.ok).toBe(false);
    expect(quoted.error).toContain("英文双引号");

    const emptyBody = await run({ body: "   " });
    expect(emptyBody.ok).toBe(false);

    const badTool = await run({ tools: ["web search"] });
    expect(badTool.ok).toBe(false);
    expect(badTool.error).toContain("非法工具名");

    // 全部被拒之后磁盘上不留半成品
    expect(skills.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
});
