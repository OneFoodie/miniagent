/**
 * PowerShell 通用执行通道：档位、只读白名单、环境过滤与真实执行。
 *
 * 安全相关的逻辑（白名单与元字符校验、凭据变量过滤）用**纯函数**覆盖，所有平台都能跑；
 * 真实执行部分只在机器上确实有 PowerShell 时才跑（Linux CI 上通常只有 pwsh，没有就跳过）。
 */

import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import {
  buildChildEnv,
  checkReadonlyCommand,
  POWERSHELL_TOOL_NAME,
  registerPowershell,
  resolvePowershellExecutable,
} from "../src/tools/builtins/powershell.js";
import { ToolRegistry } from "../src/tools/registry.js";

const execFileAsync = promisify(execFile);

/** 本机是否能真的跑起 PowerShell：Windows 是 powershell，其它平台是 pwsh */
async function hasPowerShell(): Promise<boolean> {
  try {
    await execFileAsync(
      resolvePowershellExecutable(""),
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

const available = await hasPowerShell();

async function testSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  return {
    ...loadSettings(),
    workspace: await mkdtemp(join(tmpdir(), "miniagent-ps-")),
    ...overrides,
  };
}

async function makeTool(overrides: Partial<Settings> = {}) {
  const registry = new ToolRegistry();
  await registerPowershell(registry, await testSettings(overrides));
  return registry.get(POWERSHELL_TOOL_NAME);
}

describe("readonly 档：白名单与元字符校验", () => {
  it("放行白名单里的只读 cmdlet（大小写不敏感）", () => {
    expect(checkReadonlyCommand("Get-Date").ok).toBe(true);
    expect(checkReadonlyCommand("get-date").ok).toBe(true);
    expect(checkReadonlyCommand('Get-Date -Format "yyyy-MM-dd"').ok).toBe(true);
    expect(checkReadonlyCommand("Get-ChildItem -Path . -First 20").ok).toBe(true);
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
      const result = checkReadonlyCommand(command);
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
      const result = checkReadonlyCommand(command);
      expect(result.ok, command).toBe(false);
    }
  });

  it("拒绝读命令上的写参数", () => {
    expect(checkReadonlyCommand("Get-Content -Path a.txt -OutFile b.txt").ok).toBe(false);
    expect(checkReadonlyCommand("Get-ChildItem -Destination x").ok).toBe(false);
  });

  it("空命令被拒", () => {
    expect(checkReadonlyCommand("   ").ok).toBe(false);
  });
});

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
    expect(resolvePowershellExecutable("C:\\custom\\pwsh.exe")).toBe("C:\\custom\\pwsh.exe");
    expect(resolvePowershellExecutable("")).toBe(
      process.platform === "win32" ? "powershell" : "pwsh",
    );
  });

  it("readonly 档拦截危险命令时不会真的启动进程", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });

    const result = await tool.run({ command: "Remove-Item -Path C:\\important -Recurse" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("只读档拒绝执行");
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
});

describe.skipIf(!available)("真实执行", () => {
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
