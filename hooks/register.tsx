import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type {
  AccountInfo,
  Config,
  EffortChoice,
  HistoryRange,
  ModelChoice,
  ModelDay,
  RoleId,
  RoleRule,
  Run,
  Tab,
  UsageSnap,
} from '../types'

const PANE = 'subagent-control'
// release.sh เขียนเลขนี้ให้ตรงกับ .claude-plugin/plugin.json ทุกครั้งที่ปล่อย
const VERSION = '0.1.19'
const TITLE = 'sub-agents'
const AGENT_PREFIX = 'subagent-control:'
const MAX_RUNS = 500
const MAX_MODEL_DAYS = 400
const STALE_MS = 2 * 60 * 60 * 1000

// ---------- roles ----------

type RoleDef = {
  id: RoleId
  name: string
  purpose: string
  short: string
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
    name: 'วางแผน / รีวิว',
    short: 'วิเคราะห์ · ออกแบบ · รีวิว',
    purpose: 'คิดก่อนลงมือ: วิเคราะห์ปัญหา ออกแบบ วางแผน รีวิวโค้ด',
    usedFor: 'agent แบบ Plan และงานที่เกี่ยวกับ review / ออกแบบ / วางแผน',
    forModel:
      'Advisor: use BEFORE changing code when a problem needs deep analysis, a design or plan, a code review, or a hard judgment call. Returns advice; does not edit files.',
    prompt:
      'You are the advisor. Think carefully, weigh trade-offs, and return a clear recommendation, plan or review with concrete file and line references. Build on any researcher or explorer findings in your brief instead of redoing them, and treat what they marked unverified as open. If you lack a fact you need, name it in your report so it can be looked up. Do not edit files.',
    disallowedTools: READ_ONLY,
    defaults: { enabled: true, model: 'claude-opus-5-5', effort: 'high' },
  },
  {
    id: 'explorer',
    name: 'ค้นหาโค้ด',
    short: 'ค้นหา · อ่านโค้ด',
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
    id: 'researcher',
    name: 'ค้นคว้า',
    short: 'ค้นเว็บ · อ่าน docs',
    purpose: 'หาข้อมูลจริงจากเว็บและเอกสารทางการ แล้วสรุปพร้อมแหล่งอ้างอิง',
    usedFor: 'งานที่มีคำว่า research / อ่าน docs / ค้นคว้า / หาข้อมูล / changelog',
    forModel:
      'Researcher: use to look up real information outside the codebase: read official docs, changelogs and web sources, check how a library or API actually works, compare options. Returns a sourced summary that the advisor and coder can build on; does not edit files.',
    prompt: [
      'You are the researcher. Find out how things actually work from primary sources instead of memory: use WebSearch and WebFetch (and any docs or MCP tools you have) and prefer official documentation, changelogs and source repositories over blog posts. Read the pages, do not stop at search snippets.',
      'Check versions and dates: say which version or date each fact applies to, and flag anything that may be out of date or that sources disagree on.',
      'Never invent a fact, URL, API name or version. If a page is unreachable or you could not verify something, say so plainly.',
      'Report back in this shape so the others can reuse it as is: 1) Answer (a few lines). 2) Key facts, each with its source URL and version/date. 3) What is uncertain or unverified. 4) What this means for the task (constraints, gotchas, a recommended approach). Keep it concise; no long quotes from sources.',
      'You work alongside the other roles: the explorer finds things in the codebase, you find things outside it, the advisor turns both into a plan, the coder implements it. If the task also needs code facts, say exactly what the explorer should look for instead of guessing about this codebase. Do not edit files.',
    ].join(' '),
    disallowedTools: READ_ONLY,
    defaults: { enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' },
  },
  {
    id: 'coder',
    name: 'เขียนโค้ด',
    short: 'เขียน · แก้โค้ด',
    purpose: 'แก้หรือเขียนโค้ดตามแผนที่ตกลงกันแล้ว',
    usedFor: 'agent แบบ general-purpose ที่ไม่เข้า role อื่น',
    forModel:
      'Coder: use to implement a well-defined code change (edit or create files) once the plan is clear.',
    prompt:
      'You are the coder. Implement the requested change exactly, keep edits minimal and consistent with the surrounding code, and report what you changed. Follow the plan and any researcher findings in your brief (API names, versions, gotchas) rather than guessing from memory; if something you need is missing or contradicts the code, say so in your report instead of improvising.',
    defaults: { enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' },
  },
  {
    id: 'runner',
    name: 'รันเทสต์ / build',
    short: 'รันคำสั่ง · เทสต์ · build',
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
    researcher: ROLE_BY_ID.researcher.defaults,
    coder: ROLE_BY_ID.coder.defaults,
    runner: ROLE_BY_ID.runner.defaults,
  },
  maxParallel: 0,
  saverAt: 0,
  bandHidden: false,
}
const EMPTY_USAGE: UsageSnap = { at: 0, startedAt: 0, limits: [], contextWindow: 0 }

const tabAtom = atom({ plugin: 'subagent-control', key: 'tab' } as const, 'models')
const rangeAtom = atom({ plugin: 'subagent-control', key: 'range' } as const, 'today')
const paneOpenAtom = atom({ plugin: 'subagent-control', key: 'paneOpen' } as const, false)
const configAtom = atom({ plugin: 'subagent-control', key: 'config' } as const, DEFAULT_CONFIG, {
  shape: 'config-2',
})
const runsAtom = atom({ plugin: 'subagent-control', key: 'runs' } as const, [] as Run[], { shape: 'runs-2' })
const modelUsageAtom = atom({ plugin: 'subagent-control', key: 'modelUsage' } as const, [] as ModelDay[], {
  shape: 'model-usage-1',
})
const sessionModelsAtom = atom({ plugin: 'subagent-control', key: 'sessionModels' } as const, [] as ModelDay[])
const noticeAtom = atom({ plugin: 'subagent-control', key: 'notice' } as const, '')
const dedupedAtom = atom({ plugin: 'subagent-control', key: 'deduped' } as const, 0)
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
  { value: 'default', label: 'auto' },
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
  label: v === '0' ? 'ปิด' : `≥ ${v}%`,
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
  // ค้นคว้านอกโปรเจกต์ (เว็บ/เอกสารทางการ) ต้องเช็กก่อนค้นหาโค้ด และไม่จับคำว่า docs เฉย ๆ เพราะอาจเป็นงานเขียนเอกสาร
  if (/\b(research|look\s?up|web\s?search|read (the )?(official )?docs?|check (the )?(official )?docs?|official docs?|documentation for|changelog|release notes)\b|ค้นคว้า|หาข้อมูล|อ่าน\s?docs|อ่านเอกสาร|ดูเอกสาร/.test(t)) return 'researcher'
  if (/\b(search|find|explore|locate|investigate|look for)\b|ค้นหา|หาไฟล์|สำรวจ/.test(t)) return 'explorer'
  return 'coder'
}

// ---------- กันงานซ้ำ ----------

/** spawn ที่กำลังเริ่ม (ยังไม่อยู่ใน $.agent.list): กัน Agent call หลายตัวในข้อความเดียวหลุดซ้ำกัน */
let inflight: { id: string; description: string; type: string; status: string; key: string[] }[] = []
let inflightSeq = 0
/** เวลาเริ่ม session นี้: งานของ session ก่อนไม่นับเป็น "เพิ่งเสร็จ" */
let sessionStartedAt = 0

