<script setup lang="ts">
import { computed, ref, shallowRef } from "vue"
import {
  cancelImageTask,
  createImageTask,
  pollImageTask,
} from "@/lib/api"
import { resolveImageSize } from "@/lib/imageOptions"
import type { AspectRatio, AuthSession, ImageQuality } from "@/lib/types"
import Icon from "./Icon.vue"
import ImageCountSelector from "./ImageCountSelector.vue"
import QualitySelector from "./QualitySelector.vue"
import SegmentedControl from "./SegmentedControl.vue"

type MultiViewStatus = "draft" | "queued" | "running" | "succeeded" | "failed"

interface MultiViewAngle {
  id: string
  title: string
  instruction: string
}

interface MultiViewItem extends MultiViewAngle {
  status: MultiViewStatus
  taskId?: string
  base64?: string
  model?: string
  error?: string
  updatedAt?: number
}

const props = defineProps<{
  authenticated: boolean
  sessionLoading: boolean
  session: AuthSession | null
}>()

const emit = defineEmits<{
  "update:session": [session: AuthSession | null]
  zoom: [src: string]
}>()

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PRODUCT_IMAGE_EDGE = 1280
const PRODUCT_IMAGE_QUALITY = 0.82
const MAX_REFERENCE_IMAGE_CHARS = 1_500_000
const MAX_REFERENCE_IMAGE_TOTAL_CHARS = 6_000_000
const MAX_MULTI_VIEW_IMAGES = 8
const MULTI_VIEW_ASPECT_RATIO_OPTIONS: Array<{ label: string; value: AspectRatio }> = [
  { label: "Auto", value: "auto" },
  { label: "1:1", value: "1:1" },
  { label: "4:3", value: "4:3" },
  { label: "3:4", value: "3:4" },
]

const ANGLE_PRESETS: MultiViewAngle[] = [
  {
    id: "front",
    title: "正面",
    instruction: "front view, product facing camera directly, key visual identity clearly visible",
  },
  {
    id: "back",
    title: "背面",
    instruction: "back view, same product turned around, infer only from visible structure and do not redesign",
  },
  {
    id: "left-45",
    title: "左 45 度",
    instruction: "left 45-degree three-quarter view, product rotated naturally with full body visible",
  },
  {
    id: "left-side",
    title: "左侧",
    instruction: "left side profile view, product body complete and vertically aligned",
  },
  {
    id: "right-side",
    title: "右侧",
    instruction: "right side profile view, product body complete and vertically aligned",
  },
  {
    id: "top",
    title: "俯视",
    instruction: "top view, show top structure only when meaningful for this product shape",
  },
  {
    id: "bottom",
    title: "底部",
    instruction: "bottom view, show base or underside only when meaningful and infer conservatively",
  },
  {
    id: "detail",
    title: "结构细节",
    instruction: "close product-only detail view of the most useful structure, material, seam, opening, interface, cap, sole, clasp, or packaging side",
  },
]

const STATUS_LABEL: Record<MultiViewStatus, string> = {
  draft: "待生成",
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
}

const fileInputRef = ref<HTMLInputElement | null>(null)
const productImages = ref<string[]>([])
const imageCount = shallowRef(4)
const aspectRatio = shallowRef<AspectRatio>("1:1")
const quality = shallowRef<ImageQuality>("1K")
const items = ref<MultiViewItem[]>(createViewItems(imageCount.value))
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
const currentTaskIdRef = shallowRef<string | null>(null)
const abortRef = shallowRef<AbortController | null>(null)
const cancelRequestedRef = shallowRef(false)

const controlsDisabled = computed(() => props.sessionLoading || busy.value || !props.authenticated)
const remainingCredits = computed(() =>
  props.session?.user?.role === "super_admin"
    ? "不限次数"
    : `${props.session?.user?.remainingCredits ?? 0} 张可用`,
)
const generationLabel = computed(() =>
  `${aspectRatio.value === "auto" ? "Auto" : aspectRatio.value} · ${quality.value}`,
)
const completedCount = computed(() =>
  items.value.filter((item) => item.status === "succeeded").length,
)
const runningLabel = computed(() =>
  busy.value ? "生成中" : completedCount.value ? `${completedCount.value}/${items.value.length} 已完成` : "待命",
)

