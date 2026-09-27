/**
 * 通用执行通道：档位、只读白名单、环境过滤与各平台真实执行。
 *
 * 安全相关的逻辑全部用**纯函数**覆盖，任何平台都能跑；
 * 真实执行按平台分组（Windows 走 PowerShell，其它平台走 POSIX），跑不起来的自动跳过。
 */

import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import { buildChildEnv } from "../src/tools/builtins/shell/exec.js";
import {
  POWERSHELL_TOOL_NAME,
  registerPowershell,
} from "../src/tools/builtins/shell/index.js";
import {
  checkReadonlyCommand as checkPosixCommand,
  posixAdapter,
  tokenizeCommand,
} from "../src/tools/builtins/shell/posix.js";
import {
  checkReadonlyCommand as checkPwshCommand,
  powershellAdapter,
} from "../src/tools/builtins/shell/powershell.js";
import { ToolRegistry } from "../src/tools/registry.js";

const execFileAsync = promisify(execFile);

/** 本机是否能真的跑起 PowerShell：Windows 是 powershell，其它平台是 pwsh */
async function hasPowerShell(): Promise<boolean> {
  try {
    await execFileAsync(
      powershellAdapter.executable(""),
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

// 非 Windows 上根本不探测：既没意义，又会让 pwsh 的 spawn 白等一次超时
const pwshAvailable = process.platform === "win32" ? await hasPowerShell() : false;

async function testSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  return {
    ...loadSettings(),
    workspace: await mkdtemp(join(tmpdir(), "miniagent-shell-")),
    ...overrides,
  };
}

async function makeTool(overrides: Partial<Settings> = {}) {
  const registry = new ToolRegistry();
  await registerPowershell(registry, await testSettings(overrides));
  return registry.get(POWERSHELL_TOOL_NAME);
}

/* ---------------- 平台无关：词法器 ---------------- */

describe("POSIX 词法器", () => {
  it("按空白拆分并保留引号内的空格", () => {
    expect(tokenizeCommand("ls -la /tmp")).toEqual({ ok: true, argv: ["ls", "-la", "/tmp"] });
    expect(tokenizeCommand('grep "a b" f')).toEqual({ ok: true, argv: ["grep", "a b", "f"] });
    expect(tokenizeCommand("grep 'a b' f")).toEqual({ ok: true, argv: ["grep", "a b", "f"] });
  });

  it("通配符与变量原样保留（readonly 不经 shell，不会被展开）", () => {
    expect(tokenizeCommand("ls *.txt")).toEqual({ ok: true, argv: ["ls", "*.txt"] });
    expect(tokenizeCommand("ls $HOME x")).toEqual({ ok: true, argv: ["ls", "$HOME", "x"] });
    expect(tokenizeCommand("ls a|b")).toEqual({ ok: true, argv: ["ls", "a|b"] });
  });

  it("反斜杠转义：引号外转义下一个字符，单引号内原样", () => {
    expect(tokenizeCommand("grep a\\ b f")).toEqual({ ok: true, argv: ["grep", "a b", "f"] });
    expect(tokenizeCommand("grep 'a\\b' f")).toEqual({ ok: true, argv: ["grep", "a\\b", "f"] });
    // 双引号内只认 \" 与 \\，其余反斜杠原样保留
    expect(tokenizeCommand('grep "a\\tb" f')).toEqual({ ok: true, argv: ["grep", "a\\tb", "f"] });
    expect(tokenizeCommand('grep "a\\"b" f')).toEqual({ ok: true, argv: ["grep", 'a"b', "f"] });
  });

  it("连续空白不产生空参数，但显式空引号算一个空参数", () => {
    expect(tokenizeCommand("ls    -la")).toEqual({ ok: true, argv: ["ls", "-la"] });
    expect(tokenizeCommand("ls '' x")).toEqual({ ok: true, argv: ["ls", "", "x"] });
  });

  it("空命令与未闭合引号被拒", () => {
    expect(tokenizeCommand("   ").ok).toBe(false);
    expect(tokenizeCommand("").ok).toBe(false);
    expect(tokenizeCommand('grep "abc').ok).toBe(false);
    expect(tokenizeCommand("grep 'abc").ok).toBe(false);
  });

  it("拒绝换行，避免跨行命令", () => {
    expect(tokenizeCommand("ls\ncat f").ok).toBe(false);
    expect(tokenizeCommand("grep 'a\nb' f").ok).toBe(false);
  });
});

/* ---------------- 平台无关：子进程环境过滤 ---------------- */

describe("子进程环境过滤", () => {
  it("剔除凭据类变量，保留普通变量", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      PSModulePath: "/modules",
      MINIAGENT_API_KEY: "sk-secret",
      MINIAGENT_DEEPSEEK_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_TOKEN: "ghp_x",
      DB_PASSWORD: "hunter2",
      MY_CREDENTIALS: "x",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.PSModulePath).toBe("/modules");
    for (const key of [
      "MINIAGENT_API_KEY",
      "MINIAGENT_DEEPSEEK_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "MY_CREDENTIALS",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
  });
});

/* ---------------- 平台无关：档位与注册 ---------------- */

describe("档位与注册", () => {
  it("off 档不注册工具", async () => {
    const registry = new ToolRegistry();
    await registerPowershell(registry, await testSettings({ powershellMode: "off" }));
    expect(registry.has(POWERSHELL_TOOL_NAME)).toBe(false);
  });

  it("默认档位是 readonly（保守档），且工具超时留了余量", async () => {
    process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
    expect(loadSettings().powershellMode).toBe("readonly");

    const tool = await makeTool({ powershellTimeout: 7 });
    expect(tool.timeoutSeconds).toBeGreaterThan(7);
  });

  it("档位写错时启动即报错，避免以为关了其实开着", () => {
    const original = process.env.MINIAGENT_POWERSHELL_MODE;
    process.env.MINIAGENT_POWERSHELL_MODE = "read-only";
    try {
      expect(() => loadSettings()).toThrow(/MINIAGENT_POWERSHELL_MODE/);
    } finally {
      // 注意：给 process.env 赋 undefined 会变成字符串 "undefined"，必须显式删除
      if (original === undefined) delete process.env.MINIAGENT_POWERSHELL_MODE;
      else process.env.MINIAGENT_POWERSHELL_MODE = original;
    }
  });

  it("可执行文件可配置；留空时按平台给默认值", () => {
    expect(powershellAdapter.executable("C:\\custom\\pwsh.exe")).toBe("C:\\custom\\pwsh.exe");
    expect(powershellAdapter.executable("")).toBe(
      process.platform === "win32" ? "powershell" : "pwsh",
    );
  });

  it("单次超时上限按档位给：full 档为脚本留出空间，readonly 档不给", async () => {
    const readonlyTool = await makeTool({ powershellMode: "readonly", powershellTimeout: 7 });
    const fullTool = await makeTool({ powershellMode: "full", powershellTimeout: 7 });

    // readonly：只比配置值多一点余量，长任务不该走这条路
    expect(readonlyTool.timeoutSeconds).toBeGreaterThan(7);
    expect(readonlyTool.timeoutSeconds).toBeLessThan(60);
    // full：跑脚本/构建要有空间，上限抬到 300s 以上
    expect(fullTool.timeoutSeconds).toBeGreaterThanOrEqual(300);

    // 配置值本身比上限还大时不能被压回去
    const bigTool = await makeTool({ powershellMode: "full", powershellTimeout: 600 });
    expect(bigTool.timeoutSeconds).toBeGreaterThan(600);
  });

  it("readonly 档拦截危险命令时不会真的启动进程", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });

    const result = await tool.run({ command: "Remove-Item -Path C:\\important -Recurse" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("只读档拒绝执行");
  });
});

/* ---------------- Windows：PowerShell 专属 ---------------- */

describe.skipIf(process.platform !== "win32")("PowerShell readonly 档：白名单与元字符校验", () => {
  it("放行白名单里的只读 cmdlet（大小写不敏感）", () => {
    expect(checkPwshCommand("Get-Date").ok).toBe(true);
    expect(checkPwshCommand("get-date").ok).toBe(true);
    expect(checkPwshCommand('Get-Date -Format "yyyy-MM-dd"').ok).toBe(true);
    expect(checkPwshCommand("Get-ChildItem -Path . -First 20").ok).toBe(true);
  });

  it("拒绝不在白名单里的 cmdlet", () => {
    for (const command of [
      "Remove-Item -Path x",
      "Set-Content -Path x -Value y",
      "New-Item -Path x",
      "Start-Process calc",
      "Invoke-WebRequest https://example.com",
      "cmd /c dir",
      "C:\\Windows\\System32\\calc.exe",
    ]) {
      const result = checkPwshCommand(command);
      expect(result.ok, command).toBe(false);
      expect(result.reason, command).toBeTruthy();
    }
  });

  it("拒绝一切能把单条命令变成一段程序的元字符", () => {
    // 每一条都是「白名单命令开头 + 一个元字符」，正是这类校验最容易被绕过的形态
    for (const command of [
      "Get-Date; Remove-Item -Path x",
      "Get-Date | Remove-Item",
      "Get-Date && Remove-Item -Path x",
      "Get-Date > out.txt",
      "Get-Date < in.txt",
      "Get-Content `$env:TEMP",
      "Get-Date $(Remove-Item x)",
      "Get-Content (Get-Item x)",
      "Get-Date @{a=1}",
      "Get-Date [System.IO.File]",
      "Get-Date # 注释后面藏东西",
      "Get-Date %{Remove-Item x}",
      "Get-Date\nRemove-Item x",
    ]) {
      const result = checkPwshCommand(command);
      expect(result.ok, command).toBe(false);
    }
  });

  it("拒绝读命令上的写参数", () => {
    expect(checkPwshCommand("Get-Content -Path a.txt -OutFile b.txt").ok).toBe(false);
    expect(checkPwshCommand("Get-ChildItem -Destination x").ok).toBe(false);
  });

  it("空命令被拒", () => {
    expect(checkPwshCommand("   ").ok).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32" || !pwshAvailable)("PowerShell 真实执行", () => {
  it("readonly 档能取到当前时间（这就是加这个工具的直接动机）", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });

    const result = await tool.run({ command: "Get-Date" });

    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string; exit_code: number };
    expect(data.exit_code).toBe(0);
    expect(data.stdout).toMatch(/\d{4}/);
  });

  it("full 档不限制命令，stdout 原样回传", async () => {
    const tool = await makeTool({ powershellMode: "full" });

    const result = await tool.run({ command: "Write-Output hello-ps" });

    expect(result.ok).toBe(true);
    expect((result.data as { stdout: string }).stdout).toContain("hello-ps");
  });

  it("非零退出码转成失败，并把错误输出交给模型", async () => {
    const tool = await makeTool({ powershellMode: "full" });

    const result = await tool.run({ command: "exit 3" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码 3");
  });

  it("命令超时会被真正终止，并给出可操作的建议", async () => {
    const tool = await makeTool({ powershellMode: "full", powershellTimeout: 1 });

    const result = await tool.run({ command: "Start-Sleep -Seconds 30" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("超过 1s");
  });

  it("timeout_seconds 能覆盖默认值：慢脚本不必改全局配置就能跑完", async () => {
    // 默认超时给得很大，只有「显式传入的 1s」生效时才会失败——这正是要验证的点
    const tool = await makeTool({ powershellMode: "full", powershellTimeout: 60 });

    const result = await tool.run({
      command: "Start-Sleep -Seconds 5",
      timeout_seconds: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("超过 1s");
  });
});

/* ---------------- POSIX：只读白名单 ---------------- */

describe("POSIX readonly 白名单", () => {
  it("放行只读命令", () => {
    for (const command of ["date", "date -u", "ls -la", "whoami", "grep -n TODO f"]) {
      expect(checkPosixCommand(command).ok, command).toBe(true);
    }
  });

  it("拒绝不在白名单的命令（含带路径的同名命令）", () => {
    for (const command of [
      "find . -type f",
      "git status",
      "sed -n 1p f",
      "awk '{print}' f",
      "xargs rm",
      "tee out.txt",
      "env",
      "/bin/ls -la",
      "rm -rf /tmp/x",
    ]) {
      const result = checkPosixCommand(command);
      expect(result.ok, command).toBe(false);
      if (result.ok) continue;
      expect(result.reason, command).toBeTruthy();
    }
  });

  it("拒绝会写盘的选项", () => {
    expect(checkPosixCommand("sort -o /tmp/x f").ok).toBe(false);
    expect(checkPosixCommand("sort --output=/tmp/x f").ok).toBe(false);
    expect(checkPosixCommand("date -s '2020-01-01'").ok).toBe(false);
  });

  it("放行的命令把 argv 一并交出，调用方不必再拆一次", () => {
    const result = checkPosixCommand('grep -n "a b" f');
    expect(result.ok).toBe(true);
    expect(result.ok && result.argv).toEqual(["grep", "-n", "a b", "f"]);
  });

  it("管道是「argv 里不存在这种机制」，而不是被黑名单拦的", () => {
    // `ls | cat` 会拆成 argv ["ls","|","cat"]：白名单只认命令名所以放行到 ls，
    // 真正拦住它的是「ls 不认识 | 与 cat 这两个参数」。这条用例固化的正是
    // 「没有 shell 参与」这个前提——若哪天改回 bash -c，这里会立刻变成危险的放行。
    const result = checkPosixCommand("ls | cat");
    expect(result.ok).toBe(true);
    expect(result.ok && result.argv).toEqual(["ls", "|", "cat"]);
  });

  it("可执行文件可配置；留空时用 bash", () => {
    expect(posixAdapter.executable("/usr/bin/bash")).toBe("/usr/bin/bash");
    expect(posixAdapter.executable("")).toBe("bash");
  });
});

/* ---------------- POSIX：真实执行 ---------------- */

describe.skipIf(process.platform === "win32")("POSIX 真实执行", () => {
  it("readonly 档能取到时间与用户名（不走 shell）", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });

    const date = await tool.run({ command: "date" });
    expect(date.ok).toBe(true);
    expect((date.data as { stdout: string }).stdout).toMatch(/\d{4}/);

    const who = await tool.run({ command: "whoami" });
    expect(who.ok).toBe(true);
  });

  it("readonly 档不展开通配符：*.txt 会字面传给命令", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });

    // 工作目录里没有字面名为 *.txt 的文件，所以失败；关键是原因来自「找不到这个名字」
    const result = await tool.run({ command: "ls *.txt" });
    expect(result.ok).toBe(false);
  });

  it("full 档真的经过 shell：管道可用", async () => {
    const tool = await makeTool({ powershellMode: "full" });

    const result = await tool.run({ command: "echo hello | tr a-z A-Z" });
    expect(result.ok).toBe(true);
    expect((result.data as { stdout: string }).stdout).toBe("HELLO");
  });

  it("非零退出码转成失败", async () => {
    const tool = await makeTool({ powershellMode: "full" });

    const result = await tool.run({ command: "exit 3" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码 3");
  });

  it("命令超时会被真正终止", async () => {
    const tool = await makeTool({ powershellMode: "full", powershellTimeout: 1 });

    const result = await tool.run({ command: "sleep 30" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("超过 1s");
  });
});
