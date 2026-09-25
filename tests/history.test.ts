/** 会话历史持久化：追加写、读取、列表、旧格式迁移、删除与安全校验。 */

import { appendFile, mkdtemp, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore, type SessionTurn } from "../src/history/store.js";

async function makeStore(): Promise<{ store: SessionStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-history-"));
  return { store: new SessionStore(dir), dir };
}

function turn(role: "user" | "assistant", content: string, runId?: string): SessionTurn {
  return { role, content, runId, ts: Date.now() / 1000 };
}

describe("SessionStore", () => {
  it("追加后可按 id 读回，标题取首个提问", async () => {
    const { store } = await makeStore();
    await store.append("s1", [
      turn("user", "帮我调研一下向量数据库"),
      turn("assistant", "好的，结论如下。", "run-1"),
    ]);

    const session = await store.get("s1");
    expect(session?.title).toBe("帮我调研一下向量数据库");
    expect(session?.turns).toBe(1);
    expect(session?.messages).toHaveLength(2);
    // runId 保留下来，前端可据此回看轨迹
    expect(session?.messages[1]!.runId).toBe("run-1");
  });

  it("工具事实随轮次落盘并读回（下一轮据此核查「做过什么」）", async () => {
    const { store } = await makeStore();
    await store.append("s1", [
      turn("user", "调用一下回声工具"),
      {
        role: "assistant",
        content: "已调用。",
        runId: "run-1",
        tools: [
          { name: "mcp__echo__echo", ok: true },
          { name: "no_such_tool", ok: false },
        ],
        ts: Date.now() / 1000,
      },
    ]);

    const session = await store.get("s1");
    expect(session?.messages[1]!.tools).toEqual([
      { name: "mcp__echo__echo", ok: true },
      { name: "no_such_tool", ok: false },
    ]);
  });

  it("导入时清洗工具事实：非法项丢弃、ok 归一到布尔、超量截断", async () => {
    const { store } = await makeStore();
    await store.import({
      id: "s_dirty_tools",
      messages: [
        {
          role: "assistant",
          content: "来自别处",
          tools: [
            { name: "calculator", ok: true },
            { name: "", ok: true },
            "这不是对象",
            { ok: true },
            { name: "weird", ok: "yes" },
            ...Array.from({ length: 60 }, (_, index) => ({ name: `t${index}`, ok: true })),
          ],
        },
      ],
    });

    const tools = (await store.get("s_dirty_tools"))?.messages[0]?.tools ?? [];
    // 名字缺失/非对象被丢掉；ok 非布尔按 false 处理；总数有上限
    expect(tools[0]).toEqual({ name: "calculator", ok: true });
    expect(tools[1]).toEqual({ name: "weird", ok: false });
    expect(tools).toHaveLength(50);
  });

  it("多次追加是累加而非覆盖，且保留创建时间与标题", async () => {
    const { store } = await makeStore();
    const first = await store.append("s1", [
      turn("user", "第一问"),
      turn("assistant", "第一答"),
    ]);
    const second = await store.append("s1", [
      turn("assistant", "补充说明"),
      turn("user", "第二问"),
    ]);

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.title).toBe("第一问");
    expect(second.turns).toBe(2);

    const session = await store.get("s1");
    expect(session?.messages.map((item) => item.content)).toEqual([
      "第一问",
      "第一答",
      "补充说明",
      "第二问",
    ]);
  });

  it("列表返回全部会话，按最近更新倒序", async () => {
    const { store } = await makeStore();
    await store.append("s1", [turn("user", "问题一")]);
    // 拉开一点时间：同一毫秒内写入时 updatedAt 相等，排序会退化成任意顺序
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.append("s2", [turn("user", "问题二")]);

    const list = await store.list();
    expect(list.map((item) => item.id).sort()).toEqual(["s1", "s2"]);
    expect(list[0]!.id).toBe("s2");
  });

  it("列表只依赖元信息文件：正文缺失时仍能列出", async () => {
    const { store, dir } = await makeStore();
    await store.append("s1", [turn("user", "问题一")]);

    // 删掉正文，模拟"打开历史面板不需要读会话长度级的数据"
    await unlink(join(dir, "s1.jsonl"));

    const list = await store.list();
    expect(list.map((item) => item.id)).toEqual(["s1"]);
    expect(list[0]!.title).toBe("问题一");
  });

  it("旧格式 .json 会话：读取兼容，写入时迁移为 jsonl", async () => {
    const { store, dir } = await makeStore();
    const legacy = {
      id: "old",
      title: "旧会话",
      createdAt: 100,
      updatedAt: 200,
      turns: 1,
      messages: [turn("user", "旧问题"), turn("assistant", "旧回答", "run-old")],
    };
    await writeFile(join(dir, "old.json"), JSON.stringify(legacy), "utf-8");

    // 迁移前也必须读得到，否则升级会让历史凭空消失
    expect((await store.get("old"))?.messages).toHaveLength(2);
    expect((await store.list()).map((item) => item.id)).toEqual(["old"]);

    await store.append("old", [turn("user", "新问题"), turn("assistant", "新回答")]);

    const session = await store.get("old");
    expect(session?.messages.map((item) => item.content)).toEqual([
      "旧问题",
      "旧回答",
      "新问题",
      "新回答",
    ]);
    expect(session?.turns).toBe(2);
    // 迁移后旧文件被移除，避免两份数据长期并存
    expect((await readdir(dir)).sort()).toEqual(["old.jsonl", "old.meta.json"]);
  });

  it("jsonl 中的损坏行被跳过，不影响其余轮次", async () => {
    const { store, dir } = await makeStore();
    await store.append("s1", [turn("user", "好行")]);
    await appendFile(join(dir, "s1.jsonl"), "{这不是合法 JSON}\n", "utf-8");
    await store.append("s1", [turn("assistant", "另一好行")]);

    const session = await store.get("s1");
    expect(session?.messages.map((item) => item.content)).toEqual(["好行", "另一好行"]);
  });

  it("删除后读不到", async () => {
    const { store } = await makeStore();
    await store.append("s1", [turn("user", "问题")]);

    expect(await store.remove("s1")).toBe(true);
    expect(await store.get("s1")).toBeUndefined();
    expect(await store.remove("s1")).toBe(false);
  });

  it("拒绝路径穿越的会话 id", async () => {
    const { store } = await makeStore();
    await expect(store.append("../evil", [turn("user", "x")])).rejects.toThrow();
    expect(await store.get("../../etc/passwd")).toBeUndefined();
  });

  it("没有历史时列表为空数组", async () => {
    const { store } = await makeStore();
    expect(await store.list()).toEqual([]);
  });
});
