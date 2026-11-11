import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-control',
  component: 'Pane',
  requestId: 'subagent-control',
  props: {
    title: 'Sub-agents',
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
    expect(spawned).toBe(0)

    await ui.press({ key: 'master' })
    await ui.unmount()
  }
})

test('role กำหนด model: Plan→ที่ปรึกษา, งานรันเทสต์→ผู้รันงาน', async ($, on) => {
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
  await $.agent.spawn(spawnArgs('general-purpose', 'run the tests'))
  expect(models[2]).toBe('claude-sonnet-5-5')

  await ui.press({ key: 'tab:overview' })
  expect((await ui.find({ type: 'Text', text: /ออกแบบ API/ }))?.text).toContain('ออกแบบ API')
  await ui.unmount()
})

test('เปิดอยู่ = system prompt สั่งให้ใช้ sub-agent, ปิด/ไม่มี Agent tool = ไม่ใส่', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'core', scope: 'shared' as const }] }))
  on('store.set', () => ({ value: undefined }))
  on('agent.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.now() }))
  const policy = async (tools: string[]) =>
    (await $.prompt.compose({ tools, model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], outputStyle: null, traits: [] })).sections.find(s => s.id === 'subagent-control:policy')

  const on1 = await policy(['Agent', 'Read'])
  expect(on1?.text).toContain('subagent-control:explorer')
  expect(on1?.text).toContain('subagent-control:runner')
  expect(await policy(['Read'])).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:roles' })
  await ui.press({ key: 'en:runner' })
  expect((await policy(['Agent']))?.text).not.toContain('subagent-control:runner')

  await ui.press({ key: 'master' })
  expect(await policy(['Agent'])).toBeUndefined()
  await ui.unmount()
})
