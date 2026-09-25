/**
 * 向量索引的容量治理：重建与对账。
 *
 *   npm run knowledge:reindex            全量重建索引（丢掉旧表，重新嵌入所有文件）
 *   npm run knowledge:reindex -- --check 只对账，报告磁盘与索引的差异，不改动
 *
 * 为什么需要它：增量索引只靠「路径 + mtime」指纹，指纹判定一旦失效
 * （手工动过索引目录、换了嵌入模型导致维度不符、上次写入中断），
 * 索引会与磁盘悄悄漂移，而表现只是「检索召不回」——很难归因到这里。
 * 日常改文档不需要重建，增量同步就够了。
 *
 * `--check` **不会以非零码退出**：它报出的差异（待嵌入 / 多余行）是增量的正常中间态，
 * 下次检索就会自愈，把它当成 CI 失败项只会制造噪音。它的用途是人工巡检与排障。
 */

import { loadSettings } from "../src/core/config.js";
import { createVectorBackendFor, describeKnowledgeBackend } from "../src/knowledge/index.js";

function parseArgs(argv: string[]): { check: boolean } {
  return { check: argv.includes("--check") };
}

async function main(): Promise<void> {
  const { check } = parseArgs(process.argv.slice(2));
  const settings = loadSettings();

  const base = createVectorBackendFor(settings);
  if (!base) {
    console.error(
      `当前后端是「${describeKnowledgeBackend(settings)}」，没有可重建的向量索引。\n` +
        `请先把 MINIAGENT_KNOWLEDGE_BACKEND 设为 vector 或 hybrid。`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`后端: ${describeKnowledgeBackend(settings)}`);
  console.log(`目录: ${settings.knowledgeDirs.join("、")}`);
  console.log(`索引: ${settings.vectorDbPath}\n`);

  if (check) {
    const report = await base.verify();
    console.log("—— 对账 ——");
    console.log(`磁盘文件 ${report.diskFiles} 个    索引文件 ${report.indexedFiles} 个    片段 ${report.chunks} 条`);

    if (report.pending.length === 0 && report.orphans.length === 0) {
      console.log("索引与磁盘一致，无需处理。");
      return;
    }

    if (report.pending.length > 0) {
      console.log(`\n待（重新）嵌入 ${report.pending.length} 个（下次检索时会自动处理）:`);
      for (const source of report.pending.slice(0, 20)) console.log(`  + ${source}`);
      if (report.pending.length > 20) console.log(`  …共 ${report.pending.length} 个`);
    }
    if (report.orphans.length > 0) {
      console.log(`\n索引中多余 ${report.orphans.length} 个（来源文件已消失，下次检索时会自动清理）:`);
      for (const source of report.orphans.slice(0, 20)) console.log(`  - ${source}`);
      if (report.orphans.length > 20) console.log(`  …共 ${report.orphans.length} 个`);
    }

    // 只提示、不判失败：这些差异是增量的正常中间态，下次检索就会自愈
    console.log("\n结论: 存在待同步项（增量同步可自愈，不必重建）。");
    return;
  }

  console.log("开始全量重建（本地 CPU 嵌入，文件多时较慢）…");
  const started = Date.now();
  const result = await base.rebuild();
  console.log(
    `重建完成: ${result.files} 个文件 → ${result.chunks} 个片段，` +
      `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

await main();
