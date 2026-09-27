/**
 * 通用执行通道：平台无关逻辑（词法、白名单、档位）+ 各平台真实执行。
 *
 * 安全相关的逻辑全部用**纯函数**覆盖，任何平台都能跑；
 * 真实执行按平台分组，跑不起来的平台自动跳过。
 */

import { describe, expect, it } from "vitest";

import { tokenizeCommand } from "../src/tools/builtins/shell/posix.js";

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