function createViewItems(count: number): MultiViewItem[] {
  const normalized = Math.min(MAX_MULTI_VIEW_IMAGES, Math.max(1, Math.round(count)))
  const selected =
    normalized === 1
      ? [ANGLE_PRESETS[0]!]
      : normalized === 2
        ? [ANGLE_PRESETS[0]!, ANGLE_PRESETS[1]!]
        : normalized === 3
          ? [ANGLE_PRESETS[0]!, ANGLE_PRESETS[2]!, ANGLE_PRESETS[1]!]
          : normalized === 4
            ? [ANGLE_PRESETS[0]!, ANGLE_PRESETS[3]!, ANGLE_PRESETS[4]!, ANGLE_PRESETS[1]!]
            : [
                ANGLE_PRESETS[0]!,
                ANGLE_PRESETS[3]!,
                ANGLE_PRESETS[4]!,
                ANGLE_PRESETS[1]!,
                ...ANGLE_PRESETS.slice(5),
              ].slice(0, normalized)

  return selected.map((angle) => ({
    ...angle,
    status: "draft",
  }))
}

function handleCountChange(value: number) {
  if (busy.value) return
  imageCount.value = Math.min(MAX_MULTI_VIEW_IMAGES, Math.max(1, Math.round(value)))
  items.value = createViewItems(imageCount.value)
}

function fileToCompressedDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        const scale = Math.min(
          1,
          MAX_PRODUCT_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
        )
        const width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = Math.max(1, Math.round(image.naturalHeight * scale))
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })
        if (!ctx) {
          reject(new Error("浏览器不支持图片压缩，请更换图片后重试"))
          return
        }
        ctx.drawImage(image, 0, 0, width, height)
        resolve(canvas.toDataURL("image/jpeg", PRODUCT_IMAGE_QUALITY))
      }
      image.onerror = () => reject(new Error("图片读取失败，请更换图片后重试"))
      image.src = String(reader.result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function handleSelectFiles(files: FileList | null) {
  if (!files?.length) return
  error.value = null
  const accepted: string[] = []
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) {
      error.value = `已忽略非图片文件：${file.name}`
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      error.value = `图片过大（>8MB）已忽略：${file.name}`
      continue
    }
    try {
      accepted.push(await fileToCompressedDataURL(file))
    } catch (event) {
      console.warn("读取图片失败:", event)
    }
  }
  if (accepted.length) productImages.value = [...productImages.value, ...accepted].slice(0, 8)
  if (fileInputRef.value) fileInputRef.value.value = ""
}

function removeReferenceImage(index: number) {
  if (busy.value) return
  productImages.value = productImages.value.filter((_, imageIndex) => imageIndex !== index)
}

function getGenerationImages() {
  const images = productImages.value
    .filter((image) => image.startsWith("data:image/"))
    .filter((image) => image.length <= MAX_REFERENCE_IMAGE_CHARS)
    .slice(0, 8)
  const total = images.reduce((sum, image) => sum + image.length, 0)
  if (!images.length) throw new Error("请至少上传一张产品参考图。")
  if (total > MAX_REFERENCE_IMAGE_TOTAL_CHARS) {
    throw new Error("产品参考图总大小过大，请减少图片数量或重新上传后再生成。")
  }
  return images
}

function createMultiViewPrompt(item: MultiViewItem) {
  return [
    "Generate one clean ecommerce product packshot on a pure white background.",
    "Output only the product body. No marketing copy, no angle labels, no text overlays, no icons, no badges, no cards, no borders, no decorative elements, no hands, no people, no table, no shelf, no lifestyle scene, no props.",
    "The product must match the uploaded reference images for color, material, structure, packaging shape, visible logo, label layout, proportions, transparency, seams, interfaces and all visible product identity.",
    "Only change the camera/view angle. Do not redesign, replace, simplify, or invent a different product.",
    "If this exact angle is not fully visible in the references, infer conservatively from visible structure and keep the same product design.",
    `Required angle: ${item.title} (${item.instruction}).`,
    "The full product should be centered, complete, sharp, evenly lit, isolated on pure #ffffff background, with natural minimal contact shadow only if needed to ground the object.",
  ].join("\n")
}

