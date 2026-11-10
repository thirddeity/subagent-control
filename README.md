# subagent-control

Mod สำหรับ Claude Code ที่เพิ่มแผง **Sub-agents** ไว้ข้างแชท และแถบสถานะไว้เหนือช่องพิมพ์ ใช้ควบคุมว่า Claude จะแตกงานให้ sub-agent ไหม และงานแต่ละแบบใช้ model ไหน

A Claude Code mod that adds a Sub-agents pane: turn sub-agents on or off, pick a model and effort per role, and see account, usage and per-agent token history.

## ทำอะไรได้บ้าง

- **เปิด/ปิด sub-agents** ได้จากการ์ดสถานะในแผง จากแถบเหนือช่องพิมพ์ หรือใช้ `/subagents on` / `/subagents off` ถ้าปิดไว้ Claude จะทำทุกอย่างเองใน thread หลัก
- **ตั้งค่าตาม role** แต่ละ role เลือก model และความลึกในการคิด (effort) ได้

  | Role | หน้าที่ | ค่าเริ่มต้น |
  |---|---|---|
  | ที่ปรึกษา | วิเคราะห์ ออกแบบ วางแผน รีวิว (ไม่แก้ไฟล์) | Opus 5.5 · high |
  | นักสำรวจ | ค้นหาและอ่านโค้ด แล้วสรุป (ไม่แก้ไฟล์) | Haiku 5.5 · low |
  | นักเขียนโค้ด | แก้หรือเขียนโค้ดตามแผน | Sonnet 5.5 · medium |
  | ผู้รันงาน | รันคำสั่ง เทสต์ build แล้วสรุปผล (ไม่แก้ไฟล์) | Haiku 5.5 · low |

  ทั้ง 4 role ลงทะเบียนเป็น agent type (`subagent-control:advisor`, `:explorer`, `:coder`, `:runner`) ส่วน agent ในตัวจะถูกจับคู่กับ role อัตโนมัติ คือ Plan → ที่ปรึกษา, Explore → นักสำรวจ และ general-purpose จะดูจากเนื้องาน
- **ควบคุม usage** มีโหมดประหยัด (เมื่อ usage 5 ชั่วโมงถึงระดับที่ตั้ง ทุก role จะเปลี่ยนไปใช้ Haiku) และจำกัดจำนวน sub-agent ที่ทำงานพร้อมกันได้
- **ภาพรวม** แสดง account ที่ใช้อยู่, usage รอบ 5 ชั่วโมง / 7 วัน พร้อมเวลารีเซ็ต, context และประวัติ token ของ sub-agent แต่ละตัว (เก็บข้ามเซสชัน)

## ติดตั้ง

ที่ prompt ของ Claude Code ใน terminal:

```
/plugin install subagent-control --marketplace thirddeity/subagent-control
```

ตอบ `y` เพื่อเพิ่ม marketplace แล้วกด Enter เพื่อเลือก scope (user)

จาก shell:

```bash
claude plugin install subagent-control --marketplace thirddeity/subagent-control
```

ใน desktop app (ที่ใช้ `/plugin` ไม่ได้): กด + ข้างช่องพิมพ์ → Plugins → Add marketplace ใส่ `thirddeity/subagent-control` แล้ว Add plugin

## หมายเหตุ

- **Account:** อ่านจากไฟล์ `.claude.json` ในเครื่อง (ไม่ส่งข้อมูลออกไปไหน) ถ้าใช้ API key หรือ cloud provider จะไม่มีข้อมูลส่วนนี้
- **Effort:** มีผลเมื่อ Claude เรียก role ของ mod นี้โดยตรง ส่วน agent ในตัวจะถูกเปลี่ยนแค่ model
- **Workflow:** agent ที่ workflow แตกออกมา และ agent ที่ resume ต่อจากเดิม ไม่ถูกกฎของ mod นี้
