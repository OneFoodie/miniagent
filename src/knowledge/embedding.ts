/**
 * 文本向量化。
 *
 * 一期用本地模型（transformers.js + ONNX Runtime）：零 API 成本、数据不出本机，
 * 代价是首次要下载模型权重、CPU 推理比调云端 API 慢。
 * 接口刻意保持最小（只有 embed），将来换云端只需另写一个实现，调用方不用动。
 *
 * **模型下载与加载是两件事**：
 *   下载 —— `npm run model:fetch` 负责，带重试与断点续跑（镜像连接不稳定，见该脚本注释）
 *   加载 —— 本文件负责，本地有模型就完全离线，没有才联网
 *
 * 国内网络注意：HuggingFace 官方 Hub 常不可达（本机实测超时），
 * 需要把 remoteHost 指向镜像（实测 https://hf-mirror.com 可用）。
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { getLogger } from "../core/logging.js";
import { explainMissingOptionalDependency } from "./optionalDeps.js";

const logger = getLogger("miniagent.knowledge.embedding");

/** 可插拔的向量化后端 */
export interface EmbeddingModel {
  /** 批量编码，返回顺序与输入一致 */
  embed(texts: string[]): Promise<number[][]>;
}

/** dtype → ONNX 权重文件名，与 transformers.js 的约定一致 */
export const ONNX_FILE_BY_DTYPE: Record<string, string> = {
  fp32: "onnx/model.onnx",
  fp16: "onnx/model_fp16.onnx",
  q8: "onnx/model_quantized.onnx",
  int8: "onnx/model_int8.onnx",
  q4: "onnx/model_q4.onnx",
  q4f16: "onnx/model_q4f16.onnx",
};

/** 默认精度：q8 量化版体积最小且精度损失可忽略，适合 CPU 推理 */
export const DEFAULT_EMBEDDING_DTYPE = "q8";

/** feature-extraction pipeline 的最小形态（只声明我们用到的那部分） */
type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<EmbeddingOutput>;

interface EmbeddingOutput {
  data: ArrayLike<number>;
  dims: number[];
}

/** transformers.js 的最小形态：绕开它庞大的类型定义，只锚定用到的入口 */
interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  env: {
    remoteHost: string;
    cacheDir: string | null;
    localModelPath: string;
    allowRemoteModels: boolean;
  };
}

export interface LocalEmbeddingOptions {
  /** HuggingFace 模型 ID */
  model: string;
  /** 模型下载源；不填用官方 Hub，国内应指向镜像 */
  remoteHost?: string;
  /** 模型缓存目录；不填用 transformers.js 的默认位置 */
  cacheDir?: string;
  /**
   * 本地模型根目录（`npm run model:fetch` 的落点）。
   * 该目录下已有本模型时完全离线加载，不再碰不稳定的网络。
   */
  localModelPath?: string;
  /** 权重精度，决定加载哪个 ONNX 文件；需与下载时选的一致 */
  dtype?: string;
}

export class LocalEmbedding implements EmbeddingModel {
  /** 加载中的 pipeline：并发调用共享同一次加载，避免重复下载模型 */
  private loading?: Promise<FeatureExtractor>;

  constructor(private readonly options: LocalEmbeddingOptions) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.load();
    const output = await extract(texts, { pooling: "mean", normalize: true });
    return toVectors(output);
  }

  /** 惰性加载：首次调用才下载并初始化模型（可能耗时较久，所以给日志） */
  private load(): Promise<FeatureExtractor> {
    if (!this.loading) {
      this.loading = this.create().catch((error: unknown) => {
        // 失败后清空，让下一次调用可以重试（比如改完镜像配置重启进程）
        this.loading = undefined;
        throw error;
      });
    }
    return this.loading;
  }

  private async create(): Promise<FeatureExtractor> {
    let transformers: TransformersModule;
    try {
      transformers = (await import("@huggingface/transformers")) as unknown as TransformersModule;
    } catch (error) {
      // 语义后端是可选能力：依赖没装时要给出「装依赖」或「换回词面后端」两条出路，
      // 而不是把 Node 的模块解析错误直接甩给用户
      throw explainMissingOptionalDependency(
        error,
        "@huggingface/transformers",
        "语义检索（vector / hybrid 后端）",
      );
    }
    const { env } = transformers;

    if (this.options.remoteHost) env.remoteHost = this.options.remoteHost;
    if (this.options.cacheDir) env.cacheDir = this.options.cacheDir;

    const localDir = await this.locateLocalModel();
    if (localDir) {
      // 本地权重齐全 → 完全离线。镜像连接不稳定，能不走网络就不走。
      env.localModelPath = resolve(this.options.localModelPath!);
      env.allowRemoteModels = false;
      logger.info(`使用本地嵌入模型: ${localDir}`);
    } else {
      logger.info(
        `本地无 ${this.options.model} 的完整权重，将联网下载（源 ${env.remoteHost}）。` +
          `若反复失败，请先执行 npm run model:fetch`,
      );
    }

    try {
      const extractor = await transformers.pipeline(
        "feature-extraction",
        this.options.model,
        { dtype: this.options.dtype ?? DEFAULT_EMBEDDING_DTYPE },
      );
      logger.info(`嵌入模型就绪: ${this.options.model}`);
      return extractor as FeatureExtractor;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `加载嵌入模型失败（${this.options.model}）: ${reason}。` +
          `建议先执行 npm run model:fetch 把权重下到本地再试；` +
          `若需联网，请确认 MINIAGENT_EMBEDDING_REMOTE_HOST 指向可达镜像（如 https://hf-mirror.com）`,
      );
    }
  }

  /**
   * 本地是否已有该模型的完整权重（配置 + 对应精度的 ONNX）。
   * 两个都要查：只下到一半时若误判为「有」，离线加载会失败且原因难懂。
   */
  private async locateLocalModel(): Promise<string | undefined> {
    const root = this.options.localModelPath;
    if (!root) return undefined;

    const onnx = ONNX_FILE_BY_DTYPE[this.options.dtype ?? DEFAULT_EMBEDDING_DTYPE];
    if (!onnx) return undefined;

    const dir = resolve(root, this.options.model);
    for (const file of ["config.json", onnx]) {
      const found = await stat(resolve(dir, file)).catch(() => undefined);
      if (!found?.isFile() || found.size === 0) return undefined;
    }
    return dir;
  }
}

/** 把 [n, dim] 的扁平张量切成 n 个向量 */
function toVectors(output: EmbeddingOutput): number[][] {
  const rows = output.dims[0] ?? 0;
  const dims = output.dims[1] ?? 0;
  if (rows === 0 || dims === 0) {
    throw new Error(`嵌入输出维度异常: [${output.dims.join(", ")}]`);
  }

  const flat = Array.from(output.data);
  const vectors: number[][] = [];
  for (let i = 0; i < rows; i++) {
    vectors.push(flat.slice(i * dims, (i + 1) * dims));
  }
  return vectors;
}
