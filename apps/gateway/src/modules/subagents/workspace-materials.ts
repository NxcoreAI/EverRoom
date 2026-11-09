import type { MaterialHit } from "./slides-material-prefetch.js";
import type { WorkspaceFileCatalog } from "../agent/workspace-files-tools.js";

/**
 * 把「工作区里用户自己的图片」接成 slides 编排的本地素材检索入口。
 *
 * 素材检索子系统退役后 `slides_draft` 的 arrange 预取入口（options.searchMaterials）
 * 一直没接线：planner 因此只会写 imagePrompt 走 AI 生图，用户上传的产品图/现场图
 * 永远进不了 deck。这里按文件名做确定性包含匹配，命中以 everroom-material://<hash>
 * 下发；该引用由 SlideImageStore.readByHash 从 file_blobs 回源，上传图同样可读。
 *
 * 目录用 getter 注入：filesService 晚于工具装配创建（晚绑定）。
 */
export function createWorkspaceImageMaterialSearch(
  getCatalog: () => WorkspaceFileCatalog | null,
): (query: string, limit?: number) => MaterialHit[] {
  return (query, limit = 3) => {
    const catalog = getCatalog();
    const keyword = query.trim();
    if (!catalog || !keyword) return [];
    const max = Math.max(1, Math.min(6, Math.trunc(limit)));
    const seen = new Set<string>();
    const hits: MaterialHit[] = [];
    // 多取一些候选：同一图片可能有多条登记（同名覆盖/重复导入），去重后仍够数。
    for (const entry of catalog.list({ kind: "image", query: keyword, limit: max * 3 })) {
      const ref = entry.materialRef;
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      hits.push({
        ref,
        kind: "photo",
        // 相对路径（如「八、补充材料/产品图/xxx.jpg」）比裸文件名更能说明素材来源。
        desc: (entry.relativePath ?? entry.name).slice(0, 120),
        meta: `${String(Math.max(1, Math.round(entry.bytes / 1024)))}KB`.slice(0, 48),
        rank: hits.length,
      });
      if (hits.length >= max) break;
    }
    return hits;
  };
}
