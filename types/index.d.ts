export type Tab = 'models' | 'agents' | 'roles'
export type HistoryRange = 'session' | 'today' | 'week' | 'all'

export type RoleId = 'advisor' | 'explorer' | 'coder' | 'runner'
export type ModelChoice =
  | 'claude-opus-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-haiku-5-5'
  | 'claude-fable-5-2'
  | 'inherit'
export type EffortChoice = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type RoleRule = { enabled: boolean; model: ModelChoice; effort: EffortChoice }

export type Config = {
  /** สวิตช์หลัก: ปิดแล้ว Claude แตก sub-agent ไม่ได้ */
  enabled: boolean
  roles: Record<RoleId, RoleRule>
  /** จำนวน sub-agent ที่ทำงานพร้อมกันได้; 0 = ไม่จำกัด */
  maxParallel: number
  /** โหมดประหยัด: % ของ usage 5 ชม. ที่ทุก role เปลี่ยนไปใช้ Haiku; 0 = ปิด */
  saverAt: number
}

export type RunStatus = 'running' | 'done' | 'failed' | 'aborted' | 'denied' | 'unknown'

export type Run = {
  agentId: string
  role: RoleId | 'other'
  type: string
  description: string
  model: string
  background: boolean
  startedAt: number
  endedAt?: number
  status: RunStatus
  denyReason?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
  durationMs: number
}

export type LimitSnap = { kind: string; percent: number; resetsAt?: string }

export type UsageSnap = {
  at: number
  startedAt: number
  limits: LimitSnap[]
  contextPercent?: number
  contextTokens?: number
  contextWindow: number
  costUsd?: number
}

/** token ของ thread หลักแยกตาม model (รายวัน; at = เที่ยงคืนของวันนั้น) */
export type ModelDay = {
  at: number
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
}

export type AccountInfo = {
  source: 'identity' | 'file' | 'none'
  kind?: string
  name?: string
  email?: string
  org?: string
  orgType?: string
  role?: string
  billing?: string
  seat?: string
  tier?: string
  extraUsage?: boolean
  verified?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-control': {
      tab: Tab
      range: HistoryRange
      paneOpen: boolean
      config: Shaped<Config>
      runs: Shaped<Run[]>
      modelUsage: Shaped<ModelDay[]>
      sessionModels: ModelDay[]
      usage: Shaped<UsageSnap>
      account: Shaped<AccountInfo>
    }
  }
}
