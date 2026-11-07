#!/bin/bash
### fnproc 安装/升级统计推送公共库
### 调用方式：source "$(dirname "${BASH_SOURCE[0]}")/lib/feishu_push.sh"
###
### 提供函数：
###   feishu_push_install <app_name> <app_version>              # 首次安装
###   feishu_push_upgrade <app_name> <old_version> <new_version> # 升级
###
### 设计取舍：
###   · 全部失败都要静默放过（|| true / return 0）—— 统计是附加功能，
###     绝不能因为网络不通或表格改字段就让应用装不上
###   · 每次请求都带 --max-time，避免安装回调卡在 DNS/连不上时一直等
###   · 设备 ID 用 /etc/machine-id 派生的稳定 UUID，同一台机器永远相同，
###     这样表格里能按 ID 排重算出真实装机量，而不是「安装事件数」
###   · 设 TRM_STATS_DRYRUN=1 时只打印不发送，便于本地验证

FEISHU_APP_ID="cli_SANITIZED_APP_ID"
FEISHU_APP_SECRET="SANITIZED_APP_SECRET"
FEISHU_APP_TOKEN="SANITIZED_APP_TOKEN"
# 仅用于本地验证：指向 mock 服务时不会碰正式表格
FEISHU_API_BASE="${FEISHU_API_BASE:-https://open.feishu.cn}"
FEISHU_TABLE_ID="tbl1kmuwQu2CToeN"

# 获取设备稳定 UUID (同一台机器永远相同, 跨 install/upgrade/重启)
# 来源: /etc/machine-id (systemd 标准) → /proc/cpuinfo Serial → 持久化文件兜底
_feishu_get_device_uuid() {
    local raw=""

    # 1. 优先 /etc/machine-id (systemd 标准,任何用户可读)
    if [ -r /etc/machine-id ]; then
        raw=$(tr -d '[:space:]' < /etc/machine-id 2>/dev/null)
    fi

    # 2. 兜底 /proc/cpuinfo Serial (老系统/非 systemd,绝大多数 x86 CPU 都有)
    if [ -z "${raw}" ] || [ "${#raw}" -lt 16 ]; then
        raw=$(grep -m1 'Serial' /proc/cpuinfo 2>/dev/null | awk '{print $3}' | tr -d '[:space:]')
    fi

    # 3. 实在没有 → 持久化到 /var/cache (install 回调可能没 PKGVAR)
    if [ -z "${raw}" ] || [ "${#raw}" -lt 16 ]; then
        local uuid_file="/var/cache/.fnproc_device_uuid"
        if [ -f "${uuid_file}" ]; then
            raw=$(cat "${uuid_file}" 2>/dev/null | tr -d '[:space:]')
        else
            raw=$(cat /proc/sys/kernel/random/uuid | tr -d '[:space:]')
            mkdir -p /var/cache 2>/dev/null && \
                printf "%s" "${raw}" > "${uuid_file}" 2>/dev/null && \
                chmod 644 "${uuid_file}" 2>/dev/null
        fi
    fi

    # 4. 格式化成 8-4-4-4-12 标准 UUID 格式
    raw=$(printf "%-32s" "${raw}" | tr ' ' '0')
    printf "%s-%s-%s-%s-%s" \
        "${raw:0:8}" "${raw:8:4}" "${raw:12:4}" "${raw:16:4}" "${raw:20:12}"
}

# 获取 IP 归属地（城市/省/国家）；拿不到就返回空，不影响写入
_feishu_get_ip_location() {
    local city region country
    city=$(curl -s --connect-timeout 4 --max-time 6 "https://ipinfo.io/city" 2>/dev/null || true)
    region=$(curl -s --connect-timeout 4 --max-time 6 "https://ipinfo.io/region" 2>/dev/null || true)
    country=$(curl -s --connect-timeout 4 --max-time 6 "https://ipinfo.io/country" 2>/dev/null || true)
    printf "%s %s %s" "${city}" "${region}" "${country}" | tr -s ' '
}

# 获取 tenant_access_token
_feishu_get_token() {
    local resp token
    resp=$(curl -s --connect-timeout 5 --max-time 10 \
        -X POST "${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FEISHU_APP_ID}\",\"app_secret\":\"${FEISHU_APP_SECRET}\"}" 2>/dev/null)
    # 用 sed 容错解析：无论 ":  " 之间有没有空格都能取到
    token=$(printf "%s" "${resp}" | sed -n 's/.*"tenant_access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    if [ -z "${token}" ]; then
        # 只打印错误码，不打印含凭据的请求体
        echo "[feishu] token 获取失败: $(printf "%s" "${resp}" | head -c 200)" >&2
        return 1
    fi
    printf "%s" "${token}"
}

# 写入多维表格；返回 0 表示请求已发出（不校验业务码，避免打断安装流程）
_feishu_write_record() {
    local token="$1"; shift
    local record_id="$1"; shift
    local app_name="$1"; shift
    local app_ver="$1"; shift
    local old_ver="$1"; shift
    local event_time="$1"; shift
    local status="$1"; shift
    local ip_addr="$1"; shift

    local payload
    payload=$(cat <<JSON
{
  "fields": {
    "ID": "${record_id}",
    "应用名称": "${app_name}",
    "版本号": "${app_ver}",
    "旧版本号": "${old_ver}",
    "安装日期": "${event_time}",
    "安装状态": "${status}",
    "安装位置": "${ip_addr}"
  }
}
JSON
)

    if [ "${TRM_STATS_DRYRUN:-0}" = "1" ]; then
        echo "[feishu][dry-run] ${app_name} ${status} ${old_ver:+${old_ver}→}${app_ver} ${event_time} ${ip_addr}" >&2
        echo "[feishu][dry-run] payload: ${payload}" >&2
        return 0
    fi

    local resp
    resp=$(curl -s --connect-timeout 5 --max-time 12 \
        -X POST "${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records" \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d "${payload}" 2>/dev/null)
    # 记录失败原因便于排查，但绝不阻断安装
    case "${resp}" in
        *'"code"'*'0'*) [ "${TRM_STATS_VERBOSE:-0}" = "1" ] && echo "[feishu] 写入成功" >&2 ;;
        "") echo "[feishu] 写入无响应（网络不通？）" >&2 ;;
        *) echo "[feishu] 写入返回异常: $(printf "%s" "${resp}" | head -c 200)" >&2 ;;
    esac
    return 0
}

# 首次安装推送
feishu_push_install() {
    local app_name="$1"
    local app_version="$2"
    local event_time ip_addr record_id token
    event_time=$(date '+%Y年%-m月%-d日 %H:%M')
    record_id=$(_feishu_get_device_uuid)
    ip_addr=$(_feishu_get_ip_location)
    token=$(_feishu_get_token) || return 0
    _feishu_write_record "${token}" "${record_id}" "${app_name}" "${app_version}" "" "${event_time}" "首次安装成功" "${ip_addr}"
}

# 升级推送
feishu_push_upgrade() {
    local app_name="$1"
    local old_version="$2"
    local new_version="$3"
    local event_time ip_addr record_id token
    event_time=$(date '+%Y年%-m月%-d日 %H:%M')
    record_id=$(_feishu_get_device_uuid)
    ip_addr=$(_feishu_get_ip_location)
    token=$(_feishu_get_token) || return 0
    _feishu_write_record "${token}" "${record_id}" "${app_name}" "${new_version}" "${old_version}" "${event_time}" "升级成功" "${ip_addr}"
}
