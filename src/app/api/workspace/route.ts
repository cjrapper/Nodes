import { json, readJson, requireWorkspace, serverError } from "@/lib/api/http";
import * as repo from "@/lib/db/repo";
import type { WorkspaceAppearance } from "@/lib/db/types";

export async function GET() {
  try {
    const ws = requireWorkspace();
    return json({ workspace: ws });
  } catch (err) {
    return serverError(err);
  }
}

interface PatchBody {
  name?: string;
  persona?: string;
  conventions?: string;
  /** 部分字段即可，缺的字段沿用当前值 */
  appearance?: Partial<WorkspaceAppearance>;
}

/**
 * 更新工作区设置。
 *
 * 注意：修改 persona / conventions 会让所有会话的缓存前缀失效一次
 * （L0 / L1 层变化）。前端在保存前应当提示用户这一点。
 */
export async function PATCH(request: Request) {
  try {
    const ws = requireWorkspace();
    const body = await readJson<PatchBody>(request);
    if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

    const updated = repo.updateWorkspace(ws.id, {
      name: body.name,
      persona: body.persona,
      conventions: body.conventions,
      // 只传了部分外观字段；由 updateWorkspace 负责与现有值合并 + 校验兜底
      appearance: body.appearance,
    });
    if (!updated) return json({ error: "工作区不存在" }, 404);

    // 告诉前端这次修改影响了哪些缓存层，便于给出诚实的提示
    const invalidatedLayers: string[] = [];
    if (body.persona !== undefined && body.persona !== ws.persona) {
      invalidatedLayers.push("L0_persona", "L1_workspace", "L2_source_index", "L2_source_content");
    } else if (body.conventions !== undefined && body.conventions !== ws.conventions) {
      invalidatedLayers.push("L1_workspace", "L2_source_index", "L2_source_content");
    }
    // appearance 刻意不进 invalidatedLayers：它只是展示层设置，
    // 不参与任何一层的哈希，改它不会让一个 token 的缓存失效。

    return json({ workspace: updated, invalidatedLayers });
  } catch (err) {
    return serverError(err);
  }
}