/** ช่วงเวลาที่ถือว่างานที่เพิ่งเสร็จยัง "สด" (spawn ซ้ำในช่วงนี้ = ทำซ้ำ) */
const RECENT_MS = 15 * 60 * 1000
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'from', 'by', 'at', 'is', 'it', 'this', 'that',
  'again', 're', 'ซ้ำ', 'อีกครั้ง', 'ใหม่',
])

/** ตัดคำ: ภาษาไทยไม่มีช่องว่างคั่นคำ จึงใช้ Intl.Segmenter ถ้า runtime มี */
function splitWords(text: string): string[] {
  const chunks = text.split(/[^\p{L}\p{M}\p{N}_.\/-]+/u).filter(Boolean)
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => { segment(t: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter
  if (!Seg) return chunks
  const seg = new Seg('th', { granularity: 'word' })
  return chunks.flatMap(c =>
    /[\u0E00-\u0E7F]/.test(c) ? [...seg.segment(c)].filter(x => x.isWordLike !== false).map(x => x.segment) : [c],
  )
}

/** คำสำคัญของงาน: คำใน description + path/ชื่อไฟล์ที่ prompt อ้างถึง */
function taskKey(description: string, prompt: string): string[] {
  const words = splitWords(description.toLowerCase())
    .map(w => w.replace(/^[.\/-]+|[.\/-]+$/g, ''))
    .filter(w => (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
  const files = (prompt.slice(0, 4000).match(/[\w.\/-]*[\w-]+\.[a-z]{1,5}\b/gi) ?? [])
    .map(f => f.toLowerCase().replace(/^\.\//, ''))
    .filter(f => /[\/]/.test(f) || /\.(tsx?|jsx?|py|go|rs|java|kt|swift|rb|php|cs|vue|svelte|sql|md|json|ya?ml)$/.test(f))
  return [...new Set([...words, ...files.map(f => `file:${f}`)])]
}

function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sb = new Set(b)
  const inter = a.filter(x => sb.has(x)).length
  return inter / (a.length + b.length - inter)
}

const normDesc = (d: string) => d.toLowerCase().replace(/\s+/g, ' ').trim()

/** ไฟล์ context ที่ brief มักอ้างร่วมกัน (แผน, เอกสาร, config) — ไม่ใช่เป้าหมายของงาน */
const isContextFile = (k: string) =>
  /\.(md|mdx|txt|lock)$/.test(k) || /(^|\/)(package(-lock)?\.json|tsconfig[\w.-]*\.json|claude\.md|agents\.md|readme\.[a-z]+)$/.test(k)
/** กริยาทั่วไปที่ไม่บอกเป้าหมาย */
const GENERIC = new Set([
  'review', 'check', 'fix', 'run', 'test', 'tests', 'implement', 'update', 'add', 'find', 'search', 'read', 'verify',
  'รีวิว', 'ตรวจ', 'แก้', 'แก้ไข', 'รัน', 'เทสต์', 'ทดสอบ', 'ค้นหา', 'หา', 'อ่าน', 'เพิ่ม', 'เขียน',
])

/** กลุ่มของงาน: role ที่ mod จัดให้ (advisor แบบ Plan / general-purpose ที่ทำ review นับเป็นกลุ่มเดียวกัน) */
const groupOf = (type: string, description: string) => roleOf(type, description) ?? type

/** งานสองงานคือ "ที่เดิม" ไหม: กลุ่มเดียวกัน และ description เดียวกัน หรือคำสำคัญ/ไฟล์เป้าหมายทับกันเกือบหมด */
function sameTask(
  a: { type: string; description: string; key?: string[] },
  b: { type: string; description: string; key?: string[] },
  min: number,
  byFiles: boolean,
): boolean {
  if (groupOf(a.type, a.description) !== groupOf(b.type, b.description)) return false
  const ka = a.key ?? taskKey(a.description, '')
  const kb = b.key ?? taskKey(b.description, '')
  const fa = ka.filter(k => k.startsWith('file:') && !isContextFile(k))
  const fb = kb.filter(k => k.startsWith('file:') && !isContextFile(k))
  const fileSim = fa.length > 0 && fb.length > 0 ? similarity(fa, fb) : undefined
  // description เดียวกันแต่ชี้ไฟล์คนละชุด (เช่น "Fix failing tests" คนละ package) = คนละงาน
  if (fileSim !== undefined && fileSim < 0.3) return false
  if (normDesc(a.description) !== '' && normDesc(a.description) === normDesc(b.description)) return true
  // ไฟล์เป้าหมายชุดเดียวกัน + มีคำบอกเป้าหมายร่วมกัน = ที่เดิม แม้ description ต่างกัน
  if (byFiles && fileSim !== undefined && fileSim >= 0.8) {
    const wa = ka.filter(k => !k.startsWith('file:') && !GENERIC.has(k))
    const wb = new Set(kb.filter(k => !k.startsWith('file:') && !GENERIC.has(k)))
    if (wa.some(w => wb.has(w))) return true
  }
  return similarity(ka.filter(k => !k.startsWith('file:') || !isContextFile(k)), kb.filter(k => !k.startsWith('file:') || !isContextFile(k))) >= min
}

/** สถานะที่ยังถือว่าทำงานอยู่ (pending/running/waiting/idle) */
const isActive = (status: string) => status !== 'completed' && status !== 'failed' && status !== 'killed'

export type Duplicate = { kind: 'running' | 'recent'; id: string; description: string; type: string; name?: string; endedAt?: number }

/** หา sub-agent ที่ทำงานเดียวกันอยู่ (ยังรันอยู่จริง) หรือเพิ่งทำเสร็จ */
function findDuplicate(
  want: { type: string; description: string; key: string[] },
  live: ReadonlyArray<{ id: string; description: string; type: string; status: string; name?: string; key?: string[] }>,
  runs: Run[],
  now: number,
  sinceMs: number,
): Duplicate | undefined {
  const keyOf = (id: string) => runs.find(r => r.agentId === id)?.key
  for (const a of live) {
    if (!isActive(a.status)) continue
    if (sameTask({ ...a, key: a.key ?? keyOf(a.id) }, want, 0.6, true)) {
      return { kind: 'running', id: a.id, description: a.description, type: a.type, name: a.name }
    }
  }
  // งานที่เพิ่งเสร็จ: เฉพาะงานอ่านอย่างเดียว (รีวิว/ค้นหา) ใน session นี้ — รันเทสต์หรือแก้โค้ดซ้ำหลังแก้เป็นเรื่องปกติ
  const g = groupOf(want.type, want.description)
  if (g !== 'advisor' && g !== 'explorer' && g !== 'researcher') return undefined
  const activeIds = new Set(live.filter(a => isActive(a.status)).map(a => a.id))
  for (const r of [...runs].reverse()) {
    if (r.status !== 'done' || r.endedAt === undefined || now - r.endedAt > RECENT_MS || activeIds.has(r.agentId)) continue
    if (r.startedAt < sinceMs) continue
    if (sameTask(r, want, 0.8, false)) {
      return { kind: 'recent', id: r.agentId, description: r.description, type: r.type, endedAt: r.endedAt }
    }
  }
  return undefined
}

/** agent ที่ยังทำงานอยู่: ถามจาก engine ($.agent.list) ถ้ามี ไม่งั้นใช้ประวัติของ mod เอง */
async function liveAgents($: EngineInterface, runs: Run[], now: number) {
  try {
    return await $.agent.list()
  } catch {
    // engine เก่าหรือ list ล้มเหลว: ใช้ประวัติแทน
  }
  return runs
    .filter(r => isLive(r, now))
    .map(r => ({ id: r.agentId, description: r.description, type: r.type, status: 'running' as const }))
}

function duplicateReason(d: Duplicate, now: number): string {
  const who = `"${d.description}" (${d.type}, id ${d.id}${d.name ? `, ชื่อ ${d.name}` : ''})`
  if (d.kind === 'running') {
    return [
      `งานนี้ซ้ำกับ sub-agent ที่กำลังทำอยู่: ${who}.`,
      'Do not start another agent on the same target. Wait for that agent\'s result' +
        (d.name ? `, or send it extra instructions with SendMessage to "${d.name}"` : '') +
        '. Do not do this work yourself in the main thread either.',
    ].join(' ')
  }
  const mins = Math.max(1, Math.round((now - (d.endedAt ?? now)) / 60000))
  return [
    `งานนี้เพิ่งทำเสร็จไปเมื่อ ${mins} นาทีที่แล้วโดย ${who}.`,
    'Use that agent\'s result instead of redoing it. Only if the code changed after it finished, spawn again with a description that names what changed, and limit the brief to those changes.',
  ].join(' ')
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
  return `${TH_DAYS[d.getDay()]} ${date} ${timeTh(ms)}`
}
function fmtLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `อีก ${m} นาที`
  const h = Math.floor(m / 60)
  if (h < 24) return `อีก ${h} ชม. ${m % 60} นาที`
  return `อีก ${Math.floor(h / 24)} วัน ${h % 24} ชม.`
}
/** [เวลารีเซ็ต, เวลาคงเหลือ] — แสดงคนละแถว */
function fmtReset(s: string | undefined, now: number, timeOnly = false): [string, string] {
  if (!s) return ['', '']
  const t = Date.parse(s)
  if (Number.isNaN(t)) return [`รีเซ็ต ${s}`, '']
  // ราย 5 ชม. รีเซ็ตภายในไม่กี่ชั่วโมงอยู่แล้ว ไม่ต้องบอกวัน
  return [`รีเซ็ต ${timeOnly ? timeTh(t) : fmtWhen(t, now)}`, fmtLeft(t - now)]
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
const modelTok = (d: ModelDay) => d.input + d.cacheRead + d.cacheWrite + d.output
const DAY_MS = 86_400_000
const startOfDay = (ms: number) => new Date(new Date(ms).toDateString()).getTime()
type TurnUsage = {
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
/** บวก token ของ 1 turn ลงแถวของ (วัน, model) นั้น */
function addModelUsage(list: ModelDay[], at: number, u: TurnUsage): ModelDay[] {
  const model = u.model ?? ''
  const add = (d: ModelDay): ModelDay => ({
    ...d,
    input: d.input + (u.input_tokens ?? 0),
    output: d.output + (u.output_tokens ?? 0),
    cacheRead: d.cacheRead + (u.cache_read_input_tokens ?? 0),
    cacheWrite: d.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    turns: d.turns + 1,
  })
  if (list.some(d => d.at === at && d.model === model)) return list.map(d => (d.at === at && d.model === model ? add(d) : d))
  return [...list, add({ at, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })]
}
const isLive = (r: Run, now: number) => r.status === 'running' && now - r.startedAt < STALE_MS

// ---------- writers ----------

async function setConfig($: EngineInterface, fn: (c: Config) => Config) {
  const v = await update($, configAtom, fn)
  await $.store.set('config-2', v)
  // คำอธิบาย Agent tool เปลี่ยนตามสวิตช์ (มีผลใน thread ใหม่ ส่วน thread นี้ agent.spawn ยังบล็อก/ปล่อยตามจริง)
  try {
    $.ui.invalidate('tool.describe')
  } catch {
    // engine ที่ไม่รองรับ: คำอธิบายใหม่มีผลใน session ถัดไป
  }
  return v
}
async function hideBand($: EngineInterface) {
  await setConfig($, c => ({ ...c, bandHidden: true }))
  try {
    $.ui.toast('ซ่อนแถบ sub-agents แล้ว · แสดงคืนได้ที่แผง > ตั้งค่า หรือพิมพ์ /subagents band')
  } catch {
    // surface ที่ไม่มี toast
  }
}
async function setRole($: EngineInterface, id: RoleId, patch: Partial<RoleRule>) {
  const v = await setConfig($, c => ({ ...c, roles: { ...c.roles, [id]: { ...c.roles[id], ...patch } } }))
  await syncAgent($, id, v)
}
async function setRuns($: EngineInterface, fn: (r: Run[]) => Run[]) {
  const v = await update($, runsAtom, r => fn(r).slice(-MAX_RUNS))
  await $.store.set('runs-2', v)
}

async function recordMainUsage($: EngineInterface, now: number, u: TurnUsage) {
  const v = await update($, modelUsageAtom, l => addModelUsage(l, startOfDay(now), u).slice(-MAX_MODEL_DAYS))
  await $.store.set('model-usage-1', v)
  await update($, sessionModelsAtom, l => addModelUsage(l, 0, u))
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

const WHEN: Record<RoleId, string> = {
  explorer: 'finding where something lives or how parts connect, whenever it means searching or reading more than a couple of files',
  researcher: 'finding out how something really works outside the codebase: reading official docs, changelogs or web sources, checking a library or API version, comparing options (it returns a sourced summary)',
  advisor: 'a design, plan, code review or hard trade-off before you change code',
  coder: 'an implementation step whose plan is clear, especially independent pieces that can run in parallel',
  runner: 'running tests, builds, linters or long commands and summarizing the failures',
}

/** คำสั่งใน system prompt ตอนเปิด sub-agents (ว่าง = ไม่ใส่) */
function delegationPolicy(cfg: Config): string {
  if (!cfg.enabled) return ''
  const on = ROLES.filter(r => cfg.roles[r.id]?.enabled !== false)
  if (on.length === 0) return ''
  const lines = on.map(r => `- \`${AGENT_PREFIX}${r.id}\` — ${WHEN[r.id]}.`)
  return [
    '# Sub-agents (turned on by the user)',
    'The user switched on the Sub-agents panel: they want work delegated to sub-agents rather than done entirely in this thread. This takes precedence over any general advice to avoid spawning agents or to do small searches yourself.',
    'Use the Agent tool with these sub-agent types (each already runs on the model and effort the user picked for it):',
    ...lines,
    'How to delegate:',
    '- Delegate every step that matches a role above; keep only quick single-file edits, one-off commands and the final integration in this thread.',
    '- Prefer these types over the built-in Explore, Plan and general-purpose agents for the same kind of work.',
    '- In plan mode, or whenever you are about to propose a plan or design, have the advisor draft or review it first and say in the plan that it did.',
    '- Roles hand work to each other through you; sub-agents cannot see one another. A typical flow: researcher (facts from docs and the web) and explorer (facts from the codebase) in parallel -> advisor (plan from both) -> coder (implement) -> runner (verify). Paste the relevant findings, with their sources, into the next agent\'s brief instead of letting it rediscover them.',
    '- Use the researcher whenever a step depends on how a library, API, tool or standard actually behaves and you are not certain (new versions, unfamiliar docs, breaking changes) before the advisor plans or the coder writes code against it. Treat its unverified items as open questions, not facts. If an advisor or coder reports that it lacks a fact, dispatch the researcher (or explorer) for it and then continue that step with the answer.',
    '- Start independent sub-agents in the same message so they run in parallel; wait for their results instead of redoing their work.',
    '- One agent per task: never start a second agent of the same role on the same task while one is running, and never redo a review or search finished in this session unless the code changed since. Before each spawn, recall which agents are still running (background ones too, and after a context summary) and wait for them or message them with SendMessage instead. A duplicate spawn is denied with the agent it collides with.',
    '- Review each piece once. Re-review only what changed after the review, and say what changed in the brief; never re-dispatch the same review batch.',
    '- Give each a self-contained brief (goal, files, what is already known, what to report back), since it does not see this conversation.',
    '- Check what a sub-agent reports yourself (read its diff or output) before you tell the user it is done; do not spawn another agent just to re-check the same work.',
    '- If a spawn is denied because the user capped how many run at once or turned a role off, do that step yourself. If it is denied as a duplicate, do not do that work yourself either; wait for or reuse the other agent\'s result.',
    '- When the user asks whether sub-agents are being used, answer from the Agent calls you actually made.',
  ].join('\n')
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

const isNoSurface = (reason: string) => reason.startsWith('no-surface')

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

    const storedModels = await $.store.get('model-usage-1')
    if (Array.isArray(storedModels)) await update($, modelUsageAtom, () => storedModels as ModelDay[])
    await update($, sessionModelsAtom, () => [])
    await update($, dedupedAtom, () => 0)
    inflight = []
    sessionStartedAt = await $.clock.now()

    const storedRuns = await $.store.get('runs-2')
    if (Array.isArray(storedRuns)) {
      const now = await $.clock.now()
      await update($, runsAtom, () =>
        (storedRuns as Run[]).map(r => (r.status === 'running' ? { ...r, status: 'unknown' as const } : r)),
      )
    }

    await $.command.register({
      name: 'subagents',
      description: 'เปิด/ปิดแผง sub-agents (on/off = เปิดปิดการใช้ sub-agents, band = ซ่อน/แสดงแถบเหนือช่องพิมพ์)',
      argumentHint: '[on|off|band]',
    })
    let notice = ''
    for (const role of ROLES) {
      await syncAgent($, role.id, cfg).catch(err => {
        notice = `ลงทะเบียน ${ROLE_BY_ID[role.id].name} ไม่ได้: ${String((err as Error)?.message ?? err).slice(0, 120)}`
      })
    }

    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(p => p.id === PANE)) {
      await update($, paneOpenAtom, () => true)
    } else {
      const opened = await openPane($)
      // no-surface ตอนเริ่ม session เป็นเรื่องปกติในแอป desktop: แผงยังเปิดค้างไว้
      // และจะถูกวาดเองเมื่อ surface ต่อเข้ามา (session.attach) — ไม่ต้องเตือน
      if (!opened.isPlaced && !isNoSurface(opened.reason)) {
        notice = notice || `แผง sub-agents ยังแสดงไม่ได้: ${opened.reason}`
      }
    }
    await update($, noticeAtom, () => notice)

    await refreshUsage($).catch(() => undefined)
    const acct = await loadAccount($).catch((): AccountInfo => ({ source: 'none' }))
    await update($, accountAtom, () => acct)
    return next(e)
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setConfig($, c => ({ ...c, enabled: arg === 'on' }))
      return { text: arg === 'on' ? 'sub-agents: เปิดใช้งานแล้ว' : 'sub-agents: ปิดแล้ว Claude จะทำงานเองใน thread หลัก' }
    }
    if (arg === 'band') {
      const v = await setConfig($, c => ({ ...c, bandHidden: !c.bandHidden }))
      return { text: v.bandHidden ? 'ซ่อนแถบ sub-agents เหนือช่องพิมพ์แล้ว' : 'แสดงแถบ sub-agents เหนือช่องพิมพ์แล้ว' }
    }
    if (await read($, paneOpenAtom)) {
      await closePane($)
      return { text: 'ปิดแผง sub-agents แล้ว' }
    }
    const opened = await openPane($)
    return {
      text: opened.isPlaced ? 'เปิดแผง sub-agents แล้ว' : `แผง sub-agents ยังแสดงไม่ได้: ${opened.reason}`,
    }
  })

  // surface ต่อเข้ามาทีหลัง session.start: ล้างคำเตือนเรื่องแผงที่ค้างอยู่ (ถ้ามี)
  on('session.attach', async ($, e, next) => {
    const res = await next(e)
    const notice = await read($, noticeAtom)
    if (notice.startsWith('แผง sub-agents ยังแสดงไม่ได้')) await update($, noticeAtom, () => '')
    return res
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

  // ทางหลัก: ต่อท้ายคำอธิบายของ Agent tool (ที่เดียวกับคำแนะนำเดิม "ไม่แน่ใจก็อย่า spawn")
  // เพราะ prompt.compose อาจถูก plugin อื่นที่รันก่อนข้ามไป (เช่น cc-plugin-sec-default)
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const res = await next(e)
    const text = delegationPolicy(await read($, configAtom))
    return text ? { ...res, description: `${res.description}\n\n${text}` } : res
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
    // บล็อกแล้วไม่บันทึกลงประวัติ (ผู้ใช้ไม่ต้องการเห็น) — Claude ยังได้เหตุผลไปทำเองต่อ
    const deny = async (reason: string) => ({ deny: reason })

    if (!cfg.enabled) return deny('ผู้ใช้ปิด sub-agents ไว้ ให้ทำงานนี้เองใน thread หลัก')
    if (role && rule && !rule.enabled && e.subagentType.startsWith(AGENT_PREFIX)) {
      return deny(`ผู้ใช้ปิด role ${ROLE_BY_ID[role].name} ไว้ ให้ทำงานนี้เองหรือใช้ role อื่น`)
    }
    if (cfg.maxParallel > 0) {
      const running = (await read($, runsAtom)).filter(r => isLive(r, now)).length
      if (running >= cfg.maxParallel) {
        return deny(`มี sub-agents ทำงานอยู่ ${running} ตัว ครบจำนวนที่ผู้ใช้อนุญาตแล้ว รอให้ตัวที่ทำอยู่เสร็จก่อน`)
      }
    }

    const key = taskKey(e.description, e.prompt)
    // agent ลูกที่ sub-agent แตกเอง: ไม่เทียบ (ปัญหางานซ้ำเกิดที่ thread หลัก และลูกส่งข้อความหา agent สายอื่นไม่ได้)
    const guard = !e.fork && e.parentAgentId === undefined
    let slot: string | undefined
    if (guard) {
      const runs = await read($, runsAtom)
      const live = await liveAgents($, runs, now)
      // ตรวจ + จองช่องแบบ synchronous (ห้ามมี await คั่น) เพื่อให้ call ที่มาพร้อมกันเห็นกัน
      const dup = findDuplicate(
        { type: e.subagentType, description: e.description, key },
        [...live, ...inflight],
        runs,
        now,
        sessionStartedAt,
      )
      if (dup) {
        try {
          $.ui.toast(`กันงานซ้ำ: "${e.description}" ซ้ำกับ "${dup.description}" ${dup.kind === 'running' ? 'ที่กำลังทำอยู่' : 'ที่เพิ่งเสร็จ'}`)
        } catch {
          // surface ที่ไม่มี toast
        }
        await update($, dedupedAtom, n => n + 1)
        return deny(duplicateReason(dup, now))
      }
      slot = `inflight-${++inflightSeq}`
      inflight.push({ id: slot, description: e.description, type: e.subagentType, status: 'pending', key })
    }

    let model = e.model
    if (!e.fork && rule && rule.enabled) {
      model = rule.model === 'inherit' ? e.parentModel : rule.model
      if (cfg.saverAt > 0) {
        const five = (await read($, usageAtom)).limits.find(l => l.kind === 'five_hour')
        if (five && five.percent >= cfg.saverAt) model = 'claude-haiku-5-5'
      }
    }

    let res: Awaited<ReturnType<typeof next>>
    try {
      res = await next({ ...e, model })
      if (res.deny === undefined && res.agentId !== undefined) {
        const agentId = res.agentId
        await setRuns($, runs => [...runs, { ...base, agentId, model: res.model, key }])
      }
    } finally {
      if (slot) inflight = inflight.filter(x => x.id !== slot)
    }
    return res
  })

  // เก็บ token ของแต่ละ sub-agent ทุกครั้งที่ loop ของมันจบ turn
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    const u = e.usage
    const now = await $.clock.now()
    if (id === undefined) {
      if (u) await recordMainUsage($, now, u)
      return result
    }
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
    const cfg = await read($, configAtom)
    if (cfg.bandHidden) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const usage = await read($, usageAtom)
    const paneOpen = await read($, paneOpenAtom)
    const five = usage.limits.find(l => l.kind === 'five_hour')
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
        {/* ซ้าย: สถานะและตัวสวิตช์ของ sub-agents เอง */}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text>
            <Text color={cfg.enabled ? 'success' : 'inactive'}>{cfg.enabled ? '●' : '○'}</Text>
            <Text bold> sub-agents</Text>
            <Text dimColor> · {cfg.enabled ? 'ใช้งานอยู่' : 'ปิดอยู่'}</Text>
          </Text>
          <Button
            key="band:toggle"
            variant={cfg.enabled ? 'secondary' : 'primary'}
            dimColor={cfg.enabled}
            onPress={() => setConfig($, c => ({ ...c, enabled: !c.enabled }))}>
            {cfg.enabled ? 'ปิด sub-agents' : 'เปิด sub-agents'}
          </Button>
          {five && <Text dimColor>· usage 5 ชม. {Math.round(five.percent)}%</Text>}
        </Box>
        {/* ขวา: ปุ่มเกี่ยวกับการแสดงผล เรียงจากแผงไปแถบ; ปุ่มซ่อนแถบอยู่ขวาสุดคนเดียว */}
        <Box flexDirection="row" gap={1} alignItems="center">
          {/* แผงเปิดอยู่ = ไม่ต้องมีปุ่ม (ปิดได้จากปุ่มปิดของแผงเอง); ปิดอยู่ถึงแสดงปุ่มเปิด */}
          {!paneOpen && (
            <Button key="band:pane" variant="primary" onPress={() => openPane($)}>
              แสดงแผง
            </Button>
          )}
          <Button key="band:hide" plain dimColor onPress={() => hideBand($)}>
            ✕
          </Button>
        </Box>
      </Box>
    )
  })

  // ---------- แผง ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    // ธีมมืดแบบการ์ด (แบบที่ 3) วาดบนพื้นที่มี Svg; terminal คงหน้าตาเดิม
    const rich = Svg !== undefined
    const tab = await read($, tabAtom)
    const cfg = await read($, configAtom)
    const runs = await read($, runsAtom)
    const usage = await read($, usageAtom)
    const acct = await read($, accountAtom)
    const range = await read($, rangeAtom)
    const notice = await read($, noticeAtom)
    const deduped = await read($, dedupedAtom)
    const storedDays = await read($, modelUsageAtom)
    const sessionDays = await read($, sessionModelsAtom)
    const mainDays = range === 'session' ? sessionDays : storedDays
    const now = await $.clock.now()
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 50
    const barW = Math.max(8, Math.min(20, cols - 26))
    const live = runs.filter(r => isLive(r, now))

    // การ์ดและตัวอักษรใช้สีตามธีมของแอป (สว่าง/มืดตามที่ผู้ใช้ตั้ง)
    const txt = undefined
    const mut = undefined
    // ข้อความรอง: rich ใช้สีเทาฟ้า, terminal ใช้ dim แบบเดิม
    const dimP = { dimColor: true as const }

    const lbl = (s: string) => s

    const svg = (source: string, alt: string, width?: number, height?: number) =>
      Svg ? <Svg source={source} alt={alt} width={width} height={height} /> : null
    // ปุ่ม native ของแอปใช้สีตามธีมแอป: บนพื้นมืดใช้ primary (พื้นทึบ ตัวขาว) ทุกปุ่ม แล้วใช้ dim แยกตัวรอง
    const variant = (main: boolean): 'primary' | 'secondary' => (main ? 'primary' : 'secondary')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const card = (key: string, children: any, marginTop = 1) =>
      rich ? (
        <Box
          key={key}
          flexDirection="column"
          borderStyle="round"
          paddingX={2}
          paddingY={1}
          gap={1}
          marginTop={marginTop}
        >
          {children}
        </Box>
      ) : (
        <Box key={key} flexDirection="column">
          {children}
        </Box>
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const heading = (title: string, hint?: string, icon?: string, right?: any) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap" marginTop={rich ? 0 : 2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {icon && svg(icon, title, 18, 18)}
            <Text bold color={txt}>
              {title}
            </Text>
          </Box>
          {hint && <Text {...dimP}>{hint}</Text>}
        </Box>
        {right ? <Box flexShrink={0}>{right}</Box> : null}
      </Box>
    )

    // แถวฟอร์ม: ป้าย (+คำอธิบาย) ชิดซ้าย ตัวควบคุมชิดขวา แยกกันชัด; แผงแคบตัวควบคุมลงบรรทัดใหม่
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const field = (key: string, label: any, control: any, hint?: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {typeof label === 'string' ? <Text color={txt}>{label}</Text> : label}
          {hint ? <Text {...dimP}>{hint}</Text> : null}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0} justifyContent="flex-end">
          {control}
        </Box>
      </Box>
    )

    // แถวมาตรวัด: ป้ายอยู่คอลัมน์ซ้ายกว้างคงที่ แถบกับคำอธิบายอยู่คอลัมน์ขวา จึงตรงกันเสมอ
    const LABEL_W = 16
    const meter = (
      key: string,
      label: string,
      pct: number,
      value: string,
      color: Color,
      sub?: string,
      extra?: string,
      icon?: string,
      grad?: [string, string],
    ) =>
      rich ? (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
              {icon && svg(icon, label, 18, 18)}
              <Text color={txt}>{label}</Text>
            </Box>
            <Text bold color={txt}>
              {value}
            </Text>
          </Box>
          {svg(barSvg(pct, 400, grad ?? [DARK.orange, DARK.claude]), `${label} ${value}`, undefined, BAR_H)}
          {sub ? <Text {...dimP}>{sub}</Text> : null}
          {extra ? <Text {...dimP}>{extra}</Text> : null}
        </Box>
      ) : (
      <Box key={key} flexDirection="row">
        <Box width={LABEL_W} flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
          {icon && svg(icon, label, 18, 18)}
          <Text color={txt}>{label}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text color={color}>{bar(pct, barW)}</Text>
          <Text color={txt}>
            <Text bold>{value}</Text>
            {sub ? <Text {...dimP}> · {sub}</Text> : null}
          </Text>
          {extra ? <Text {...dimP}>{extra}</Text> : null}
        </Box>
      </Box>
      )

    const statusLine = (
      <Text>
        <Text color={cfg.enabled ? (rich ? DARK.green : 'success') : 'inactive'}>{cfg.enabled ? '●' : '○'}</Text>
        <Text bold> {cfg.enabled ? 'ใช้งานอยู่' : 'ปิดอยู่'}</Text>
        <Text {...dimP}>  v{VERSION}</Text>
      </Text>
    )

    // ส่วนหัว: โลโก้ + ปุ่มเปิด/ปิด, แล้วสถานะ
    const status = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap={rich ? 'nowrap' : 'wrap'} gap={1}>
          {rich ? (
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
              {svg(LOGO_MARK, 'Claude', 24, 24)}
              <Text bold>Claude</Text>
            </Box>
          ) : null}
          {!rich && statusLine}
          <Button
            key="master"
            variant={variant(!cfg.enabled)}
            dimColor={cfg.enabled}
            onPress={() => setConfig($, c => ({ ...c, enabled: !c.enabled }))}
          >
            {lbl(cfg.enabled ? 'ปิด sub-agents' : 'เปิด sub-agents')}
          </Button>
        </Box>
        {rich && statusLine}
        {cfg.enabled && live.length > 0 && <Text {...dimP}>ทำงานอยู่ {live.length} ตัว</Text>}
        {deduped > 0 && <Text {...dimP}>กันงานซ้ำแล้ว {deduped} ครั้งใน session นี้</Text>}
        {notice && <Text color="warning">⚠ {notice}</Text>}
      </Box>
    )

    const tabRow = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {(
          [
            { id: 'models', label: 'โมเดล', hotkey: '1' },
            { id: 'agents', label: 'sub-agents', hotkey: '2' },
            { id: 'roles', label: 'ตั้งค่า', hotkey: '3' },
          ] as const
        ).map(t => (
          <Button
            key={`tab:${t.id}`}
            hotkey={t.hotkey}
            variant={variant(t.id === tab)}
            dimColor={rich && t.id !== tab}
            onPress={() => update($, tabAtom, (): Tab => t.id)}
          >
            {lbl(t.label)}
          </Button>
        ))}
      </Box>
    )
    const tabs = <Box marginTop={1}>{tabRow}</Box>

    const data = (() => {
      const plan = planName(acct)
      const startOfToday = startOfDay(now)
      const from =
        range === 'session' ? usage.startedAt : range === 'today' ? startOfToday : range === 'week' ? now - 7 * 86_400_000 : 0
      // ตัดรายการที่ถูกบล็อก (ของเก่าที่เคยบันทึกไว้) ออกจากทุกส่วนของแผง
      const list = runs.filter(r => r.startedAt >= from && r.status !== 'denied')
      const counted = list
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

      // token แยกตามโมเดล: thread หลัก (เก็บรายวัน) + sub-agents (จาก runs)
      const byModel = new Map<string, { main: number; sub: number }>()
      const slot = (m: string) => {
        const k = modelName(m)
        const g = byModel.get(k) ?? { main: 0, sub: 0 }
        byModel.set(k, g)
        return g
      }
      for (const d of mainDays) if (range === 'session' || d.at + DAY_MS > from) slot(d.model).main += modelTok(d)
      for (const r of counted) slot(r.model).sub += totalTok(r)
      const modelRows = [...byModel.entries()].sort((x, y) => y[1].main + y[1].sub - (x[1].main + x[1].sub))
      const maxModelTok = Math.max(1, ...modelRows.map(([, g]) => g.main + g.sub))
      return { plan, list, counted, roleRows, maxTok, recent, modelRows, maxModelTok }
    })()
    const { plan, counted, roleRows, maxTok, recent, modelRows, maxModelTok } = data

    // ราย 5 ชม.: engine ส่งมาเฉพาะรอบที่มีข้อมูลล่าสุด พอรอบหมดและยังไม่มีข้อความใหม่ รอบนี้จะหายไป
    // (หรือยังเป็นตัวเลขเก่าที่เลยเวลารีเซ็ตแล้ว) จึงแสดงเป็น 0% ไว้ให้เสมอเมื่อเป็นบัญชีที่มีขีดจำกัด
    const limits = (() => {
      if (usage.limits.length === 0) return usage.limits
      const fresh = usage.limits.map(l =>
        l.kind === 'five_hour' && l.resetsAt && Date.parse(l.resetsAt) <= now ? { ...l, percent: 0, resetsAt: undefined } : l,
      )
      return fresh.some(l => l.kind === 'five_hour')
        ? fresh
        : [{ kind: 'five_hour', percent: 0, resetsAt: undefined }, ...fresh]
    })()

    // วงแหวน usage (rich) หรือแถบแบบเดิม (terminal)
    const ringN = Math.max(1, limits.length + (usage.contextWindow > 0 ? 1 : 0))
    const ringPx = ringN <= 3 ? 72 : 60
    const limitGrad = (pct: number, kind: string): [string, string] =>
      pct >= 90 ? [DARK.red, '#f87171'] : pct >= 70 ? [DARK.amber, '#fbbf24'] : kind === 'five_hour' ? ['#22c55e', '#86efac'] : ['#16a34a', '#a3e635']
    const ring = (key: string, pct: number, value: string, label: string, grad: [string, string], sub?: string, extra?: string) => (
      <Box key={key} flexDirection="column" alignItems="center" flexGrow={1} flexShrink={1}>
        <Box position="relative" alignItems="center" justifyContent="center">
          {svg(ringSvg(pct, '', ringPx, grad), `${label} ${value}`)}
          <Box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center">
            <Text bold>{value}</Text>
          </Box>
        </Box>
        <Text color={txt}>{label}</Text>
        {sub ? <Text {...dimP}>{sub}</Text> : null}
        {extra ? <Text {...dimP}>{extra}</Text> : null}
      </Box>
    )

    const rangeSelect = (
      <Select key="range" options={RANGE_OPTS} value={range} onSelect={v => update($, rangeAtom, () => v as HistoryRange)} />
    )

    // ----- แท็บโมเดล: account + usage + การใช้ตามโมเดล -----
    const modelsTab = () => (
      <Box flexDirection="column">
        {card(
          'card:account',
          <Box flexDirection="row" gap={2} alignItems="center">
            {rich && svg(AVATAR_SVG, 'account', 44, 44)}
            <Box flexDirection="column" flexShrink={1}>
              {heading('Account')}
              {acct.source === 'none' ? (
                <Text {...dimP}>อ่านข้อมูล account ไม่ได้ (เช่น ใช้ API key หรือ cloud provider)</Text>
              ) : (
                <Box flexDirection="column" marginTop={rich ? 0 : 1}>
                  <Text color={txt}>
                    {acct.name ?? '-'}
                    {plan && <Text color={rich ? DARK.claude : 'claude'}> · {plan}</Text>}
                  </Text>
                  {acct.email && <Text {...dimP}>{acct.email}</Text>}
                  {acct.org && (
                    <Text {...dimP}>
                      {acct.org}
                      {acct.role ? ` · ${acct.role}` : ''}
                      {acct.extraUsage ? ' · extra usage เปิด' : ''}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          </Box>,
        )}

        {card('card:usage', [
          heading('Usage', undefined, ICON_USAGE),
          limits.length === 0 ? <Text {...dimP}>ยังไม่มีข้อมูล (จะขึ้นหลัง Claude ตอบครั้งแรก)</Text> : null,
          rich ? (
            <Box flexDirection="row" justifyContent="space-around" gap={1} flexWrap="wrap">
              {limits.map(l => {
                const [reset, left] = fmtReset(l.resetsAt, now, l.kind === 'five_hour')
                return ring(`lim:${l.kind}`, l.percent, `${Math.round(l.percent)}%`, LIMIT_LABEL[l.kind] ?? l.kind, limitGrad(l.percent, l.kind), left || reset || (l.kind === 'five_hour' ? 'ยังไม่เริ่มรอบใหม่' : undefined))
              })}
              {usage.contextWindow > 0 &&
                ring(
                  'context',
                  usage.contextPercent ?? 0,
                  `${Math.round(usage.contextPercent ?? 0)}%`,
                  'Context',
                  [DARK.blue, '#60a5fa'],
                  `${fmtTok(usage.contextTokens ?? 0)} / ${fmtTok(usage.contextWindow)}`,
                )}
            </Box>
          ) : (
            <Box flexDirection="column" gap={1}>
              {limits.map(l => {
                const [reset, left] = fmtReset(l.resetsAt, now, l.kind === 'five_hour')
                return meter(
                  `lim:${l.kind}`,
                  LIMIT_LABEL[l.kind] ?? l.kind,
                  l.percent,
                  `${Math.round(l.percent)}%`,
                  l.percent >= 90 ? 'error' : l.percent >= 70 ? 'warning' : 'success',
                  reset,
                  left,
                )
              })}
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
          ),
        ])}

        {card('card:models', [
          heading('การใช้ตามโมเดล', `รวม ${fmtTok(modelRows.reduce((t, [, g]) => t + g.main + g.sub, 0))} tokens`, ICON_CUBE, rangeSelect),
          modelRows.length === 0 ? <Text {...dimP}>ยังไม่มีข้อมูลในช่วงนี้ (เริ่มนับตั้งแต่ติดตั้งเวอร์ชันนี้)</Text> : null,
          modelRows.length > 0 ? (
            <Box flexDirection="column" gap={1}>
              {modelRows.map(([k, g]) => {
                const look = modelLook(k)
                return meter(
                  `model:${k}`,
                  k,
                  ((g.main + g.sub) / maxModelTok) * 100,
                  fmtTok(g.main + g.sub),
                  'claude',
                  `main ${fmtTok(g.main)} · sub-agents ${fmtTok(g.sub)}`,
                  undefined,
                  rich ? look.icon : undefined,
                  look.grad,
                )
              })}
            </Box>
          ) : null,
        ])}

        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button
            key="refresh"
            variant="secondary"
            dimColor
            onPress={async () => {
              await refreshUsage($)
              const a = await loadAccount($)
              await update($, accountAtom, () => a)
            }}
          >
            {lbl('รีเฟรช')}
          </Button>
        </Box>
      </Box>
    )

    // ----- แท็บ sub-agents: การใช้ + ประวัติ -----
    const agentsTab = () => (
      <Box flexDirection="column">
        {card('card:agentUse', [
          heading(
            'การใช้ sub-agents',
            `${counted.length} ครั้ง · ${fmtTok(counted.reduce((s, r) => s + totalTok(r), 0))} tokens`,
            ICON_USAGE,
            rangeSelect,
          ),
          roleRows.length > 0 ? (
            <Box flexDirection="column" gap={1}>
              {roleRows.map(([k, g]) =>
                meter(`role:${k}`, k, (g.tok / maxTok) * 100, fmtTok(g.tok), 'claude', `${g.n} ครั้ง · ${[...g.models].join(', ')}`, undefined, undefined, [
                  DARK.accent,
                  '#a78bfa',
                ]),
              )}
            </Box>
          ) : null,
        ])}

        {card('card:history', [
          heading('ประวัติล่าสุด', recent.length > 0 ? `${recent.length} รายการล่าสุด` : undefined),
          recent.length === 0 ? <Text {...dimP}>ยังไม่มี sub-agents ในช่วงนี้</Text> : null,
          ...recent.map(r => {
            const isOn = isLive(r, now)
            const st = r.status === 'running' && !isOn ? 'unknown' : r.status
            const stColor = rich
              ? st === 'running'
                ? DARK.blue
                : st === 'done'
                  ? DARK.green
                  : st === 'failed'
                    ? DARK.red
                    : DARK.muted
              : st === 'running'
                ? 'suggestion'
                : st === 'done'
                  ? 'success'
                  : st === 'failed'
                    ? 'error'
                    : 'inactive'
            return (
              <Box key={`run:${r.agentId}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                  <Text color={txt}>
                    <Text bold>{roleLabel(r.role)}</Text>
                    <Text {...dimP}> · {modelName(r.model)}</Text>
                  </Text>
                  <Text color={stColor}>{STATUS_LABEL[st]}</Text>
                </Box>
                <Text color={txt}>{r.description || r.type}</Text>
                <Text {...dimP}>
                  {range === 'week' || range === 'all' ? `${fmtDay(r.startedAt)} ` : ''}
                  {timeTh(r.startedAt)} · {fmtDur(r.durationMs || (isOn ? now - r.startedAt : 0))} · {fmtTok(totalTok(r))} tokens
                </Text>
                <Text {...dimP}>
                  {`in ${fmtTok(r.input)} · cache ${fmtTok(r.cacheRead + r.cacheWrite)} · out ${fmtTok(r.output)}`}
                </Text>
              </Box>
            )
          }),
        ])}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="clear" variant="secondary" dimColor onPress={() => setRuns($, () => [])}>
            {lbl('ล้างประวัติ')}
          </Button>
        </Box>
      </Box>
    )

    // ----- ตั้งค่า role: แถวละ role กระชับ ๆ -----
    const roles = () => (
      <Box flexDirection="column" marginTop={rich ? 0 : 1}>
        {card('card:roles', [
          heading('Role', 'กดชื่อเพื่อเปิด/ปิด · เลือกโมเดลและ effort ของแต่ละ role'),
          <Box flexDirection="column" gap={1}>
            {ROLES.map(def => {
              const rule = cfg.roles[def.id]
              return field(
                `row:${def.id}`,
                <Box flexDirection="row">
                    <Button key={`en:${def.id}`} plain onPress={() => setRole($, def.id, { enabled: !rule.enabled })}>
                      <Text color={rule.enabled ? (rich ? DARK.green : 'success') : 'inactive'}>{rule.enabled ? '●' : '○'}</Text>
                      <Text bold={rule.enabled} dimColor={!rich && !rule.enabled} color={rich ? (rule.enabled ? txt : mut) : undefined}>
                        {' '}
                        {def.name}
                      </Text>
                    </Button>
                </Box>,
                  rule.enabled ? (
                    [
                      <Select
                        key={`model:${def.id}`}
                        options={MODEL_OPTS}
                        value={rule.model}
                        onSelect={v => setRole($, def.id, { model: v as ModelChoice })}
                      />,
                      <Select
                        key={`effort:${def.id}`}
                        options={EFFORT_OPTS}
                        value={rule.effort}
                        onSelect={v => setRole($, def.id, { effort: v as EffortChoice })}
                      />,
                    ]
                  ) : (
                    <Text {...dimP}>ไม่ใช้</Text>
                  ),
              )
            })}
          </Box>,
        ])}

        {card('card:limits', [
          heading('ขีดจำกัด'),
          field(
            'f:saver',
            'โหมดประหยัด',
            <Select
              key="saver"
              options={SAVER_OPTS}
              value={String(cfg.saverAt)}
              onSelect={v => setConfig($, c => ({ ...c, saverAt: Number(v) }))}
            />,
            'ทุก role ใช้ Haiku เมื่อ usage 5 ชม. ถึงระดับนี้',
          ),
          field(
            'f:parallel',
            'ทำงานพร้อมกันสูงสุด',
            <Select
              key="maxParallel"
              options={PARALLEL_OPTS}
              value={String(cfg.maxParallel)}
              onSelect={v => setConfig($, c => ({ ...c, maxParallel: Number(v) }))}
            />,
            'จำนวน sub-agent ที่รันพร้อมกันได้',
          ),
        ])}

        {card('card:band', [
          heading(
            'แถบเหนือช่องพิมพ์',
            cfg.bandHidden ? 'ซ่อนอยู่' : 'แสดงอยู่',
            undefined,
            <Button
              key="bandToggle"
              variant={variant(cfg.bandHidden === true)}
              dimColor={!cfg.bandHidden}
              onPress={() => setConfig($, c => ({ ...c, bandHidden: !c.bandHidden }))}
            >
              {lbl(cfg.bandHidden ? 'แสดงแถบ' : 'ซ่อนแถบ')}
            </Button>,
          ),
        ])}

        <Box marginTop={1}>
          <Button
            key="reset"
            variant="secondary"
            dimColor
            onPress={async () => {
              const v = await setConfig($, c => ({ ...DEFAULT_CONFIG, enabled: c.enabled, bandHidden: c.bandHidden }))
              for (const r of ROLES) await syncAgent($, r.id, v)
            }}
          >
            {lbl('คืนค่าเริ่มต้น')}
          </Button>
        </Box>
      </Box>
    )

    return rich ? (
      <Box flexDirection="column" width="100%">
        {status}
        {tabs}
        {tab === 'roles' ? roles() : tab === 'agents' ? agentsTab() : modelsTab()}
      </Box>
    ) : (
      <Box flexDirection="column" paddingX={1}>
        {status}
        {tabs}
        {tab === 'roles' ? roles() : tab === 'agents' ? agentsTab() : modelsTab()}
      </Box>
    )
  })
}

// ---------- ธีมมืดของแผง (แบบที่ 3) ----------

const DARK = {
  bg: '#0e1726',
  card: '#152238',
  border: '#28395a',
  track: '#26364f',
  text: '#eef3fa',
  muted: '#9fb0c8',
  accent: '#6366f1',
  green: '#4ade80',
  blue: '#3b82f6',
  orange: '#f97316',
  claude: '#f0845a',
  purple: '#a855f7',
  amber: '#f59e0b',
  red: '#ef4444',
}

// รางของแถบ/วงแหวน: เทาโปร่ง เห็นได้ทั้งธีมสว่างและมืด
const TRACK = 'rgba(148,163,184,0.3)'

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"'

function asterisk(cx: number, cy: number, r: number, color: string, w: number): string {
  let d = ''
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6
    const len = i % 2 ? r * 0.78 : r
    d += `M${cx + Math.cos(a) * r * 0.18} ${cy + Math.sin(a) * r * 0.18}L${(cx + Math.cos(a) * len).toFixed(2)} ${(cy + Math.sin(a) * len).toFixed(2)}`
  }
  return `<path d="${d}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`
}

const LOGO_MARK = `<svg ${XMLNS} width="24" height="24" viewBox="0 0 36 40">${asterisk(18, 20, 16, DARK.claude, 3.4)}</svg>`

const AVATAR_SVG = `<svg ${XMLNS} width="44" height="44" viewBox="0 0 44 44"><defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4d6e"/><stop offset="1" stop-color="#253550"/></linearGradient></defs><circle cx="22" cy="22" r="22" fill="url(#a)"/><circle cx="22" cy="17" r="7" fill="#e6edf7"/><path d="M9 36c2-7 7-10 13-10s11 3 13 10z" fill="#e6edf7"/></svg>`

const ICON_USAGE = `<svg ${XMLNS} width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="8" width="3.5" height="8" rx="1" fill="#818cf8"/><rect x="7.25" y="3" width="3.5" height="13" rx="1" fill="#60a5fa"/><rect x="12.5" y="6" width="3.5" height="10" rx="1" fill="#818cf8"/></svg>`

const ICON_CUBE = `<svg ${XMLNS} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#a5b4fc" stroke-width="1.6" stroke-linejoin="round"><path d="M9 1.8l6.4 3.6v7.2L9 16.2 2.6 12.6V5.4z"/><path d="M2.6 5.4L9 9l6.4-3.6M9 9v7.2"/></svg>`

const MODEL_LOOKS: { match: RegExp; icon: string; grad: [string, string] }[] = [
  {
    match: /opus/i,
    icon: `<svg ${XMLNS} width="18" height="18" viewBox="0 0 18 18">${asterisk(9, 9, 8, DARK.orange, 1.8)}</svg>`,
    grad: ['#f97316', '#fb923c'],
  },
  {
    match: /haiku/i,
    icon: `<svg ${XMLNS} width="18" height="18" viewBox="0 0 18 18"><path d="M9 1C9.8 6 12 8.2 17 9 12 9.8 9.8 12 9 17 8.2 12 6 9.8 1 9 6 8.2 8.2 6 9 1z" fill="${DARK.purple}"/></svg>`,
    grad: ['#f97316', '#fb923c'],
  },
  {
    match: /sonnet/i,
    icon: `<svg ${XMLNS} width="18" height="18" viewBox="0 0 18 18"><path d="M9 1.5L16.5 9 9 16.5 1.5 9z" fill="${DARK.blue}"/></svg>`,
    grad: ['#3b82f6', '#60a5fa'],
  },
]

function modelLook(name: string): { icon: string; grad: [string, string] } {
  return (
    MODEL_LOOKS.find(m => m.match.test(name)) ?? {
      icon: `<svg ${XMLNS} width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="${DARK.muted}"/></svg>`,
      grad: ['#64748b', '#94a3b8'],
    }
  )
}

const BAR_H = 22
const BAR_Y = 7

function barSvg(pct: number, w: number, [c1, c2]: [string, string]): string {
  const p = Math.max(0, Math.min(100, pct))
  const fill = p > 0 ? Math.max(8, (p / 100) * w) : 0
  return `<svg ${XMLNS} width="${w}" height="${BAR_H}" viewBox="0 0 ${w} ${BAR_H}" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect y="${BAR_Y}" width="${w}" height="8" rx="4" fill="${TRACK}"/>${fill ? `<rect y="${BAR_Y}" width="${fill.toFixed(1)}" height="8" rx="4" fill="url(#g)"/>` : ''}</svg>`
}

function ringSvg(pct: number, value: string, size: number, [c1, c2]: [string, string]): string {
  const p = Math.max(0, Math.min(100, pct))
  const sw = Math.max(6, size * 0.085)
  const r = (size - sw) / 2 - 1
  const c = size / 2
  const len = 2 * Math.PI * r
  const font = Math.round(size * 0.22)
  return `<svg ${XMLNS} width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><circle cx="${c}" cy="${c}" r="${r.toFixed(1)}" fill="none" stroke="${TRACK}" stroke-width="${sw.toFixed(1)}"/>${p > 0 ? `<circle cx="${c}" cy="${c}" r="${r.toFixed(1)}" fill="none" stroke="url(#g)" stroke-width="${sw.toFixed(1)}" stroke-linecap="round" stroke-dasharray="${((p / 100) * len).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>` : ''}<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,Segoe UI,sans-serif" font-size="${font}" font-weight="700" fill="${DARK.text}">${value}</text></svg>`
}