function updateSessionCredits(result: {
  remainingCredits?: number
  usedCredits?: number
  unlimitedCredits?: boolean
}) {
  if (result.unlimitedCredits || !Number.isFinite(result.remainingCredits)) return
  if (!props.session?.user) return
  emit("update:session", {
    ...props.session,
    user: {
      ...props.session.user,
      remainingCredits: result.remainingCredits,
      usedCredits: result.usedCredits,
    },
  })
}

function validateGeneration() {
  if (!props.authenticated) {
    error.value = "请先登录后再生成多视角产品图。"
    return false
  }
  if (!productImages.value.length) {
    error.value = "请至少上传一张产品参考图。"
    return false
  }
  return true
}

async function generateView(index: number, generationImages: string[]) {
  const item = items.value[index]
  if (!item) return

  items.value = items.value.map((view, viewIndex) =>
    viewIndex === index
      ? {
          ...view,
          status: "queued",
          taskId: undefined,
          base64: undefined,
          model: undefined,
          error: undefined,
          updatedAt: Date.now(),
        }
      : view,
  )

  const task = await createImageTask(
    {
      prompt: createMultiViewPrompt(item),
      size: resolveImageSize(aspectRatio.value),
      aspectRatio: aspectRatio.value,
      quality: quality.value,
      inputImages: generationImages,
    },
    abortRef.value?.signal,
  )
  currentTaskIdRef.value = task.taskId
  updateSessionCredits(task)

  items.value = items.value.map((view, viewIndex) =>
    viewIndex === index
      ? { ...view, status: "running", taskId: task.taskId, updatedAt: Date.now() }
      : view,
  )

  const result = await pollImageTask(task.taskId, undefined, abortRef.value?.signal)
  if (cancelRequestedRef.value || result.status === "canceled") return
  if (result.status === "failed") {
    items.value = items.value.map((view, viewIndex) =>
      viewIndex === index
        ? {
            ...view,
            status: "failed",
            error: result.error || "任务执行失败",
            updatedAt: Date.now(),
          }
        : view,
    )
    return
  }

  updateSessionCredits(result)
  items.value = items.value.map((view, viewIndex) =>
    viewIndex === index
      ? {
          ...view,
          status: "succeeded",
          taskId: undefined,
          base64: result.base64,
          model: result.model,
          error: undefined,
          updatedAt: Date.now(),
        }
      : view,
  )
  currentTaskIdRef.value = null
}

async function handleGenerateAll() {
  error.value = null
  if (!validateGeneration()) return
  busy.value = true
  cancelRequestedRef.value = false
  abortRef.value = new AbortController()
  items.value = createViewItems(imageCount.value)
  try {
    const generationImages = getGenerationImages()
    for (let index = 0; index < items.value.length; index += 1) {
      if (cancelRequestedRef.value) break
      try {
        await generateView(index, generationImages)
      } catch (event) {
        if (event instanceof DOMException && event.name === "AbortError") break
        items.value = items.value.map((view, viewIndex) =>
          viewIndex === index
            ? {
                ...view,
                status: "failed",
                error: event instanceof Error ? event.message : String(event),
                updatedAt: Date.now(),
              }
            : view,
        )
      }
    }
    const failed = items.value.filter((item) => item.status === "failed").length
    if (failed > 0) error.value = `${failed} 张生成失败，可单独重新生成失败视角。`
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    busy.value = false
    currentTaskIdRef.value = null
    abortRef.value = null
    cancelRequestedRef.value = false
  }
}

async function handleRegenerate(index: number) {
  error.value = null
  if (!validateGeneration()) return
  busy.value = true
  cancelRequestedRef.value = false
  abortRef.value = new AbortController()
  try {
    await generateView(index, getGenerationImages())
  } catch (event) {
    if (!(event instanceof DOMException && event.name === "AbortError")) {
      error.value = event instanceof Error ? event.message : String(event)
    }
  } finally {
    busy.value = false
    currentTaskIdRef.value = null
    abortRef.value = null
    cancelRequestedRef.value = false
  }
}

function handleCancelGeneration() {
  if (!busy.value) return
  cancelRequestedRef.value = true
  const taskId = currentTaskIdRef.value
  if (taskId) cancelImageTask(taskId).catch((event) => console.warn("取消多视角任务失败:", event))
  abortRef.value?.abort()
  items.value = items.value.map((item) =>
    item.status === "queued" || item.status === "running"
      ? { ...item, status: item.base64 ? "succeeded" : "draft", taskId: undefined }
      : item,
  )
}

