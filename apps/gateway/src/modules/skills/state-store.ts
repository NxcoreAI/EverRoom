import { eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentSkillStates } from "../../infrastructure/database/schema.js";

export interface AgentSkillState {
  enabled: boolean;
  /** 最近一次显式改动的时刻；没有记录（默认启用）时为空。 */
  updatedAt: Date | null;
}

const DEFAULT_STATE: AgentSkillState = { enabled: true, updatedAt: null };

/**
 * 技能启停状态的持久化（agent_skill_states）。
 *
 * 只存被用户改过的行：没有行＝启用。读写都走内存镜像——装配 runtime 时
 * 会同步问很多次「这个技能启用吗」（每次新建 runtime、每个子 Agent run），
 * 不能每次都查库。
 */
export class AgentSkillStateStore {
  private readonly states: Map<string, AgentSkillState>;

  constructor(private readonly db: GatewayDatabase) {
    this.states = new Map(
      db.select().from(agentSkillStates).all()
        .map((row) => [row.id, { enabled: row.enabled, updatedAt: row.updatedAt }]),
    );
  }

  /** 技能状态（无记录＝启用）。 */
  get(id: string): AgentSkillState {
    return this.states.get(id) ?? DEFAULT_STATE;
  }

  isEnabled(id: string): boolean {
    return this.get(id).enabled;
  }

  /** 丢掉记录＝回到默认启用（技能被删除时一并清掉，避免同名技能继承旧开关）。 */
  clear(id: string): void {
    this.db.delete(agentSkillStates).where(eq(agentSkillStates.id, id)).run();
    this.states.delete(id);
  }

  set(id: string, enabled: boolean): AgentSkillState {
    const updatedAt = new Date();
    this.db.insert(agentSkillStates)
      .values({ id, enabled, updatedAt })
      .onConflictDoUpdate({
        target: agentSkillStates.id,
        set: { enabled, updatedAt },
      })
      .run();
    const state = { enabled, updatedAt };
    this.states.set(id, state);
    return state;
  }
}
