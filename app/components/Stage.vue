<script setup lang="ts">
import { computed } from "vue"
import { dbImageFileUrl } from "@/lib/db"
import type { DetailPromptItem } from "@/lib/types"
import Icon from "./Icon.vue"

const props = defineProps<{
  prompts: DetailPromptItem[]
  activeIndex: number
  busy: boolean
}>()

const emit = defineEmits<{
  select: [index: number]
  download: [index: number]
  zoom: [index: number]
  "load-demo": []
}>()

const active = computed(() => props.prompts[props.activeIndex] ?? null)
const activeSrc = computed(() => {
  if (!active.value) return null
  if (active.value.imageId) return dbImageFileUrl(active.value.imageId)
  return null
})
const activeModeClass = computed(() => (active.value?.imageMode === "main" ? "is-main" : "is-detail"))

function getItemSrc(item: DetailPromptItem) {
  if (item.imageId) return dbImageFileUrl(item.imageId)
  return null
}
</script>

<template>
  <div v-if="!prompts.length" class="stage">
    <div class="stage-empty-card" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center; padding: 24px;">
      <Icon name="image" class="icon-large" />
      <div class="icon-hint">您的商品图将在这里呈现</div>
      <p class="empty-tip" style="margin-bottom: 8px;">先填写商品资料并生成方案，然后点击"批量生成商品图"</p>
      <button
        type="button"
        class="btn-secondary"
        style="min-height: 32px; padding: 6px 12px; font-size: 0.78rem; border-radius: var(--radius-control); cursor: pointer; font-weight: bold;"
        @click="emit('load-demo')"
      >
        导入示例数据
      </button>
    </div>
  </div>

  <div v-else class="detail-stage">
    <div class="stage-main" :class="activeModeClass">
      <template v-if="activeSrc">
        <img :src="activeSrc" :alt="active?.title ?? ''" @click="emit('zoom', activeIndex)">
        <div class="stage-caption">{{ active?.title }}</div>
        <div class="stage-actions">
          <button class="btn-ghost" type="button" @click="emit('download', activeIndex)">
            <Icon name="download" />
            <span>下载</span>
          </button>
          <button class="btn-ghost" type="button" @click="emit('zoom', activeIndex)">
            <Icon name="zoom" />
            <span>预览</span>
          </button>
        </div>
      </template>

      <div v-else :class="['stage-placeholder', activeModeClass]">
        <template v-if="busy && (active?.status === 'running' || active?.status === 'queued')">
          <div class="spinner" />
          <div class="loading-hint">正在生成：{{ active?.title }}</div>
          <p class="loading-progress">预计需要 15-30 秒，请稍候...</p>
        </template>
        <template v-else-if="active?.status === 'failed'">
          <Icon name="warning" class="icon-large" />
          <div class="alert">{{ active.error || "生成失败" }}</div>
        </template>
        <template v-else>
          <Icon name="queue" class="icon-large" />
          <div class="icon-hint">等待生成：{{ active?.title }}</div>
        </template>
      </div>
    </div>

    <div class="result-strip" aria-label="商品图生成结果">
      <button
        v-for="(item, index) in prompts"
        :key="item.id"
        type="button"
        :class="['result-thumb', { 'is-active': index === activeIndex }]"
        @click="emit('select', index)"
      >
        <span :class="['status-dot', `is-${item.status}`]" />
        <img v-if="getItemSrc(item)" :src="getItemSrc(item)!" :alt="item.title">
        <span v-else class="result-thumb-empty">{{ index + 1 }}</span>
      </button>
    </div>
  </div>
</template>