function getResultSrc(item: MultiViewItem) {
  return item.base64 ? `data:image/png;base64,${item.base64}` : null
}

function handleDownload(item: MultiViewItem) {
  const src = getResultSrc(item)
  if (!src) return
  const anchor = document.createElement("a")
  anchor.href = src
  anchor.download = `ecom-multi-view-${item.id}.png`
  anchor.click()
}
</script>

<template>
  <div class="run-status" aria-label="当前多视角任务状态">
      <span>{{ productImages.length ? `${productImages.length} 张参考图` : "未上传参考图" }}</span>
      <span>{{ imageCount }} 个视角</span>
      <span>{{ remainingCredits }}</span>
      <span>{{ generationLabel }}</span>
      <span>{{ runningLabel }}</span>
    </div>

    <div class="multi-view-grid">
      <aside class="studio-panel multi-view-input">
        <div class="panel-heading">
          <h2>多视角设置</h2>
          <button
            type="button"
            class="inline-action panel-reset-action"
            :disabled="busy"
            @click="productImages = []; items = createViewItems(imageCount)"
          >
            重置
          </button>
        </div>

        <div class="multi-view-input-body">
          <div class="field-row-head">
            <label for="multi-view-images">产品参考图</label>
            <button
              v-if="productImages.length > 0"
              type="button"
              class="inline-action"
              :disabled="controlsDisabled"
              @click="productImages = []"
            >
              清空
            </button>
          </div>
          <div class="product-media">
            <div
              v-for="(src, index) in productImages"
              :key="`${src.slice(0, 32)}-${index}`"
              class="prompt-thumb"
            >
              <button
                type="button"
                class="prompt-thumb-preview"
                :aria-label="`查看产品参考图 ${index + 1}`"
                @click="emit('zoom', src)"
              >
                <img :src="src" :alt="`产品参考图 ${index + 1}`">
              </button>
              <button
                type="button"
                class="prompt-thumb-del"
                :disabled="controlsDisabled"
                :aria-label="`移除产品参考图 ${index + 1}`"
                @click="removeReferenceImage(index)"
              >
                <Icon name="close" />
              </button>
            </div>
            <button
              type="button"
              class="prompt-upload-tile"
              :disabled="controlsDisabled"
              @click="fileInputRef?.click()"
            >
              <Icon name="upload" />
              <span>上传</span>
            </button>
          </div>
          <input
            id="multi-view-images"
            ref="fileInputRef"
            type="file"
            aria-label="上传产品参考图"
            accept="image/*"
            multiple
            hidden
            @change="event => handleSelectFiles((event.target as HTMLInputElement).files)"
          >

          <div class="multi-view-note">
            <strong>白底产品图</strong>
            <p>系统自动分配标准角度，只输出商品本体。参考图越多，背面、侧面和底部越稳定。</p>
          </div>

          <div class="settings-row">
            <div class="setting-block">
              <div class="setting-head">
                <label>视角数量</label>
                <span>{{ imageCount }} 张</span>
              </div>
              <div class="param-controls" aria-label="多视角张数">
                <ImageCountSelector
                  :value="imageCount"
                  :disabled="controlsDisabled"
                  @change="handleCountChange"
                />
              </div>
            </div>
            <div class="setting-block">
              <div class="setting-head">
                <label>画面比例</label>
                <span>{{ aspectRatio === "auto" ? "Auto" : aspectRatio }}</span>
              </div>
              <div class="param-controls" aria-label="画面比例">
                <SegmentedControl
                  aria-label="画面比例"
                  ariaLabel="画面比例"
                  :value="aspectRatio"
                  :options="MULTI_VIEW_ASPECT_RATIO_OPTIONS"
                  :disabled="controlsDisabled"
                  @change="aspectRatio = $event as AspectRatio"
                />
              </div>
            </div>
            <div class="setting-block">
              <div class="setting-head">
                <label>清晰度</label>
                <span>{{ quality }}</span>
              </div>
              <div class="param-controls" aria-label="清晰度">
                <QualitySelector
                  :value="quality"
                  :disabled="controlsDisabled"
                  @change="quality = $event"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="input-action-bar">
          <button
            v-if="!busy"
            type="button"
            class="btn-primary"
            :disabled="controlsDisabled"
            @click="handleGenerateAll"
          >
            生成多视角白底图
          </button>
          <button v-else type="button" class="btn-danger" @click="handleCancelGeneration">
            中断生成
          </button>
          <div v-if="error" class="alert">{{ error }}</div>
        </div>
      </aside>

      <section class="studio-panel multi-view-results">
        <div class="panel-heading">
          <h2>视角结果</h2>
          <span class="panel-count">{{ completedCount }} / {{ items.length }}</span>
        </div>
        <div class="multi-view-result-grid">
          <article
            v-for="(item, index) in items"
            :key="item.id"
            :class="['multi-view-card', `is-${item.status}`]"
          >
            <div class="multi-view-card-head">
              <span>{{ index + 1 }}</span>
              <strong>{{ item.title }}</strong>
              <em>{{ STATUS_LABEL[item.status] }}</em>
            </div>
            <button
              type="button"
              class="multi-view-preview"
              :disabled="!getResultSrc(item)"
              @click="() => {
                const src = getResultSrc(item)
                if (src) emit('zoom', src)
              }"
            >
              <img v-if="getResultSrc(item)" :src="getResultSrc(item)!" :alt="`${item.title}白底图`">
              <span v-else-if="item.status === 'running' || item.status === 'queued'" class="busy-orbit" aria-hidden="true" />
              <Icon v-else name="queue" />
            </button>
            <p v-if="item.error" class="multi-view-error">{{ item.error }}</p>
            <div class="multi-view-card-actions">
              <button
                type="button"
                class="btn-ghost"
                :disabled="busy || !getResultSrc(item)"
                @click="handleDownload(item)"
              >
                <Icon name="download" />
                下载
              </button>
              <button
                type="button"
                class="btn-ghost"
                :disabled="controlsDisabled || !productImages.length"
                @click="handleRegenerate(index)"
              >
                重新生成
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>
</template>

