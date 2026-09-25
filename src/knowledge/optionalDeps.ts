/**
 * 可选依赖的加载报错翻译。
 *
 * 背景：知识库有三套后端，但只有词面（`lexical`）是**零额外依赖**的——
 * 语义的 `vector` / `hybrid` 还要 `@lancedb/lancedb` 与 `@huggingface/transformers`。
 * 这两个包在 `package.json` 里声明为 **`optionalDependencies`**，于是两种环境都成立：
 *
 *   轻量环境：`npm ci --omit=optional` 完全不装，或安装时下载失败（onnxruntime 的
 *             postinstall 在受限网络下会 302）——npm 容忍可选依赖失败，安装照常成功，
 *             词面检索不受任何影响；
 *   完整环境：装齐，三套后端都能用。
 *
 * 代价是运行期可能真的 import 不到。Node 原生抛的是
 * `ERR_MODULE_NOT_FOUND: Cannot find package '...'` —— 它只说"找不到"，
 * 不说"你该干什么"。这里把它换成两句可操作的解法。
 *
 * 注意：只有「包没装」才翻译，包内部初始化失败（如模型加载异常）原样抛出，
 * 否则会把真正的故障伪装成"你没装依赖"。
 */

/** Node 在解析不到模块时给出的错误码（ESM 与 CJS 各一个） */
const MODULE_NOT_FOUND_CODES = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"];

/** 是否属于「这个包没装」 */
export function isMissingModule(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && MODULE_NOT_FOUND_CODES.includes(code);
}

/**
 * 把「可选依赖没装」翻成可操作提示；其它错误原样返回。
 *
 * @param specifier 包名，如 `@lancedb/lancedb`
 * @param capability 缺了它就没法做的事，如「语义检索（vector/hybrid 后端）」
 */
export function explainMissingOptionalDependency(
  error: unknown,
  specifier: string,
  capability: string,
): Error {
  if (!isMissingModule(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new Error(
    `缺少可选依赖 ${specifier}：${capability}需要它，但当前环境没有安装。` +
      `解法一：安装它（npm install ${specifier}）；` +
      `解法二：改用零额外依赖的词面后端（MINIAGENT_KNOWLEDGE_BACKEND=lexical）。` +
      `轻量部署可以用 npm ci --omit=optional 主动跳过这两个可选包，词面检索不受影响。`,
  );
}
