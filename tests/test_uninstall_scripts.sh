#!/bin/bash
# tests/test_uninstall_scripts.sh — 卸载脚本沙箱测试
#
# 铁律：验证删除类脚本时，TRIM_PKGVAR / TRIM_APPDEST 必须指向沙箱，
# 绝不把真实的 /vol*/@appdata/fnproc 作为删除类调用的输入。
#
# 覆盖：
#   ① keep 分支：数据保留、socket 仍被清理
#   ② delete 分支：数据目录整棵删除
#   ③ 路径守卫：TRIM_PKGVAR 形态不符时拒绝删除
#   ④ dryrun：演练模式一个字节都不删
#   ⑤ wizard_clear_notify 各取值形态的决策
#   ⑥ uninstall_init：停掉残留采集进程（不误杀同名不同路径进程）
#   ⑦ 两个脚本均可通过 bash -n

set -u
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT="${SRC_DIR}/cmd/uninstall_init"
CB="${SRC_DIR}/cmd/uninstall_callback"
SBX="/tmp/fnproc-uninst-test"
pass=0; fail=0

ok()   { pass=$((pass+1)); printf '  ✔ %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  ✖ %s\n' "$1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

make_sandbox() {
  rm -rf "$SBX"; mkdir -p "$SBX/@appdata/fnproc/data" "$SBX/@appcenter/fnproc/ui"
  for f in history.db audit.db alerts.db snapshots.db; do : > "$SBX/@appdata/fnproc/data/$f"; done
  : > "$SBX/@appdata/fnproc/data/history.jsonl"
  : > "$SBX/@appdata/fnproc/data/history.db-wal"
  : > "$SBX/@appdata/fnproc/info.log"
  : > "$SBX/@appcenter/fnproc/fnproc.sock"
}

printf '\n[1] 语法检查\n'
check "uninstall_init 语法"   'bash -n "$INIT" 2>/dev/null'
check "uninstall_callback 语法" 'bash -n "$CB" 2>/dev/null'

printf '\n[2] keep 分支：保留数据，清理 socket\n'
make_sandbox
OUT="$(TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
      wizard_data_action=keep wizard_clear_notify=false bash "$CB" 2>&1)"
check "数据目录仍在"        '[ -d "$SBX/@appdata/fnproc" ]'
check "history.db 仍在"     '[ -f "$SBX/@appdata/fnproc/data/history.db" ]'
check "socket 已删除"       '[ ! -e "$SBX/@appcenter/fnproc/fnproc.sock" ]'
check "日志说明保留了数据"   'printf "%s" "$OUT" | grep -q "已保留应用数据目录"'
check "日志说明保留通知"     'printf "%s" "$OUT" | grep -q "按用户选择保留系统通知"'

printf '\n[3] delete 分支：整棵删除数据\n'
make_sandbox
OUT="$(TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
      wizard_data_action=delete wizard_clear_notify=false bash "$CB" 2>&1)"
check "数据目录已删除"      '[ ! -d "$SBX/@appdata/fnproc" ]'
check "父目录未被误删"      '[ -d "$SBX/@appdata" ]'
check "日志说明已删除"      'printf "%s" "$OUT" | grep -q "已删除应用数据目录"'

printf '\n[4] 路径守卫：形态不符一律拒绝\n'
rm -rf "$SBX"; mkdir -p "$SBX/not-appdata/fnproc/data"
: > "$SBX/not-appdata/fnproc/data/history.db"
OUT="$(TRIM_PKGVAR="$SBX/not-appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
      wizard_data_action=delete wizard_clear_notify=false bash "$CB" 2>&1)"
check "拒绝删除（目录仍在）" '[ -d "$SBX/not-appdata/fnproc" ]'
check "日志给出拒绝原因"     'printf "%s" "$OUT" | grep -q "拒绝删除：路径不符"'

printf '\n[5] 演练模式：一个字节都不删\n'
make_sandbox
OUT="$(FNPROC_UNINSTALL_DRYRUN=1 TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
      wizard_data_action=delete wizard_clear_notify=false bash "$CB" 2>&1)"
check "数据目录仍在"        '[ -d "$SBX/@appdata/fnproc" ]'
check "socket 仍在"         '[ -e "$SBX/@appcenter/fnproc/fnproc.sock" ]'
check "输出标注了演练"       'printf "%s" "$OUT" | grep -q "演练模式"'
check "输出了将执行的动作"   'printf "%s" "$OUT" | grep -q "\[演练\] 将执行: rm -rf"'
# 演练报告不能出现既成事实的措辞，否则用户会以为真的删了
check "无独立的「已删除」成功行" '! printf "%s" "$OUT" | grep -qE "^\[fnproc-uninstall\] 已删除应用数据目录"'
check "无独立的「已清理」成功行" '! printf "%s" "$OUT" | grep -qE "^\[fnproc-uninstall\] 已清理本应用"'
check "改用「将完成」措辞"       'printf "%s" "$OUT" | grep -q "\[演练\] 将完成: 已删除应用数据目录"'

printf '\n[5b] 演练模式下的通知清理不能误报\n'
make_sandbox
FAKEBIN2="$SBX/fakebin2"; mkdir -p "$FAKEBIN2"
printf '#!/bin/bash\necho CALLED > "$PSQL_MARK"\nexit 0\n' > "$FAKEBIN2/psql"
chmod +x "$FAKEBIN2/psql"
OUT="$(PATH="$FAKEBIN2:$PATH" PSQL_MARK="$SBX/psql.mark" FNPROC_UNINSTALL_DRYRUN=1 \
      TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
      wizard_data_action=keep wizard_clear_notify=true bash "$CB" 2>&1)"
