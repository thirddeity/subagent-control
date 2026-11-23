import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-control',
  component: 'Pane',
  requestId: 'subagent-control',
  props: {
    title: 'sub-agents',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const spawnArgs = (subagentType: string, description: string) =>
  ({ prompt: description, subagentType, description }) as never

test('ปิด sub-agents แล้วสถานะชัด และ spawn ถูกบล็อก', async ($, on) => {
  let spawned = 0
  on('agent.spawn', (_, e) => {
    spawned++
    return { model: e.model ?? 'x', agentId: 'a1' }
  })
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /ใช้งานอยู่/ }))?.text).toContain('● ใช้งานอยู่')
    expect((await ui.find({ type: 'Button', key: 'master' }))?.text).toContain('ปิด sub-agents')

    await ui.press({ key: 'master' })
    expect((await ui.find({ type: 'Text', text: /ปิดอยู่/ }))?.text).toContain('○ ปิดอยู่')
    expect((await ui.find({ type: 'Button', key: 'master' }))?.text).toContain('เปิด sub-agents')

    const res = await $.agent.spawn(spawnArgs('Explore', 'ค้นไฟล์'))
    expect(res.deny).toBeDefined()
    await ui.press({ key: 'tab:agents' }).catch(() => undefined)
    expect(await ui.find({ type: 'Text', text: /ถูกบล็อก/ })).toBeUndefined()
    expect(spawned).toBe(0)

    await ui.press({ key: 'master' })
    await ui.unmount()
  }
})

test('role กำหนด model: Plan→วางแผน, งานรันเทสต์→รันเทสต์', async ($, on) => {
  const models: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    models.push(e.model)
    return { model: e.model ?? 'x', agentId: `a${models.length}` }
  })
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.agent.spawn(spawnArgs('Plan', 'ออกแบบ API'))
  await $.agent.spawn(spawnArgs('general-purpose', 'run the tests'))
  expect(models).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])

  await ui.press({ key: 'tab:roles' })
  await ui.select({ key: 'model:runner', value: 'claude-sonnet-5-5' })
  // งานรันอื่น (สั่ง "run the tests" ซ้ำจะโดนกันงานซ้ำ เพราะตัวก่อนยังทำอยู่)
  await $.agent.spawn(spawnArgs('general-purpose', 'build docs site'))
  expect(models[2]).toBe('claude-sonnet-5-5')

  await ui.press({ key: 'tab:agents' })
  expect((await ui.find({ type: 'Text', text: /ออกแบบ API/ }))?.text).toContain('ออกแบบ API')
  await ui.unmount()
})

test('คำอธิบาย Agent tool มีคำสั่งให้ใช้ sub-agent ตอนเปิด', async ($, on) => {
  on('tool.describe', (_, e) => ({ description: e.description }))
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))
  const describe = async () =>
    (await $.tool.describe({ tool: 'Agent', description: 'Launch a new agent.', provider: { plugin: 'engine', tier: 'core' } } as never)).description

  expect(await describe()).toContain('subagent-control:explorer')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'master' })
  expect(await describe()).toBe('Launch a new agent.')
  await ui.unmount()
})

test('แท็บโมเดลแยก token ตาม model (thread หลัก + sub-agents)', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))
  on('turn.complete', () => ({ text: 'ok' }) as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:models' })
  await ui.select({ key: 'range', value: 'all' })

  const turn = (model: string, input: number, output: number) =>
    $.turn.complete({
      reason: 'answer',
      answer: 'ok',
      durationMs: 10,
      usage: { model, input_tokens: input, output_tokens: output },
    } as never)
  await turn('claude-opus-5-5', 1000, 500)
  await turn('claude-opus-5-5', 500, 0)
  await turn('claude-haiku-5-5', 200, 100)

  const opus = await ui.find({ type: 'Text', text: /main 2k/ })
  expect(opus?.text).toContain('main 2k')
  expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'subagent-control',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
  },
} as const

test('ปุ่มซ่อนแถบเหนือช่องพิมพ์ และแสดงคืนจากแผง', async ($, on) => {
  // engine วาดแถบว่างเมื่อ mod ส่งต่อ
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect(await band.find({ type: 'Button', key: 'band:toggle' })).toBeDefined()
  await band.press({ key: 'band:hide' })
  expect(await band.find({ type: 'Button', key: 'band:toggle' })).toBeUndefined()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab:roles' })
  expect((await pane.find({ type: 'Button', key: 'bandToggle' }))?.text).toContain('แสดงแถบ')
  await pane.press({ key: 'bandToggle' })
  expect(await band.find({ type: 'Button', key: 'band:toggle' })).toBeDefined()
  await pane.unmount()
  await band.unmount()
})

