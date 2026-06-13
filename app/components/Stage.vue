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
  download: [index: number]
  select: [index: number]
  zoom: [index: number]
  "load-demo": []
}>()

const active = computed(() => props.prompts[props.activeIndex] ?? null)
const activeTitle = computed(() => active.value?.title?.trim() || `第 ${props.activeIndex + 1} 张`)
const canSelectPrev = computed(() => props.activeIndex > 0)
const canSelectNext = computed(() => props.activeIndex < props.prompts.length - 1)
const activeSrc = computed(() => {
  if (!active.value) return null
  if (active.value.imageId) return dbImageFileUrl(active.value.imageId)
  return null
})
const activeModeClass = computed(() => (active.value?.imageMode === "main" ? "is-main" : "is-detail"))
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
      <div class="stage-preview-nav" aria-label="预览图切换">
        <button
            type="button"
            class="stage-preview-nav-btn"
            :disabled="!canSelectPrev"
            aria-label="上一张预览图"
            title="上一张"
            @click="emit('select', Math.max(0, activeIndex - 1))"
        >
          <span class="stage-preview-nav-chevron is-prev" aria-hidden="true"></span>
        </button>
        <div class="stage-preview-nav-meta">
          <strong>{{ activeIndex + 1 }} / {{ prompts.length }}</strong>
          <span>{{ activeTitle }}</span>
        </div>
        <button
            type="button"
            class="stage-preview-nav-btn"
            :disabled="!canSelectNext"
            aria-label="下一张预览图"
            title="下一张"
            @click="emit('select', Math.min(prompts.length - 1, activeIndex + 1))"
        >
          <span class="stage-preview-nav-chevron is-next" aria-hidden="true"></span>
        </button>
      </div>
      <template v-if="activeSrc">
        <img :src="activeSrc" :alt="activeTitle" @click="emit('zoom', activeIndex)">
        <div class="stage-caption">{{ activeTitle }}</div>
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
          <div class="loading-hint">正在生成：{{ activeTitle }}</div>
          <p class="loading-progress">预计需要 15-30 秒，请稍候...</p>
        </template>
        <template v-else-if="active?.status === 'failed'">
          <Icon name="warning" class="icon-large" />
          <div class="alert">{{ active.error || "生成失败" }}</div>
        </template>
        <template v-else>
          <Icon name="queue" class="icon-large" />
          <div class="icon-hint">等待生成：{{ activeTitle }}</div>
        </template>
      </div>
    </div>

  </div>
</template>
