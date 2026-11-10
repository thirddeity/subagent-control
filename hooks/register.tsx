import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type {
  AccountInfo,
  Config,
  EffortChoice,
  HistoryRange,
  ModelChoice,
  RoleId,
  RoleRule,
  Run,
  Tab,
  UsageSnap,
} from '../types'

const PANE = 'subagent-control'
const TITLE = 'Sub-agents'
const AGENT_PREFIX = 'subagent-control:'
const MAX_RUNS = 500
const STALE_MS = 2 * 60 * 60 * 1000

// ---------- roles ----------

type RoleDef = {
  id: RoleId
  name: string
  purpose: string
  usedFor: string
  forModel: string
  prompt: string
  disallowedTools?: string[]
  defaults: RoleRule
}

const READ_ONLY = ['Edit', 'Write', 'NotebookEdit']

const ROLES: RoleDef[] = [
  {
    id: 'advisor',
    name: 'ที่ปรึกษา',
    purpose: 'คิดก่อนลงมือ: วิเคราะห์ปัญหา ออกแบบ วางแผน รีวิวโค้ด',
    usedFor: 'agent แบบ Plan และงานที่เกี่ยวกับ review / ออกแบบ / วางแผน',
    forModel:
      'Advisor: use BEFORE changing code when a problem needs deep analysis, a design or plan, a code review, or a hard judgment call. Returns advice; does not edit files.',
    prompt:
      'You are the advisor. Think carefully, weigh trade-offs, and return a clear recommendation, plan or review with concrete file and line references. Do not edit files.',
    disallowedTools: READ_ONLY,
    defaults: { enabled: true, model: 'claude-opus-5-5', effort: 'high' },
  },
  {
    id: 'explorer',
    name: 'นักสำรวจ',
    purpose: 'ค้นหาไฟล์ อ่านโค้ด แล้วสรุปว่าอะไรอยู่ตรงไหน',
    usedFor: 'agent แบบ Explore และงานค้นหา / อ่าน / สรุปโค้ด',
    forModel:
      'Explorer: use to search the codebase, read many files and report where things are and how they connect. Fast and cheap; does not edit files.',
    prompt:
      'You are the explorer. Search and read efficiently, then report findings concisely with file paths and line numbers. Do not edit files.',
    disallowedTools: READ_ONLY,
    defaults: { enabled: true, model: 'claude-haiku-5-5', effort: 'low' },
  },
  {
    id: 'coder',
    name: 'นักเขียนโค้ด',
    purpose: 'แก้หรือเขียนโค้ดตามแผนที่ตกลงกันแล้ว',
    usedFor: 'agent แบบ general-purpose ที่ไม่เข้า role อื่น',
    forModel:
      'Coder: use to implement a well-defined code change (edit or create files) once the plan is clear.',
    prompt:
      'You are the coder. Implement the requested change exactly, keep edits minimal and consistent with the surrounding code, and report what you changed.',
    defaults: { enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' },
  },
  {
    id: 'runner',
    name: 'ผู้รันงาน',
    purpose: 'รันคำสั่ง เทสต์ build lint แล้วสรุปผล',
    usedFor: 'งานที่มีคำว่า test / run / build / lint / รัน / เทสต์',
    forModel:
      'Runner: use to run commands, tests, builds or linters and summarize the results and failures. Does not edit files.',
    prompt:
      'You are the runner. Run the requested commands, then report pass/fail and the relevant error output briefly. Do not edit files.',
    disallowedTools: READ_ONLY,
    defaults: { enabled: true, model: 'claude-haiku-5-5', effort: 'low' },
  },
]
const ROLE_BY_ID = Object.fromEntries(ROLES.map(r => [r.id, r])) as Record<RoleId, RoleDef>

const DEFAULT_CONFIG: Config = {
  enabled: true,
  roles: {
    advisor: ROLE_BY_ID.advisor.defaults,
    explorer: ROLE_BY_ID.explorer.defaults,
    coder: ROLE_BY_ID.coder.defaults,
    runner: ROLE_BY_ID.runner.defaults,
  },
  maxParallel: 0,
  saverAt: 0,
}
const EMPTY_USAGE: UsageSnap = { at: 0, startedAt: 0, limits: [], contextWindow: 0 }

const tabAtom = atom({ plugin: 'subagent-control', key: 'tab' } as const, 'overview')
const rangeAtom = atom({ plugin: 'subagent-control', key: 'range' } as const, 'today')
const paneOpenAtom = atom({ plugin: 'subagent-control', key: 'paneOpen' } as const, false)
const configAtom = atom({ plugin: 'subagent-control', key: 'config' } as const, DEFAULT_CONFIG, {
  shape: 'config-2',
})
const runsAtom = atom({ plugin: 'subagent-control', key: 'runs' } as const, [] as Run[], { shape: 'runs-2' })
const usageAtom = atom({ plugin: 'subagent-control', key: 'usage' } as const, EMPTY_USAGE, {
  shape: 'usage-1',
})
const accountAtom = atom({ plugin: 'subagent-control', key: 'account' } as const, { source: 'none' } as AccountInfo, {
  shape: 'account-1',
})

const MODEL_OPTS: { value: ModelChoice; label: string }[] = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2' },
  { value: 'inherit', label: 'เหมือน main' },
]
const EFFORT_OPTS: { value: EffortChoice; label: string }[] = [
  { value: 'default', label: 'ค่าเริ่มต้น' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]
const PARALLEL_OPTS = ['0', '1', '2', '3', '4', '6', '8'].map(v => ({
  value: v,
  label: v === '0' ? 'ไม่จำกัด' : `${v} ตัว`,
}))
const SAVER_OPTS = ['0', '50', '70', '80', '90'].map(v => ({
  value: v,
  label: v === '0' ? 'ปิด' : `เมื่อใช้ไป ${v}%`,
}))
const RANGE_OPTS: { value: HistoryRange; label: string }[] = [
  { value: 'session', label: 'เซสชันนี้' },
  { value: 'today', label: 'วันนี้' },
  { value: 'week', label: '7 วัน' },
  { value: 'all', label: 'ทั้งหมด' },
]

// ---------- helpers ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function roleOf(type: string, text: string): RoleId | undefined {
  if (type.startsWith(AGENT_PREFIX)) {
    const id = type.slice(AGENT_PREFIX.length)
    return id in ROLE_BY_ID ? (id as RoleId) : undefined
  }
  if (type === 'Explore') return 'explorer'
  if (type === 'Plan') return 'advisor'
  if (type !== 'general-purpose') return undefined
  const t = text.toLowerCase()
  if (/\b(test|tests|run|build|lint|typecheck|ci)\b|รัน|เทสต์|ทดสอบ/.test(t)) return 'runner'
  if (/\b(review|design|plan|architect|analy[sz]e|advise|audit)\b|รีวิว|ออกแบบ|วางแผน|วิเคราะห์/.test(t)) return 'advisor'
  if (/\b(search|find|explore|locate|investigate|look for)\b|ค้นหา|หาไฟล์|สำรวจ/.test(t)) return 'explorer'
  return 'coder'
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}
const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtClock = (ms: number) => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const fmtDay = (ms: number) => {
  const d = new Date(ms)
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`
}
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} วิ`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`
}
function bar(pct: number, width: number): string {
  const w = Math.max(4, width)
  const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
  return '█'.repeat(n) + '░'.repeat(w - n)
}
const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const timeTh = (ms: number) => `${fmtClock(ms)} น.`
function fmtWhen(ms: number, now: number): string {
  const d = new Date(ms)
  const dayKey = (x: Date) => x.toDateString()
  const today = new Date(now)
  const tomorrow = new Date(now + 86_400_000)
  const date = `${d.getDate()} ${TH_MONTHS[d.getMonth()]}`
  if (dayKey(d) === dayKey(today)) return `วันนี้ (${TH_DAYS[d.getDay()]} ${date}) ${timeTh(ms)}`
  if (dayKey(d) === dayKey(tomorrow)) return `พรุ่งนี้ (${TH_DAYS[d.getDay()]} ${date}) ${timeTh(ms)}`
  return `วัน${TH_DAYS[d.getDay()]} ${date} ${timeTh(ms)}`
}
function fmtLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `อีก ${m} นาที`
  const h = Math.floor(m / 60)
  if (h < 24) return `อีก ${h} ชม. ${m % 60} นาที`
  return `อีก ${Math.floor(h / 24)} วัน ${h % 24} ชม.`
}
function fmtReset(s: string | undefined, now: number): string {
  if (!s) return ''
  const t = Date.parse(s)
  if (Number.isNaN(t)) return `รีเซ็ต ${s}`
  return `รีเซ็ต${fmtWhen(t, now)} · ${fmtLeft(t - now)}`
}
const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5 ชั่วโมง',
  seven_day: '7 วัน',
  seven_day_opus: '7 วัน (Opus)',
  seven_day_sonnet: '7 วัน (Sonnet)',
  spend_limit: 'วงเงิน',
}
const STATUS_LABEL: Record<Run['status'], string> = {
  running: 'กำลังทำ',
  done: 'เสร็จ',
  failed: 'ผิดพลาด',
  aborted: 'ถูกหยุด',
  denied: 'ถูกบล็อก',
  unknown: 'ไม่ทราบผล',
}
function modelName(m: string): string {
  if (m === 'inherit') return 'เหมือน main'
  const hit = /(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(m)
  if (hit) return `${hit[1]![0]!.toUpperCase()}${hit[1]!.slice(1).toLowerCase()} ${hit[2]}.${hit[3]}`
  for (const k of ['opus', 'sonnet', 'haiku', 'fable']) if (m.toLowerCase().includes(k)) return k[0]!.toUpperCase() + k.slice(1)
  return m || '?'
}
function planName(a: AccountInfo): string | undefined {
  const s = `${a.tier ?? ''} ${a.orgType ?? ''} ${a.billing ?? ''}`.toLowerCase()
  if (s.includes('max_20x') || s.includes('20x')) return 'Max 20x'
  if (s.includes('max_5x') || s.includes('5x')) return 'Max 5x'
  if (s.includes('max')) return 'Max'
  if (s.includes('enterprise')) return 'Enterprise'
  if (s.includes('team')) return 'Team'
  if (s.includes('pro')) return 'Pro'
  return a.orgType ?? a.billing
}
const roleLabel = (r: Run['role']) => (r === 'other' ? 'อื่น ๆ' : ROLE_BY_ID[r].name)
const totalTok = (r: Run) => r.input + r.cacheRead + r.cacheWrite + r.output
const isLive = (r: Run, now: number) => r.status === 'running' && now - r.startedAt < STALE_MS

// ---------- writers ----------

async function setConfig($: EngineInterface, fn: (c: Config) => Config) {
  const v = await update($, configAtom, fn)
  await $.store.set('config-2', v)
  return v
}
async function setRole($: EngineInterface, id: RoleId, patch: Partial<RoleRule>) {
  const v = await setConfig($, c => ({ ...c, roles: { ...c.roles, [id]: { ...c.roles[id], ...patch } } }))
  await syncAgent($, id, v)
}
async function setRuns($: EngineInterface, fn: (r: Run[]) => Run[]) {
  const v = await update($, runsAtom, r => fn(r).slice(-MAX_RUNS))
  await $.store.set('runs-2', v)
}

/** ลงทะเบียน role เป็น agent type ให้ Claude เลือกใช้ได้ (model + effort ตามที่ตั้ง) */
async function syncAgent($: EngineInterface, id: RoleId, cfg: Config) {
  const def = ROLE_BY_ID[id]
  const rule = cfg.roles[id]
  await $.agent.register({
    name: id,
    description: def.forModel,
    prompt: def.prompt,
    model: rule.model,
    ...(rule.effort !== 'default' ? { effort: rule.effort } : {}),
    ...(def.disallowedTools ? { disallowedTools: def.disallowedTools } : {}),
  })
}

async function refreshUsage($: EngineInterface) {
  const u = await $.session.usage()
  const at = await $.clock.now()
  await update($, usageAtom, () => ({
    at,
    startedAt: u.startedAt,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt })),
    contextPercent: u.context.percent,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    costUsd: u.cost?.usd,
  }))
}

async function loadAccount($: EngineInterface): Promise<AccountInfo> {
  let info: AccountInfo = { source: 'none' }
  try {
    const id = await $.session.identity()
    if (id.deny === undefined) {
      info = { source: 'identity', kind: id.kind, email: id.email, orgType: id.organizationType, verified: id.isVerified }
    }
  } catch {
    // ไม่ใช่ mod ที่ org ติดตั้ง: อ่านจากไฟล์ config แทน
  }
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const paths = [dir ? `${dir}/.claude.json` : '', home ? `${home}/.claude.json` : ''].filter(Boolean)
  for (const path of paths) {
    try {
      const json: unknown = JSON.parse(await $.fs.read(path))
      const a = isObj(json) && isObj(json.oauthAccount) ? json.oauthAccount : undefined
      if (!a) continue
      const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
      info = {
        ...info,
        source: info.source === 'identity' ? 'identity' : 'file',
        name: str('displayName') ?? str('fullName'),
        email: info.email ?? str('emailAddress'),
        org: str('organizationName'),
        orgType: info.orgType ?? str('organizationType'),
        role: str('organizationRole') ?? str('workspaceRole'),
        billing: str('billingType'),
        seat: str('seatTier'),
        tier: str('userRateLimitTier') ?? str('organizationRateLimitTier'),
        extraUsage: typeof a.hasExtraUsageEnabled === 'boolean' ? a.hasExtraUsageEnabled : undefined,
      }
      break
    } catch {
      // ไฟล์ไม่มีหรืออ่านไม่ได้: ลองไฟล์ถัดไป
    }
  }
  return info
}

async function openPane($: EngineInterface) {
  const res = await $.ui.open({ id: PANE, title: TITLE })
  await update($, paneOpenAtom, () => true)
  return res
}
async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await update($, paneOpenAtom, () => false)
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const storedCfg = await $.store.get('config-2')
    const cfg: Config = isObj(storedCfg)
      ? {
          ...DEFAULT_CONFIG,
          ...(storedCfg as Partial<Config>),
          roles: { ...DEFAULT_CONFIG.roles, ...((storedCfg as Partial<Config>).roles ?? {}) },
        }
      : DEFAULT_CONFIG
    await update($, configAtom, () => cfg)

    const storedRuns = await $.store.get('runs-2')
    if (Array.isArray(storedRuns)) {
      const now = await $.clock.now()
      await update($, runsAtom, () =>
        (storedRuns as Run[]).map(r => (r.status === 'running' && !isLive(r, now) ? { ...r, status: 'unknown' as const } : r)),
      )
    }

    await $.command.register({
      name: 'subagents',
      description: 'เปิด/ปิดแผง Sub-agents (ใส่ on หรือ off เพื่อเปิดปิดการใช้ sub-agents)',
      argumentHint: '[on|off]',
    })
    for (const role of ROLES) await syncAgent($, role.id, cfg).catch(() => undefined)

    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(p => p.id === PANE)) await update($, paneOpenAtom, () => true)
    else void openPane($)

    await refreshUsage($).catch(() => undefined)
    const acct = await loadAccount($).catch((): AccountInfo => ({ source: 'none' }))
    await update($, accountAtom, () => acct)
    return next(e)
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setConfig($, c => ({ ...c, enabled: arg === 'on' }))
      return { text: arg === 'on' ? 'Sub-agents: เปิดใช้งานแล้ว' : 'Sub-agents: ปิดแล้ว Claude จะทำงานเองใน thread หลัก' }
    }
    if (await read($, paneOpenAtom)) {
      await closePane($)
      return { text: 'ปิดแผง Sub-agents แล้ว' }
    }
    const opened = await openPane($)
    return {
      text: opened.isPlaced ? 'เปิดแผง Sub-agents แล้ว' : `แผง Sub-agents ยังแสดงไม่ได้: ${opened.reason}`,
    }
  })

  // ปิดแผงจากปุ่มปิดของแอป ก็ให้สถานะตรงกัน
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, paneOpenAtom, () => false)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, usageAtom, u => ({
      at,
      startedAt: u.startedAt,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt })),
      contextPercent: e.context.percent,
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      costUsd: e.cost?.usd,
    }))
    return next(e)
  })

  // ซ่อน role ที่ปิดอยู่ (หรือทั้งหมดเมื่อปิดสวิตช์หลัก) จากรายการที่ Claude เห็น
  on('agent.offer', async ($, e, next) => {
    if (!e.agent.startsWith(AGENT_PREFIX)) return next(e)
    const cfg = await read($, configAtom)
    const id = e.agent.slice(AGENT_PREFIX.length) as RoleId
    if (!cfg.enabled || cfg.roles[id]?.enabled === false) return { isOffered: false }
    return next(e)
  })

  // ตัดสินว่าจะให้แตก sub-agent ไหม และ role นั้นใช้ model อะไร
  on('agent.spawn', async ($, e, next) => {
    if (e.resume !== undefined || e.workflow !== undefined) return next(e)

    const cfg = await read($, configAtom)
    const now = await $.clock.now()
    const role = roleOf(e.subagentType, `${e.description} ${e.prompt.slice(0, 400)}`)
    const rule = role ? cfg.roles[role] : undefined
    const base: Run = {
      agentId: '',
      role: role ?? 'other',
      type: e.subagentType,
      description: e.description,
      model: e.model ?? '',
      background: e.background,
      startedAt: now,
      status: 'running',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      turns: 0,
      durationMs: 0,
    }
    const deny = async (reason: string) => {
      await setRuns($, runs => [...runs, { ...base, agentId: `denied-${now}`, endedAt: now, status: 'denied', denyReason: reason }])
      return { deny: reason }
    }

    if (!cfg.enabled) return deny('ผู้ใช้ปิด sub-agents ไว้ ให้ทำงานนี้เองใน thread หลัก')
    if (role && rule && !rule.enabled && e.subagentType.startsWith(AGENT_PREFIX)) {
      return deny(`ผู้ใช้ปิด role ${ROLE_BY_ID[role].name} ไว้ ให้ทำงานนี้เองหรือใช้ role อื่น`)
    }
    if (cfg.maxParallel > 0) {
      const running = (await read($, runsAtom)).filter(r => isLive(r, now)).length
      if (running >= cfg.maxParallel) {
        return deny(`มี sub-agent ทำงานอยู่ ${running} ตัว ครบจำนวนที่ผู้ใช้อนุญาตแล้ว รอให้ตัวที่ทำอยู่เสร็จก่อน`)
      }
    }

    let model = e.model
    if (!e.fork && rule && rule.enabled) {
      model = rule.model === 'inherit' ? e.parentModel : rule.model
      if (cfg.saverAt > 0) {
        const five = (await read($, usageAtom)).limits.find(l => l.kind === 'five_hour')
        if (five && five.percent >= cfg.saverAt) model = 'claude-haiku-5-5'
      }
    }

    const res = await next({ ...e, model })
    if (res.deny === undefined && res.agentId !== undefined) {
      const agentId = res.agentId
      await setRuns($, runs => [...runs, { ...base, agentId, model: res.model }])
    }
    return res
  })

  // เก็บ token ของแต่ละ sub-agent ทุกครั้งที่ loop ของมันจบ turn
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id === undefined) return result
    const u = e.usage
    const now = await $.clock.now()
    const status: Run['status'] = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'failed'
    await setRuns($, runs => {
      const list: Run[] = runs.some(r => r.agentId === id)
        ? runs
        : [
            ...runs,
            {
              agentId: id,
              role: 'other',
              type: '?',
              description: '',
              model: u?.model ?? '',
              background: false,
              startedAt: now - e.durationMs,
              status: 'running',
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              turns: 0,
              durationMs: 0,
            },
          ]
      return list.map(r =>
        r.agentId !== id
          ? r
          : {
              ...r,
              model: u?.model ?? r.model,
              input: r.input + (u?.input_tokens ?? 0),
              output: r.output + (u?.output_tokens ?? 0),
              cacheRead: r.cacheRead + (u?.cache_read_input_tokens ?? 0),
              cacheWrite: r.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
              turns: r.turns + 1,
              durationMs: r.durationMs + e.durationMs,
              endedAt: now,
              status,
            },
      )
    })
    return result
  })

  // ---------- แถบเหนือช่องพิมพ์ ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cfg = await read($, configAtom)
    const usage = await read($, usageAtom)
    const paneOpen = await read($, paneOpenAtom)
    const five = usage.limits.find(l => l.kind === 'five_hour')
    return (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Text>
          <Text color={cfg.enabled ? 'success' : 'inactive'}>{cfg.enabled ? '●' : '○'}</Text>
          <Text bold> Sub-agents</Text>
          <Text dimColor> · {cfg.enabled ? 'ใช้งานอยู่' : 'ปิดอยู่'}</Text>
        </Text>
        <Button key="band:toggle" dimColor onPress={() => setConfig($, c => ({ ...c, enabled: !c.enabled }))}>
          {cfg.enabled ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
        </Button>
        {five && <Text dimColor>· usage 5 ชม. {Math.round(five.percent)}%</Text>}
        <Button key="band:pane" dimColor onPress={() => (paneOpen ? closePane($) : openPane($))}>
          {paneOpen ? 'ซ่อนแผง' : 'แสดงแผง'}
        </Button>
      </Box>
    )
  })

  // ---------- แผง ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const tab = await read($, tabAtom)
    const cfg = await read($, configAtom)
    const runs = await read($, runsAtom)
    const usage = await read($, usageAtom)
    const acct = await read($, accountAtom)
    const range = await read($, rangeAtom)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 50
    const barW = Math.max(8, Math.min(20, cols - 22))
    const live = runs.filter(r => isLive(r, now))
    const activeRoles = ROLES.filter(r => cfg.roles[r.id].enabled).length

    const heading = (title: string, hint?: string) => (
      <Box flexDirection="column" marginTop={2}>
        <Text bold>{title}</Text>
        {hint && <Text dimColor>{hint}</Text>}
      </Box>
    )

    // แถวมาตรวัด: ป้ายอยู่คอลัมน์ซ้ายกว้างคงที่ แถบกับคำอธิบายอยู่คอลัมน์ขวา จึงตรงกันเสมอ
    const LABEL_W = 12
    const meter = (key: string, label: string, pct: number, value: string, color: Color, sub?: string) => (
      <Box key={key} flexDirection="row">
        <Box width={LABEL_W} flexShrink={0}>
          <Text>{label}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text>
            <Text color={color}>{bar(pct, barW)}</Text> <Text bold>{value}</Text>
          </Text>
          {sub && <Text dimColor>{sub}</Text>}
        </Box>
      </Box>
    )

    // การ์ดสถานะ: บอกสถานะชัด ๆ แยกจากปุ่มที่ใช้สั่ง
    const status = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={cfg.enabled ? 'success' : 'inactive'}
        paddingX={1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Text>
            <Text color={cfg.enabled ? 'success' : 'inactive'}>{cfg.enabled ? '●' : '○'}</Text>
            <Text bold> {cfg.enabled ? 'ใช้งานอยู่' : 'ปิดอยู่'}</Text>
          </Text>
          <Button
            key="master"
            variant={cfg.enabled ? 'secondary' : 'primary'}
            onPress={() => setConfig($, c => ({ ...c, enabled: !c.enabled }))}
          >
            {cfg.enabled ? 'ปิด sub-agents' : 'เปิด sub-agents'}
          </Button>
        </Box>
        <Text dimColor>
          {cfg.enabled
            ? `Claude แตกงานให้ sub-agent ได้ ตาม ${activeRoles} role ที่ตั้งไว้${live.length ? ` · ทำงานอยู่ ${live.length} ตัว` : ''}`
            : 'Claude จะทำทุกอย่างเองใน thread หลัก ไม่แตก sub-agent'}
        </Text>
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        {(
          [
            { id: 'overview', label: 'ภาพรวม', hotkey: '1' },
            { id: 'roles', label: 'ตั้งค่า role', hotkey: '2' },
          ] as const
        ).map(t => (
          <Button
            key={`tab:${t.id}`}
            hotkey={t.hotkey}
            variant={t.id === tab ? 'primary' : 'secondary'}
            onPress={() => update($, tabAtom, (): Tab => t.id)}
          >
            {t.label}
          </Button>
        ))}
      </Box>
    )

    // ----- ภาพรวม: account + usage + วันนี้ + ประวัติ -----
    const overview = () => {
      const plan = planName(acct)
      const startOfToday = new Date(new Date(now).toDateString()).getTime()
      const from =
        range === 'session' ? usage.startedAt : range === 'today' ? startOfToday : range === 'week' ? now - 7 * 86_400_000 : 0
      const list = runs.filter(r => r.startedAt >= from)
      const counted = list.filter(r => r.status !== 'denied')
      const byRole = new Map<string, { n: number; tok: number; models: Set<string> }>()
      for (const r of counted) {
        const k = roleLabel(r.role)
        const g = byRole.get(k) ?? { n: 0, tok: 0, models: new Set<string>() }
        g.n++
        g.tok += totalTok(r)
        g.models.add(modelName(r.model))
        byRole.set(k, g)
      }
      const roleRows = [...byRole.entries()].sort((a, b) => b[1].tok - a[1].tok)
      const maxTok = Math.max(1, ...roleRows.map(([, g]) => g.tok))
      const recent = [...list].reverse().slice(0, 15)

      return (
        <Box flexDirection="column">
          {heading('Account')}
          {acct.source === 'none' ? (
            <Text dimColor>อ่านข้อมูล account ไม่ได้ (เช่น ใช้ API key หรือ cloud provider)</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                {acct.name ?? '-'}
                {plan && <Text color="claude"> · {plan}</Text>}
              </Text>
              {acct.email && <Text dimColor>{acct.email}</Text>}
              {acct.org && (
                <Text dimColor>
                  {acct.org}
                  {acct.role ? ` · ${acct.role}` : ''}
                  {acct.extraUsage ? ' · extra usage เปิด' : ''}
                </Text>
              )}
            </Box>
          )}

          {heading('Usage')}
          {usage.limits.length === 0 && <Text dimColor>ยังไม่มีข้อมูล (จะขึ้นหลัง Claude ตอบครั้งแรก)</Text>}
          <Box flexDirection="column" gap={1} marginTop={1}>
            {usage.limits.map(l =>
              meter(
                `lim:${l.kind}`,
                LIMIT_LABEL[l.kind] ?? l.kind,
                l.percent,
                `${Math.round(l.percent)}%`,
                l.percent >= 90 ? 'error' : l.percent >= 70 ? 'warning' : 'success',
                fmtReset(l.resetsAt, now),
              ),
            )}
            {usage.contextWindow > 0 &&
              meter(
                'context',
                'Context',
                usage.contextPercent ?? 0,
                `${Math.round(usage.contextPercent ?? 0)}%`,
                'suggestion',
                `${fmtTok(usage.contextTokens ?? 0)} จาก ${fmtTok(usage.contextWindow)} tokens`,
              )}
          </Box>

          {heading('การใช้ sub-agent')}
          <Box marginTop={1}>
            <Select
              key="range"
              label="ช่วง"
              options={RANGE_OPTS}
              value={range}
              onSelect={v => update($, rangeAtom, () => v as HistoryRange)}
            />
          </Box>
          <Text>
            {counted.length} ครั้ง · {fmtTok(counted.reduce((s, r) => s + totalTok(r), 0))} tokens
            {list.length > counted.length && <Text dimColor> · ถูกบล็อก {list.length - counted.length}</Text>}
          </Text>
          {roleRows.length > 0 && (
            <Box flexDirection="column" gap={1} marginTop={1}>
              {roleRows.map(([k, g]) =>
                meter(`role:${k}`, k, (g.tok / maxTok) * 100, fmtTok(g.tok), 'claude', `${g.n} ครั้ง · ${[...g.models].join(', ')}`),
              )}
            </Box>
          )}

          {heading("ประวัติล่าสุด")}
          <Box marginTop={1} />
          {recent.length === 0 && <Text dimColor>ยังไม่มี sub-agent ในช่วงนี้</Text>}
          {recent.map(r => {
            const live = isLive(r, now)
            const st = r.status === 'running' && !live ? 'unknown' : r.status
            return (
              <Box key={`run:${r.agentId}`} flexDirection="column" marginBottom={1}>
                <Text>
                  <Text dimColor>
                    {range === 'week' || range === 'all' ? `${fmtDay(r.startedAt)} ` : ''}
                    {timeTh(r.startedAt)}{' '}
                  </Text>
                  <Text bold>{roleLabel(r.role)}</Text>
                  <Text dimColor> · {modelName(r.model)}</Text>
                  <Text color={st === 'running' ? 'suggestion' : st === 'done' ? 'success' : st === 'denied' || st === 'failed' ? 'error' : 'inactive'}>
                    {' '}
                    {STATUS_LABEL[st]}
                  </Text>
                </Text>
                <Text dimColor>
                  {'      '}
                  {r.description || r.type}
                </Text>
                <Text dimColor>
                  {'      '}
                  {st === 'denied'
                    ? r.denyReason
                    : `${fmtTok(totalTok(r))} tokens (in ${fmtTok(r.input)} · cache ${fmtTok(r.cacheRead + r.cacheWrite)} · out ${fmtTok(r.output)}) · ${fmtDur(r.durationMs || (live ? now - r.startedAt : 0))}`}
                </Text>
              </Box>
            )
          })}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button
              key="refresh"
              dimColor
              onPress={async () => {
                await refreshUsage($)
                const a = await loadAccount($)
                await update($, accountAtom, () => a)
              }}
            >
              รีเฟรช
            </Button>
            <Button key="clear" dimColor onPress={() => setRuns($, () => [])}>
              ล้างประวัติ
            </Button>
          </Box>
        </Box>
      )
    }

    // ----- ตั้งค่า role -----
    const roles = () => (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text dimColor>
            งานแต่ละแบบให้ model ไหนทำ เช่น ที่ปรึกษาใช้ Opus เพื่อคิดลึก ส่วนงานรันคำสั่งใช้ Haiku เพื่อเร็วและประหยัด
          </Text>
        </Box>
        {ROLES.map(def => {
          const rule = cfg.roles[def.id]
          return (
            <Box
              key={`card:${def.id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={rule.enabled ? 'promptBorder' : 'inactive'}
              paddingX={1}
              marginTop={1}
            >
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
                <Text bold dimColor={!rule.enabled}>
                  {def.name}
                  {!rule.enabled && <Text color="inactive"> (ไม่ใช้)</Text>}
                </Text>
                <Button key={`en:${def.id}`} dimColor onPress={() => setRole($, def.id, { enabled: !rule.enabled })}>
                  {rule.enabled ? 'ไม่ใช้ role นี้' : 'ใช้ role นี้'}
                </Button>
              </Box>
              <Text dimColor>{def.purpose}</Text>
              {rule.enabled && (
                <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
                  <Select
                    key={`model:${def.id}`}
                    label="Model"
                    options={MODEL_OPTS}
                    value={rule.model}
                    onSelect={v => setRole($, def.id, { model: v as ModelChoice })}
                  />
                  <Select
                    key={`effort:${def.id}`}
                    label="ความลึกในการคิด"
                    options={EFFORT_OPTS}
                    value={rule.effort}
                    onSelect={v => setRole($, def.id, { effort: v as EffortChoice })}
                  />
                </Box>
              )}
              <Text dimColor>ใช้กับ: {def.usedFor}</Text>
            </Box>
          )
        })}

        {heading('ควบคุมการใช้ usage')}
        <Box flexDirection="column" marginTop={1}>
          <Select
            key="saver"
            label="โหมดประหยัด"
            options={SAVER_OPTS}
            value={String(cfg.saverAt)}
            onSelect={v => setConfig($, c => ({ ...c, saverAt: Number(v) }))}
          />
          <Text dimColor>เมื่อ usage 5 ชั่วโมงถึงระดับนี้ ทุก role จะเปลี่ยนไปใช้ Haiku 5.5 ชั่วคราว</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Select
            key="maxParallel"
            label="ทำงานพร้อมกันสูงสุด"
            options={PARALLEL_OPTS}
            value={String(cfg.maxParallel)}
            onSelect={v => setConfig($, c => ({ ...c, maxParallel: Number(v) }))}
          />
          <Text dimColor>จำกัดจำนวน sub-agent ที่รันพร้อมกัน กันไม่ให้ usage พุ่งเร็ว</Text>
        </Box>
        <Box marginTop={1}>
          <Button
            key="reset"
            dimColor
            onPress={async () => {
              const v = await setConfig($, c => ({ ...DEFAULT_CONFIG, enabled: c.enabled }))
              for (const r of ROLES) await syncAgent($, r.id, v)
            }}
          >
            คืนค่าเริ่มต้น
          </Button>
        </Box>
        <Text dimColor>
          ความลึกในการคิดมีผลเมื่อ Claude เรียก role ของ mod นี้โดยตรง ส่วน agent ในตัว (Explore, Plan, general-purpose) จะถูกเปลี่ยนแค่ model ตาม role ที่ตรงกัน
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        {status}
        {tabs}
        {tab === 'roles' ? roles() : overview()}
      </Box>
    )
  })
}
