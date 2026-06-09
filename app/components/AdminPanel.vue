<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue"
import {
  createAccessCode,
  fetchAccessCodes,
  fetchAdminUsers,
  fetchRedeemCodes,
  updateAccessCode,
  updateAdminUser,
  updateRedeemCode,
} from "@/lib/api"
import type { AccessCodeRow, AdminUserRow, RedeemCodeRow, UserRole } from "@/lib/types"

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const TIME_FMT: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "超级管理员",
  admin: "管理员",
  user: "用户",
}

const users = ref<AdminUserRow[]>([])
const accessCodes = ref<AccessCodeRow[]>([])
const redeemCodes = ref<RedeemCodeRow[]>([])
const busyKey = shallowRef<string | null>(null)
const loading = shallowRef(false)
const accessBusy = shallowRef(false)
const error = shallowRef<string | null>(null)
const accessLabel = shallowRef("")
const customCode = shallowRef("")
const createdCode = shallowRef<string | null>(null)
const failedAvatars = ref(new Set<string>())

async function loadAdminData() {
  if (!props.open) return
  loading.value = true
  error.value = null
  try {
    const [userPayload, codePayload, redeemPayload] = await Promise.all([
      fetchAdminUsers(),
      fetchAccessCodes(),
      fetchRedeemCodes(),
    ])
    users.value = userPayload.users
    accessCodes.value = codePayload.accessCodes
    redeemCodes.value = redeemPayload.redeemCodes
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    loading.value = false
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

watch(
  () => props.open,
  (open) => {
    if (typeof window === "undefined") return
    document.removeEventListener("keydown", onKey)
    if (open) {
      document.addEventListener("keydown", onKey)
      void loadAdminData()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (typeof window !== "undefined") document.removeEventListener("keydown", onKey)
})

async function updateUser(
  user: AdminUserRow,
  patch: { role?: UserRole },
) {
  busyKey.value = user.userKey
  error.value = null
  try {
    const payload = await updateAdminUser(user.userKey, patch)
    users.value = users.value.map((item) =>
      item.userKey === user.userKey ? payload.user : item,
    )
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    busyKey.value = null
  }
}

async function handleCreateAccessCode() {
  accessBusy.value = true
  error.value = null
  createdCode.value = null
  try {
    const payload = await createAccessCode(accessLabel.value, customCode.value)
    accessCodes.value = [payload.accessCode, ...accessCodes.value]
    createdCode.value = payload.code
    accessLabel.value = ""
    customCode.value = ""
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    accessBusy.value = false
  }
}

async function handleUpdateAccessCode(
  accessCode: AccessCodeRow,
  patch: { active?: boolean; label?: string },
) {
  busyKey.value = accessCode.id
  error.value = null
  try {
    const payload = await updateAccessCode(accessCode.id, patch)
    accessCodes.value = accessCodes.value.map((item) =>
      item.id === accessCode.id ? payload.accessCode : item,
    )
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    busyKey.value = null
  }
}

async function handleUpdateRedeemCode(
  redeemCode: RedeemCodeRow,
  patch: { active?: boolean; label?: string },
) {
  busyKey.value = redeemCode.id
  error.value = null
  try {
    const payload = await updateRedeemCode(redeemCode.id, patch)
    redeemCodes.value = redeemCodes.value.map((item) =>
      item.id === redeemCode.id ? payload.redeemCode : item,
    )
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    busyKey.value = null
  }
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value)
}
</script>

<template>
  <div
    v-if="open"
    class="admin-overlay"
    @click="event => event.target === event.currentTarget && emit('close')"
  >
    <section class="admin-panel" role="dialog" aria-modal="true" aria-label="后台用户管理">
      <div class="admin-head">
        <div>
          <span class="section-kicker">Admin</span>
          <h2>用户与次数</h2>
        </div>
        <button class="btn-ghost" type="button" @click="emit('close')">关闭</button>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>

      <div class="admin-toolbar">
        <span>{{ loading ? "读取中" : `${users.length} 个用户` }}</span>
        <button class="btn-ghost" type="button" :disabled="loading" @click="loadAdminData">
          刷新
        </button>
      </div>

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>来源</th>
              <th>角色</th>
              <th>今日剩余</th>
              <th>今日已用</th>
              <th>最近登录</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.userKey">
              <td>
                <div class="admin-user-cell">
                  <img
                    v-if="user.image && !failedAvatars.has(user.userKey)"
                    :src="user.image"
                    :alt="user.name"
                    @error="failedAvatars.add(user.userKey)"
                  >
                  <span v-else>{{ user.name.slice(0, 1).toUpperCase() }}</span>
                  <div>
                    <strong>{{ user.name }}</strong>
                    <small>{{ user.email || user.userKey }}</small>
                  </div>
                </div>
              </td>
              <td>{{ user.provider }}</td>
              <td>
                <select
                  :aria-label="`${user.name} 的角色`"
                  :value="user.role"
                  :disabled="busyKey === user.userKey || user.role === 'super_admin'"
                  :title="ROLE_LABELS[user.role]"
                  @change="event => updateUser(user, { role: (event.target as HTMLSelectElement).value as UserRole })"
                >
                  <option v-if="user.role === 'super_admin'" value="super_admin">超级管理员</option>
                  <option value="user">用户</option>
                  <option value="admin">管理员</option>
                </select>
              </td>
              <td>
                <span v-if="user.role === 'super_admin'" class="unlimited-pill">不限</span>
                <span v-else>{{ user.remainingCredits }} / {{ user.grantedCredits }}</span>
              </td>
              <td>{{ user.usedCredits }}</td>
              <td>{{ new Date(user.lastLoginAt).toLocaleString("zh-CN", TIME_FMT) }}</td>
            </tr>
            <tr v-if="!users.length && !loading">
              <td colspan="6">暂无用户数据</td>
            </tr>
          </tbody>
        </table>
      </div>

      <section class="access-code-section">
        <div class="admin-section-head">
          <div>
            <h3>访问码</h3>
            <p>创建给临时用户使用的登录码，创建后明文只显示一次。</p>
          </div>
          <span>{{ accessCodes.length }} 个访问码</span>
        </div>

        <form class="access-code-form" @submit.prevent="handleCreateAccessCode">
          <input v-model="accessLabel" type="text" placeholder="备注，例如：运营同事 / 临时演示" aria-label="访问码备注">
          <input v-model="customCode" type="text" placeholder="自定义访问码，可留空自动生成" aria-label="自定义访问码">
          <button class="btn-secondary" type="submit" :disabled="accessBusy">
            {{ accessBusy ? "创建中..." : "创建访问码" }}
          </button>
        </form>

        <div v-if="createdCode" class="access-code-created">
          <span>新访问码</span>
          <code>{{ createdCode }}</code>
          <button class="btn-ghost" type="button" @click="copyText(createdCode)">复制</button>
        </div>

        <div class="admin-table-wrap">
          <table class="admin-table access-code-table">
            <thead>
              <tr>
                <th>备注</th>
                <th>状态</th>
                <th>使用次数</th>
                <th>最近使用</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="accessCode in accessCodes" :key="accessCode.id">
                <td>
                  <input
                    v-model="accessCode.label"
                    aria-label="访问码备注"
                    type="text"
                    :disabled="busyKey === accessCode.id"
                    @blur="handleUpdateAccessCode(accessCode, { label: accessCode.label })"
                  >
                </td>
                <td>
                  <span :class="['access-code-status', { 'is-active': accessCode.active }]">
                    {{ accessCode.active ? "启用" : "停用" }}
                  </span>
                </td>
                <td>{{ accessCode.useCount }}</td>
                <td>
                  {{ accessCode.lastUsedAt ? new Date(accessCode.lastUsedAt).toLocaleString("zh-CN", TIME_FMT) : "未使用" }}
                </td>
                <td>{{ new Date(accessCode.createdAt).toLocaleString("zh-CN", TIME_FMT) }}</td>
                <td>
                  <button
                    class="btn-ghost"
                    type="button"
                    :disabled="busyKey === accessCode.id"
                    @click="handleUpdateAccessCode(accessCode, { active: !accessCode.active })"
                  >
                    {{ accessCode.active ? "停用" : "启用" }}
                  </button>
                </td>
              </tr>
              <tr v-if="!accessCodes.length && !loading">
                <td colspan="6">暂无访问码</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="access-code-section redeem-code-section">
        <div class="admin-section-head">
          <div>
            <h3>旧兑换码</h3>
            <p>系统已改为每个注册用户每天 10 次生图机会，旧兑换码仅保留查看和停用。</p>
          </div>
          <span>{{ redeemCodes.length }} 个旧兑换码</span>
        </div>

        <div class="admin-table-wrap">
          <table class="admin-table access-code-table">
            <thead>
              <tr>
                <th>备注</th>
                <th>状态</th>
                <th>原次数</th>
                <th>兑换进度</th>
                <th>最近兑换</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="redeemCode in redeemCodes" :key="redeemCode.id">
                <td>
                  <input
                    v-model="redeemCode.label"
                    aria-label="兑换码备注"
                    type="text"
                    :disabled="busyKey === redeemCode.id"
                    @blur="handleUpdateRedeemCode(redeemCode, { label: redeemCode.label })"
                  >
                </td>
                <td>
                  <span :class="['access-code-status', { 'is-active': redeemCode.active }]">
                    {{ redeemCode.active ? "启用" : "停用" }}
                  </span>
                </td>
                <td>+{{ redeemCode.credits }}</td>
                <td>{{ redeemCode.redeemCount }} / {{ redeemCode.maxRedemptions }}</td>
                <td>
                  {{ redeemCode.lastRedeemedAt ? new Date(redeemCode.lastRedeemedAt).toLocaleString("zh-CN", TIME_FMT) : "未兑换" }}
                </td>
                <td>{{ new Date(redeemCode.createdAt).toLocaleString("zh-CN", TIME_FMT) }}</td>
                <td>
                  <button
                    class="btn-ghost"
                    type="button"
                    :disabled="busyKey === redeemCode.id"
                    @click="handleUpdateRedeemCode(redeemCode, { active: !redeemCode.active })"
                  >
                    {{ redeemCode.active ? "停用" : "启用" }}
                  </button>
                </td>
              </tr>
              <tr v-if="!redeemCodes.length && !loading">
                <td colspan="7">暂无兑换码</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </div>
</template>
