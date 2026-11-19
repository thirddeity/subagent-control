#!/bin/bash
# บอกว่าแอป Claude desktop แต่ละตัวโหลด subagent-control จากไหน และเวอร์ชันอะไร
#   ./check-remote.sh [เวอร์ชันที่ควรเป็น]
# ตัวจาก claude.ai (remote) ชนะตัวในเครื่องเสมอ: ถ้า remote เก่า ต้องอัป/publish เวอร์ชันใหม่บน claude.ai เอง
want="${1:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$(dirname "$0")/.claude-plugin/plugin.json" | head -1)}"
stale=0
for f in "$HOME/Library/Application Support"/Claude*/plugin-list/*/*/plugins.json; do
  [ -f "$f" ] || continue
  app=$(echo "$f" | sed -E 's#.*/Application Support/([^/]+)/.*#\1#')
  while IFS=$'\t' read -r id path; do
    [ -n "$id" ] || continue
    v=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$path/.claude-plugin/plugin.json" 2>/dev/null | head -1)
    if [ "$v" = "$want" ]; then
      echo "✓ $app: $id = $v"
    else
      stale=1
      echo "✗ $app: $id = ${v:-?} (ควรเป็น $want) — แอปนี้ใช้ตัวนี้แทนตัวในเครื่อง"
    fi
  done < <(python3 -c '
import json,sys
def walk(o):
  if isinstance(o,dict):
    if o.get("name")=="subagent-control" and "installPath" in o: print(o.get("id",""),o["installPath"],sep="\t")
    for v in o.values(): walk(v)
  elif isinstance(o,list):
    for v in o: walk(v)
walk(json.load(open(sys.argv[1])))' "$f")
done
if [ "$stale" = 1 ]; then
  echo "→ อัปไฟล์เวอร์ชัน $want ขึ้น claude.ai (Customize › Plugins) แล้ว publish เข้า org หรือลบ upload เก่าทิ้ง จากนั้นปิดแล้วเปิดแอปใหม่ / เปิด session ใหม่"
  exit 1
fi
