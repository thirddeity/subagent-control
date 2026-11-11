#!/bin/bash
# ปล่อยเวอร์ชันใหม่ของ subagent-control ให้ทุกเครื่อง/ทุกบัญชีอัปเดตเอง
#   ./release.sh "อธิบายสิ่งที่แก้"
# ทำ: เพิ่มเลข version (ถ้ายังไม่ได้เพิ่ม) → validate + test → commit → push
# เครื่องที่ติดตั้งจาก marketplace นี้และเปิด autoUpdate จะดึงเวอร์ชันใหม่เองหลังข้อความแรกของ session (≤ 10 นาที)
set -euo pipefail
cd "$(dirname "$0")"
MANIFEST=.claude-plugin/plugin.json

msg="${1:-}"
[ -n "$msg" ] || { echo 'ใส่ข้อความด้วย เช่น: ./release.sh "แก้ให้ใช้ sub-agent จริง"' >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "ต้องอยู่ branch main" >&2; exit 1; }

git fetch -q origin main
if [ -n "$(git rev-list HEAD..origin/main)" ]; then
  echo "GitHub มี commit ใหม่กว่าเครื่องนี้ — รัน git pull ก่อน" >&2; exit 1
fi
if [ -z "$(git status --porcelain)" ] && [ -z "$(git rev-list origin/main..HEAD)" ]; then
  echo "ไม่มีอะไรเปลี่ยน"; exit 0
fi

ver() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }
cur=$(ver "$MANIFEST")
pub=$(git show "origin/main:$MANIFEST" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
# version ต้องเปลี่ยน ไม่งั้นเครื่องอื่นไม่ดึงของใหม่ (cache ตาม version)
if [ "$cur" = "$pub" ]; then
  IFS=. read -r a b c <<<"$cur"
  cur="$a.$b.$((c + 1))"
  perl -pi -e "s/(\"version\"\\s*:\\s*\")[^\"]*/\${1}$cur/" "$MANIFEST"
fi
echo "เวอร์ชัน: $pub → $cur"

claude plugin validate . >/dev/null
claude plugin test .

echo
git status --short
printf 'commit + push ไฟล์ข้างบนเป็น %s ? [y/N] ' "$cur"
read -r yn
case "$yn" in y|Y) ;; *) echo "ยกเลิก (ไฟล์ยังอยู่เหมือนเดิม)"; exit 1 ;; esac

git add -A
git commit -q -m "$msg, bump to $cur"
git push -q origin main
echo "ปล่อย $cur แล้ว — ทุกเครื่องที่เปิด auto-update จะได้เวอร์ชันนี้ใน session ถัดไป"