<style scoped>
.multi-view-grid {
  display: grid;
  grid-template-columns: minmax(300px, 390px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.multi-view-input,
.multi-view-results {
  min-height: 100%;
}

.multi-view-input-body {
  display: grid;
  gap: 18px;
}

.multi-view-note {
  display: grid;
  gap: 6px;
  padding: 14px;
  border: 1px solid #dbe6f4;
  border-radius: 8px;
  background: #f8fbff;
}

.multi-view-note strong {
  color: #0f2446;
  font-size: 13px;
}

.multi-view-note p {
  margin: 0;
  color: #5b6b84;
  font-size: 12px;
  line-height: 1.55;
}

.multi-view-result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px;
}

.multi-view-card {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid #dbe6f4;
  border-radius: 8px;
  background: #f9fbff;
}

.multi-view-card.is-succeeded {
  border-color: #8fd7aa;
}

.multi-view-card.is-failed {
  border-color: #f2a7a7;
}

.multi-view-card-head {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.multi-view-card-head span {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid #cfdded;
  border-radius: 7px;
  color: #48607f;
  font-size: 12px;
  background: #eef5ff;
}

.multi-view-card-head strong {
  overflow: hidden;
  color: #10213a;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-view-card-head em {
  color: #6b7c95;
  font-size: 12px;
  font-style: normal;
}

.multi-view-preview {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid #d7e2f0;
  border-radius: 8px;
  background: #fff;
  color: #b2bfce;
  cursor: zoom-in;
}

.multi-view-preview:disabled {
  cursor: default;
}

.multi-view-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.multi-view-preview svg {
  width: 34px;
  height: 34px;
}

.multi-view-error {
  margin: 0;
  color: #fca5a5;
  font-size: 12px;
  line-height: 1.45;
}

.multi-view-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.multi-view-card-actions .btn-ghost {
  min-height: 34px;
  padding: 0 10px;
  font-size: 12px;
}

.multi-view-card-actions svg {
  width: 14px;
  height: 14px;
}

@media (max-width: 1080px) {
  .multi-view-grid {
    grid-template-columns: 1fr;
  }
}
</style>
