<script setup lang="ts">
import { dbImageFileUrl } from "@/lib/db"
import type { DetailPromptItem, HistoryItem } from "@/lib/types"
import Icon from "./Icon.vue"

defineProps<{
  history: HistoryItem[]
  activeIdx: number
}>()

const emit = defineEmits<{
  select: [idx: number]
  delete: [idx: number]
  clearAll: []
}>()

const TIME_FMT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
}

function getPromptSrc(prompt: DetailPromptItem | undefined) {
  if (!prompt) return null
  if (prompt.imageId) return dbImageFileUrl(prompt.imageId)
  return null
}

function getReversed(history: HistoryItem[]) {
  return history.map((item, idx) => ({ item, idx })).reverse()
}

function getHistoryModeLabel(item: HistoryItem) {
  return item.product.imageModes.map((mode) => (mode === "main" ? "主图" : "详情图")).join("+")
}
</script>

<template>
  <div class="history-bar">
    <h2>
      生成历史
      <span class="history-badge">{{ history.length }} 组</span>
    </h2>
    <button class="btn-danger" type="button" @click="emit('clearAll')">
      <Icon name="trash" />
      <span>清空</span>
    </button>
  </div>
  <div class="history-grid">
    <div v-if="history.length === 0" class="empty">还没有商品图历史</div>
    <div
      v-for="{ item, idx } in getReversed(history)"
      v-else
      :key="item.id ?? `history-${idx}-${item.timestamp}`"
      :class="['history-card', { 'is-active': idx === activeIdx }]"
      @click="emit('select', idx)"
    >
      <div class="history-cover">
        <span class="tile-no">
          {{ item.prompts.filter((prompt) => prompt.imageId).length }}/{{ item.prompts.length }}
        </span>
        <img
          v-if="getPromptSrc(item.prompts.find((prompt) => prompt.imageId))"
          :src="getPromptSrc(item.prompts.find((prompt) => prompt.imageId))!"
          :alt="item.product.name"
        >
        <div v-else class="tile-empty">{{ item.product.name.slice(0, 8) }}</div>
      </div>
      <div class="history-card-body">
        <strong :title="item.product.name">{{ item.product.name }}</strong>
        <p :title="item.product.sellingPoints">{{ item.product.sellingPoints }}</p>
        <small :title="item.prompts.slice(0, 2).map((prompt) => prompt.title).join(' / ')">
          {{ item.prompts.slice(0, 2).map((prompt) => prompt.title).join(" / ") || "暂无图包方案" }}
        </small>
        <span class="history-meta-pill">
          {{ `${getHistoryModeLabel(item)} · ${item.generation?.quality ?? "1K"}` }}
        </span>
      </div>
      <div class="history-card-foot">
        <span>{{ new Date(item.timestamp).toLocaleString("zh-CN", TIME_FMT) }}</span>
        <button
          class="tile-del"
          type="button"
          title="删除"
          @click.stop="emit('delete', idx)"
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  </div>
</template>