test('กันงานซ้ำ: งานเดียวกับตัวที่กำลังทำถูกบล็อก งานต่างเป้าหมายผ่าน', async ($, on) => {
  const live: { id: string; description: string; type: string; status: string; name?: string }[] = []
  let n = 0
  on('agent.spawn', (_, e) => {
    n++
    live.push({ id: `a${n}`, description: e.description, type: e.subagentType, status: 'running', name: `bg${n}` })
    return { model: e.model ?? 'x', agentId: `a${n}` }
  })
  on('agent.list', () => ({ value: live }) as never)
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))
  on('ui.toast', () => ({ value: undefined }) as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const review = (d: string, p: string) =>
    $.agent.spawn({ prompt: p, subagentType: 'subagent-control:advisor', description: d } as never)

  expect((await review('รีวิว xray', 'Review src/xray/index.ts')).deny).toBeUndefined()
  expect((await review('รีวิว phr', 'Review src/phr/index.ts')).deny).toBeUndefined()

  // ซ้ำตรง ๆ และซ้ำแบบเปลี่ยนคำนิดหน่อยแต่ไฟล์เดิม
  const again = await review('รีวิว xray', 'Review src/xray/index.ts again')
  expect(again.deny).toContain('a1')
  const reword = await review('ตรวจซ้ำ xray', 'Check src/xray/index.ts')
  expect(reword.deny).toContain('a1')

  // role อื่น (coder) ทำไฟล์เดียวกันได้
  const fix = await $.agent.spawn({
    prompt: 'Fix src/xray/index.ts',
    subagentType: 'subagent-control:coder',
    description: 'แก้ xray',
  } as never)
  expect(fix.deny).toBeUndefined()

  await ui.unmount()

  // กันงานซ้ำเปิดเสมอ ไม่มีสวิตช์ให้ปิด; งานต่างไฟล์ผ่านได้ตามปกติ
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui2.press({ key: 'tab:roles' })
  expect(await ui2.find({ type: 'Button', key: 'dedupeToggle' })).toBeUndefined()
  expect((await review('รีวิว zeta', 'Review src/zeta/index.ts')).deny).toBeUndefined()
  await ui2.unmount()
  expect(n).toBe(4)
})

test('กันงานซ้ำ: spawn พร้อมกัน, waiting, เพิ่งเสร็จ, Task 1/2 ที่อ้างแผนเดียวกัน', async ($, on) => {
  const live: { id: string; description: string; type: string; status: string }[] = []
  let n = 0
  on('agent.spawn', async (_, e) => {
    n++
    const id = `a${n}`
    await new Promise(r => setTimeout(r, 5)) // engine ใช้เวลาเริ่ม agent: call ที่มาพร้อมกันต้องเห็นกัน
    live.push({ id, description: e.description, type: e.subagentType, status: 'running' })
    return { model: e.model ?? 'x', agentId: id }
  })
  on('agent.list', () => ({ value: live }) as never)
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const sp = (type: string, d: string, p: string) =>
    $.agent.spawn({ prompt: p, subagentType: `subagent-control:${type}`, description: d } as never)

  // Agent call 4 ตัวในข้อความเดียวที่ตรวจ batch เดียวกัน: ผ่านแค่ตัวเดียว
  const four = await Promise.all([1, 2, 3, 4].map(() => sp('advisor', 'ตรวจ batch แรก', 'Review src/a.ts src/b.ts')))
  expect(four.filter(r => r.deny === undefined).length).toBe(1)

  // ตัวที่ waiting ยังนับว่าทำงานอยู่
  live[0].status = 'waiting'
  expect((await sp('advisor', 'ตรวจ batch แรก', 'Review src/a.ts src/b.ts')).deny).toContain('a1')

  // งานต่อเนื่องตามแผนเดียวกัน (Task 1 / Task 2 อ้าง plan.md ร่วม) ผ่านทั้งคู่
  expect((await sp('coder', 'Implement Task 1', 'Follow docs/plan.md, edit src/x.ts')).deny).toBeUndefined()
  expect((await sp('coder', 'Implement Task 2', 'Follow docs/plan.md, edit src/y.ts')).deny).toBeUndefined()

  // รีวิวเสร็จแล้ว (list ยังเก็บไว้เป็น completed): สั่งรีวิว batch เดิมซ้ำทันทีถูกบล็อก
  live[0].status = 'completed'
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'ok', isAborted: false, turnId: 't1', durationMs: 10 } as never)
  const again = await sp('advisor', 'ตรวจ batch แรก', 'Review src/a.ts src/b.ts')
  expect(again.deny).toContain('เพิ่งทำเสร็จ')
  await ui.unmount()
})

test('role ค้นคว้า: ค่าเริ่มต้น Sonnet, จับงานค้นคว้า/อ่าน docs แต่ไม่จับงานเขียนเอกสาร, อยู่ในคำสั่งร่วมงาน', async ($, on) => {
  const models: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    models.push(e.model)
    return { model: e.model ?? 'x', agentId: `a${models.length}` }
  })
  on('tool.describe', (_, e) => ({ description: e.description }))
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:roles' })
  // เปลี่ยน researcher เป็น Haiku เพื่อแยกจาก coder (Sonnet) ในผลลัพธ์
  await ui.select({ key: 'model:researcher', value: 'claude-haiku-5-5' })

  await $.agent.spawn(spawnArgs('general-purpose', 'research how the official docs describe rate limits'))
  await $.agent.spawn(spawnArgs('general-purpose', 'อ่านเอกสารของ library แล้วสรุป'))
  await $.agent.spawn(spawnArgs('subagent-control:researcher', 'look up changelog'))
  await $.agent.spawn(spawnArgs('general-purpose', 'write the README docs section'))
  expect(models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])

  const text = (await $.tool.describe({ tool: 'Agent', description: 'Launch a new agent.', provider: { plugin: 'engine', tier: 'core' } } as never)).description
  expect(text).toContain('subagent-control:researcher')
  expect(text).toContain('researcher')
  expect(text).toContain('advisor')
  await ui.unmount()
})