check "演练时 psql 根本没被调用" '[ ! -f "$SBX/psql.mark" ]'
check "日志不说『已清理』"        '! printf "%s" "$OUT" | grep -qE "^\[fnproc-uninstall\] 已清理本应用"'
check "日志说『将完成清理』"      'printf "%s" "$OUT" | grep -q "\[演练\] 将完成: 已清理本应用"'

printf '\n[6] wizard_clear_notify 取值形态\n'
make_sandbox
for v in true 1 on yes; do
  OUT="$(FNPROC_UNINSTALL_DRYRUN=1 TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
        wizard_data_action=keep wizard_clear_notify="$v" bash "$CB" 2>&1)"
  check "  '$v' → 执行清理" '! printf "%s" "$OUT" | grep -q "按用户选择保留系统通知"'
done
for v in false 0 no off "[]" "" "未传"; do
  if [ "$v" = "未传" ]; then
    OUT="$(FNPROC_UNINSTALL_DRYRUN=1 TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
          wizard_data_action=keep bash "$CB" 2>&1)"
  else
    OUT="$(FNPROC_UNINSTALL_DRYRUN=1 TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
          wizard_data_action=keep wizard_clear_notify="$v" bash "$CB" 2>&1)"
  fi
  check "  '$v' → 跳过清理" 'printf "%s" "$OUT" | grep -q "按用户选择保留系统通知"'
done

printf '\n[6b] 通知清理的 SQL（用假 psql 记录参数）\n'
make_sandbox
FAKEBIN="$SBX/fakebin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/psql" <<'FAKEPSQL'
#!/bin/bash
printf '%s\n' "$@" > "$PSQL_ARGS_FILE"
exit 0
FAKEPSQL
chmod +x "$FAKEBIN/psql"
OUT="$(PATH="$FAKEBIN:$PATH" PSQL_ARGS_FILE="$SBX/psql.args" \
      TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" \
      wizard_data_action=keep wizard_clear_notify=true bash "$CB" 2>&1)"
check "调用了 psql"                '[ -f "$SBX/psql.args" ]'
check "只删本应用的通知"           'grep -q "source = '"'"'fnproc'"'"'" "$SBX/psql.args"'
check "先清理 notify_user 关联"    'grep -q "DELETE FROM notify_user" "$SBX/psql.args"'
check "再清理 notify 本体"         'grep -q "DELETE FROM notify WHERE source" "$SBX/psql.args"'
check "psql 带 -X（不读用户 rc）"  'grep -qx -- "-X" "$SBX/psql.args"'
check "日志确认已清理"             'printf "%s" "$OUT" | grep -q "已清理本应用写入的系统通知"'

printf '\n[7] uninstall_init：停掉残留的采集进程\n'
make_sandbox
# 造一个和真实进程同形态的假 server（路径匹配 <DEST>/ui/server.js）
# 用 exec 让进程本身就是 sleep，避免留下孤儿子进程；输出丢弃，
# 否则后台进程持有 stdout 会让调用方一直等管道 EOF。
# 注意不能用 exec：exec 会让 cmdline 变成 sleep，pgrep/pid 校验都匹配不到本应用。
# 也不要用单条 sleep 300（bash 被杀后 sleep 会成 300 秒孤儿），用短循环。
printf '#!/bin/bash\nwhile :; do sleep 1; done\n' > "$SBX/@appcenter/fnproc/ui/server.js"
chmod +x "$SBX/@appcenter/fnproc/ui/server.js"
bash "$SBX/@appcenter/fnproc/ui/server.js" >/dev/null 2>&1 &
FAKE_PID=$!
# 再造一个同名但不同路径的进程，用来验证不会误杀
cp "$SBX/@appcenter/fnproc/ui/server.js" "$SBX/other-server.js"
bash "$SBX/other-server.js" >/dev/null 2>&1 &
OTHER_PID=$!
sleep 0.4
echo "$FAKE_PID" > "$SBX/@appdata/fnproc/app.pid"
OUT="$(TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" bash "$INIT" 2>&1)"
sleep 0.5
check "目标进程已停止"      '! [ -d "/proc/$FAKE_PID" ]'
check "无关进程未被误杀"    '[ -d "/proc/$OTHER_PID" ]'
check "日志报告了数据规模"   'printf "%s" "$OUT" | grep -q "应用数据目录"'
kill -KILL "$OTHER_PID" 2>/dev/null || true

printf '\n[8] uninstall_init：pid 文件指向无关进程时不误杀（PID 复用保护）\n'
make_sandbox
# make_sandbox 会重建目录，other-server.js 需要重新造
printf '#!/bin/bash\nwhile :; do sleep 1; done\n' > "$SBX/other-server.js"
chmod +x "$SBX/other-server.js"
bash "$SBX/other-server.js" >/dev/null 2>&1 &
OTHER_PID=$!
sleep 0.3
echo "$OTHER_PID" > "$SBX/@appdata/fnproc/app.pid"     # pid 文件里放的是「不是本应用」的进程
OUT="$(TRIM_PKGVAR="$SBX/@appdata/fnproc" TRIM_APPDEST="$SBX/@appcenter/fnproc" bash "$INIT" 2>&1)"
check "无关进程仍存活"      '[ -d "/proc/$OTHER_PID" ]'
check "日志提示 PID 复用保护" 'printf "%s" "$OUT" | grep -q "PID 复用保护"'
kill -KILL "$OTHER_PID" 2>/dev/null || true

for p in "${FAKE_PID:-}" "${OTHER_PID:-}"; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done
rm -rf "$SBX"
printf '\n================================\n通过 %d 项，失败 %d 项\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
