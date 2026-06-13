<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue"
import {
  cancelImageTask,
  createImageTask,
  pollImageTask,
} from "@/lib/api"
import {
  dbAddMultiView,
  dbAllMultiViews,
  dbClearMultiViews,
  dbDelMultiView,
  dbGetProductImages,
  dbImageFileUrl,
  dbPutMultiView,
  dbPutProductImage,
} from "@/lib/db"
import { resolveImageSize } from "@/lib/imageOptions"
import { blobToZipBytes, createZip, encodeZipText } from "@/lib/zip"
import type {
  AspectRatio,
  AuthSession,
  ImageQuality,
  MultiViewAngleId,
  MultiViewHistoryItem,
  MultiViewHistoryStatus,
} from "@/lib/types"
import Icon from "./Icon.vue"
import QualitySelector from "./QualitySelector.vue"
import SegmentedControl from "./SegmentedControl.vue"

type MultiViewStatus = MultiViewHistoryStatus

interface MultiViewAngle {
  id: MultiViewAngleId
  title: string
}

interface MultiViewItem extends MultiViewAngle {
  status: MultiViewStatus
  taskId?: string
  imageId?: string
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
  },
  {
    id: "left-side",
    title: "左侧",
  },
  {
    id: "right-side",
    title: "右侧",
  },
  {
    id: "back",
    title: "背面",
  },
  {
    id: "oblique-45",
    title: "45°斜侧",
  },
  {
    id: "top",
    title: "俯视",
  },
  {
    id: "bottom-up",
    title: "仰视",
  },
  {
    id: "detail",
    title: "局部特写",
  },
]

const STATUS_LABEL: Record<MultiViewStatus, string> = {
  draft: "待生成",
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已中断",
}

const fileInputRef = ref<HTMLInputElement | null>(null)
const productImages = ref<string[]>([])
const productImageIds = ref<string[]>([])
const selectedAngleIds = ref<MultiViewAngleId[]>(["front", "left-side", "right-side", "back"])
const aspectRatio = shallowRef<AspectRatio>("1:1")
const quality = shallowRef<ImageQuality>("1K")
const items = ref<MultiViewItem[]>(createViewItems(selectedAngleIds.value))
const busy = shallowRef(false)
const downloadAllBusy = shallowRef(false)
const error = shallowRef<string | null>(null)
const currentTaskIdRef = shallowRef<string | null>(null)
const abortRef = shallowRef<AbortController | null>(null)
const cancelRequestedRef = shallowRef(false)
const history = ref<MultiViewHistoryItem[]>([])
const activeHistoryIdx = shallowRef(-1)
const historyLoadedUserKey = shallowRef<string | null>(null)

const controlsDisabled = computed(() => props.sessionLoading || busy.value || !props.authenticated)
const angleControlsDisabled = computed(() => props.sessionLoading || busy.value)
const sessionUserKey = computed(() => props.session?.user?.userKey ?? props.session?.user?.id ?? null)
const remainingCredits = computed(() =>
  props.session?.user?.role === "super_admin"
    ? "不限次数"
    : `今日剩余 ${props.session?.user?.dailyRemainingCredits ?? props.session?.user?.remainingCredits ?? 0} 次 · 永久 ${props.session?.user?.permanentRemainingCredits ?? 0} 次`,
)
const generationLabel = computed(() =>
  `${aspectRatio.value === "auto" ? "Auto" : aspectRatio.value} · ${quality.value}`,
)
const imageCount = computed(() => selectedAngleIds.value.length)
const completedCount = computed(() =>
  items.value.filter((item) => item.status === "succeeded").length,
)
const runningLabel = computed(() =>
  busy.value ? "生成中" : completedCount.value ? `${completedCount.value}/${items.value.length} 已完成` : "待命",
)

function getSortedAngleIds(angleIds: MultiViewAngleId[]): MultiViewAngleId[] {
  const selected = new Set(angleIds)
  return ANGLE_PRESETS.map((angle) => angle.id).filter((id) => selected.has(id))
}

function createViewItems(angleIds: MultiViewAngleId[]): MultiViewItem[] {
  const selectedIds = getSortedAngleIds(angleIds).slice(0, MAX_MULTI_VIEW_IMAGES)
  const selected = ANGLE_PRESETS.filter((angle) => selectedIds.includes(angle.id))

  return selected.map((angle) => ({
    ...angle,
    status: "draft",
  }))
}

function cloneViewItems(): MultiViewItem[] {
  return items.value.map((item) => ({ ...item }))
}

function getHistoryStatusFromItems(): MultiViewHistoryStatus {
  if (items.value.some((item) => item.status === "queued" || item.status === "running")) return "running"
  if (items.value.some((item) => item.status === "failed")) return "failed"
  if (items.value.length && items.value.every((item) => item.status === "succeeded")) return "succeeded"
  if (items.value.some((item) => item.status === "canceled")) return "canceled"
  return "draft"
}

function syncMultiViewHistoryList(item: MultiViewHistoryItem) {
  const index = history.value.findIndex((historyItem) =>
    item.id != null
      ? historyItem.id === item.id
      : historyItem.createdAt === item.createdAt,
  )
  if (index >= 0) {
    history.value = history.value.map((historyItem, itemIndex) => (itemIndex === index ? { ...item } : historyItem))
    activeHistoryIdx.value = index
  } else {
    history.value = [...history.value, { ...item }]
    activeHistoryIdx.value = history.value.length - 1
  }
}

function updateMultiViewHistorySnapshot(
  item: MultiViewHistoryItem,
  options: { status?: MultiViewHistoryStatus; error?: string | null } = {},
) {
  item.sourceImageIds = productImageIds.value.slice()
  item.aspectRatio = aspectRatio.value
  item.quality = quality.value
  item.results = cloneViewItems()
  item.status = options.status ?? getHistoryStatusFromItems()
  item.error = options.error === undefined ? item.error : options.error || undefined
  item.updatedAt = Date.now()
}

async function persistMultiView(item: MultiViewHistoryItem) {
  try {
    if (item.id == null) {
      const id = await dbAddMultiView(item)
      item.id = id as number
    } else {
      await dbPutMultiView(item)
    }
    syncMultiViewHistoryList(item)
  } catch (event) {
    console.warn("多视角历史写入失败:", event)
  }
}

function isAngleSelected(angleId: MultiViewAngleId) {
  return selectedAngleIds.value.includes(angleId)
}

function handleAngleToggle(angleId: MultiViewAngleId) {
  if (busy.value) return
  const current = selectedAngleIds.value
  const next = current.includes(angleId)
    ? current.filter((id) => id !== angleId)
    : [...current, angleId]
  if (!next.length) return
  selectedAngleIds.value = getSortedAngleIds(next).slice(0, MAX_MULTI_VIEW_IMAGES)
  items.value = createViewItems(selectedAngleIds.value)
}

function handleSelectAllAngles() {
  if (busy.value) return
  const allIds = ANGLE_PRESETS.map((angle) => angle.id)
  selectedAngleIds.value = allIds.slice(0, MAX_MULTI_VIEW_IMAGES)
  items.value = createViewItems(selectedAngleIds.value)
}

function handleClearAllAngles() {
  if (busy.value) return
  const firstId = ANGLE_PRESETS[0]?.id ?? "front"
  selectedAngleIds.value = [firstId]
  items.value = createViewItems(selectedAngleIds.value)
}

function handleResetInput() {
  productImages.value = []
  productImageIds.value = []
  items.value = createViewItems(selectedAngleIds.value)
  activeHistoryIdx.value = -1
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
  productImageIds.value = productImageIds.value.filter((_, imageIndex) => imageIndex !== index)
}

async function getGenerationImageIds() {
  const images = productImages.value.slice(0, 8)
  const nextIds = productImageIds.value.slice(0, images.length)
  const missing = images.map((image, index) => ({ image, index })).filter((item) => !nextIds[item.index])
  const uploadImages = missing
    .map((item) => item.image)
    .filter((image) => image.startsWith("data:image/"))
    .filter((image) => image.length <= MAX_REFERENCE_IMAGE_CHARS)
  const total = uploadImages.reduce((sum, image) => sum + image.length, 0)
  if (!images.length) throw new Error("请至少上传一张商品参考图。")
  if (missing.length && uploadImages.length !== missing.length) {
    throw new Error("商品参考图过大或格式无效，请重新上传图片。")
  }
  if (total > MAX_REFERENCE_IMAGE_TOTAL_CHARS) {
    throw new Error("商品参考图总大小过大，请减少图片数量或重新上传后再生成。")
  }
  const uploadedIds = await Promise.all(uploadImages.map((image) => dbPutProductImage(image)))
  missing.forEach((item, index) => {
    nextIds[item.index] = uploadedIds[index] ?? ""
  })
  const ids = nextIds.filter(Boolean).slice(0, images.length)
  if (!ids.length) throw new Error("请至少上传一张商品参考图。")
  if (ids.length !== images.length) throw new Error("商品参考图保存失败，请重新上传后再试。")
  productImageIds.value = ids
  return ids
}

function updateSessionCredits(result: {
  remainingCredits?: number
  usedCredits?: number
  dailyRemainingCredits?: number
  dailyUsedCredits?: number
  dailyGrantedCredits?: number
  permanentRemainingCredits?: number
  permanentGrantedCredits?: number
  unlimitedCredits?: boolean
}) {
  if (result.unlimitedCredits || !Number.isFinite(result.remainingCredits)) return
  if (!props.session?.user) return
  emit("update:session", {
    ...props.session,
    user: {
      ...props.session.user,
      remainingCredits: result.remainingCredits ?? props.session.user.remainingCredits,
      usedCredits: result.usedCredits ?? props.session.user.usedCredits,
      dailyRemainingCredits: result.dailyRemainingCredits ?? props.session.user.dailyRemainingCredits,
      dailyUsedCredits: result.dailyUsedCredits ?? props.session.user.dailyUsedCredits,
      dailyGrantedCredits: result.dailyGrantedCredits ?? props.session.user.dailyGrantedCredits,
      permanentRemainingCredits: result.permanentRemainingCredits ?? props.session.user.permanentRemainingCredits,
      permanentGrantedCredits: result.permanentGrantedCredits ?? props.session.user.permanentGrantedCredits,
    },
  })
}

function validateGeneration() {
  if (!props.authenticated) {
    error.value = "请先登录后再生成多视角商品图。"
    return false
  }
  if (!productImages.value.length) {
    error.value = "请至少上传一张商品参考图。"
    return false
  }
  return true
}

async function generateView(index: number, generationImageIds: string[], historyItem?: MultiViewHistoryItem) {
  const item = items.value[index]
  if (!item) return

  items.value = items.value.map((view, viewIndex) =>
    viewIndex === index
      ? {
          ...view,
          status: "queued",
          taskId: undefined,
          imageId: undefined,
          model: undefined,
          error: undefined,
          updatedAt: Date.now(),
        }
      : view,
  )
  if (historyItem) {
    updateMultiViewHistorySnapshot(historyItem, { status: "running", error: null })
    await persistMultiView(historyItem)
  }

  const task = await createImageTask(
    {
      mode: "multi-view",
      angleId: item.id,
      size: resolveImageSize(aspectRatio.value),
      aspectRatio: aspectRatio.value,
      quality: quality.value,
      inputImageIds: generationImageIds,
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
  if (historyItem) {
    updateMultiViewHistorySnapshot(historyItem, { status: "running", error: null })
    await persistMultiView(historyItem)
  }

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
    if (historyItem) {
      updateMultiViewHistorySnapshot(historyItem, { status: "failed", error: result.error || "任务执行失败" })
      await persistMultiView(historyItem)
    }
    return
  }

  updateSessionCredits(result)
  if (!result.imageId) throw new Error(`${item.title}未返回图片 ID`)
  items.value = items.value.map((view, viewIndex) =>
    viewIndex === index
      ? {
          ...view,
          status: "succeeded",
          taskId: undefined,
          imageId: result.imageId,
          model: result.model,
          error: undefined,
          updatedAt: Date.now(),
        }
      : view,
  )
  if (historyItem) {
    updateMultiViewHistorySnapshot(historyItem, { status: getHistoryStatusFromItems(), error: null })
    await persistMultiView(historyItem)
  }
  currentTaskIdRef.value = null
}

async function handleGenerateAll() {
  error.value = null
  if (!validateGeneration()) return
  busy.value = true
  cancelRequestedRef.value = false
  abortRef.value = new AbortController()
  items.value = createViewItems(selectedAngleIds.value)
  let historyItem: MultiViewHistoryItem | undefined
  try {
    const generationImageIds = await getGenerationImageIds()
    historyItem = {
      sourceImageIds: generationImageIds,
      aspectRatio: aspectRatio.value,
      quality: quality.value,
      results: cloneViewItems(),
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await persistMultiView(historyItem)
    for (let index = 0; index < items.value.length; index += 1) {
      if (cancelRequestedRef.value) break
      try {
        await generateView(index, generationImageIds, historyItem)
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
        updateMultiViewHistorySnapshot(historyItem, {
          status: "failed",
          error: event instanceof Error ? event.message : String(event),
        })
        await persistMultiView(historyItem)
      }
    }
    const failed = items.value.filter((item) => item.status === "failed").length
    if (failed > 0) error.value = `${failed} 张生成失败，可单独重新生成失败视角。`
    if (historyItem) {
      updateMultiViewHistorySnapshot(historyItem, {
        status: cancelRequestedRef.value ? "canceled" : failed > 0 ? "failed" : "succeeded",
        error: failed > 0 ? error.value : null,
      })
      await persistMultiView(historyItem)
    }
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
    if (historyItem) {
      updateMultiViewHistorySnapshot(historyItem, { status: "failed", error: error.value })
      await persistMultiView(historyItem)
    }
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
  let historyItem = history.value[activeHistoryIdx.value]
  try {
    const generationImageIds = await getGenerationImageIds()
    if (!historyItem) {
      historyItem = {
        sourceImageIds: generationImageIds,
        aspectRatio: aspectRatio.value,
        quality: quality.value,
        results: cloneViewItems(),
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await persistMultiView(historyItem)
    }
    await generateView(index, generationImageIds, historyItem)
    updateMultiViewHistorySnapshot(historyItem, { status: getHistoryStatusFromItems(), error: null })
    await persistMultiView(historyItem)
  } catch (event) {
    if (!(event instanceof DOMException && event.name === "AbortError")) {
      error.value = event instanceof Error ? event.message : String(event)
      if (historyItem) {
        updateMultiViewHistorySnapshot(historyItem, { status: "failed", error: error.value })
        await persistMultiView(historyItem)
      }
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
      ? { ...item, status: item.imageId ? "succeeded" : "draft", taskId: undefined }
      : item,
  )
  const historyItem = history.value[activeHistoryIdx.value]
  if (historyItem) {
    updateMultiViewHistorySnapshot(historyItem, { status: "canceled", error: "多视角生成已中断" })
    void persistMultiView(historyItem)
  }
}

function getResultSrc(item: MultiViewItem) {
  if (item.imageId) return dbImageFileUrl(item.imageId)
  return null
}

function handleDownload(item: MultiViewItem) {
  const src = getResultSrc(item)
  if (!src) return
  const anchor = document.createElement("a")
  anchor.href = src
  anchor.download = `ecom-multi-view-${item.id}.png`
  anchor.click()
}

async function fetchResultBytes(item: MultiViewItem) {
  const src = getResultSrc(item)
  if (!src) throw new Error(`${item.title} 缺少图片`)
  const response = await fetch(src, { cache: "no-store" })
  if (!response.ok) throw new Error(`${item.title} 读取失败`)
  return blobToZipBytes(await response.blob())
}

async function handleDownloadAll() {
  const succeededItems = items.value.filter((item) => item.status === "succeeded")
  if (!succeededItems.length || downloadAllBusy.value) return
  downloadAllBusy.value = true
  error.value = null
  try {
    const imageEntries = await Promise.all(
      succeededItems.map(async (item, index) => ({
        name: `${String(index + 1).padStart(2, "0")}-${item.id}.png`,
        data: await fetchResultBytes(item),
      })),
    )
    const manifest = {
      createdAt: new Date().toISOString(),
      aspectRatio: aspectRatio.value,
      quality: quality.value,
      views: succeededItems.map((item) => ({
        id: item.id,
        title: item.title,
        imageId: item.imageId,
        model: item.model,
      })),
    }
    const zip = createZip([
      ...imageEntries,
      {
        name: "multi-view.json",
        data: encodeZipText(JSON.stringify(manifest, null, 2)),
      },
    ])
    const url = URL.createObjectURL(zip)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `ecom-multi-view-${Date.now()}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (downloadError) {
    error.value = downloadError instanceof Error ? downloadError.message : String(downloadError)
  } finally {
    downloadAllBusy.value = false
  }
}

function getMultiViewHistoryCover(item: MultiViewHistoryItem) {
  const result = item.results.find((view) => view.imageId)
  if (!result) return null
  if (result.imageId) return dbImageFileUrl(result.imageId)
  return null
}

async function handleSelectHistory(index: number) {
  const item = history.value[index]
  if (!item) return
  activeHistoryIdx.value = index
  aspectRatio.value = item.aspectRatio
  quality.value = item.quality
  selectedAngleIds.value = getSortedAngleIds(item.results.map((result) => result.id))
  items.value = getSortedAngleIds(item.results.map((result) => result.id))
    .map((angleId) => item.results.find((result) => result.id === angleId))
    .filter((result): result is MultiViewItem => !!result)
    .map((result) => ({ ...result }))
  productImageIds.value = item.sourceImageIds?.slice() ?? []
  productImages.value = await dbGetProductImages(productImageIds.value)
  error.value = item.error ?? null
}

function handleDeleteHistory(index: number) {
  const item = history.value[index]
  if (!item) return
  if (item.id != null) dbDelMultiView(item.id).catch((event) => console.warn(event))
  history.value = history.value.filter((_, itemIndex) => itemIndex !== index)
  if (activeHistoryIdx.value === index) {
    activeHistoryIdx.value = history.value.length ? Math.min(index, history.value.length - 1) : -1
  } else if (activeHistoryIdx.value > index) {
    activeHistoryIdx.value -= 1
  }
}

async function handleClearHistory() {
  if (!confirm("确定清空所有多视角历史？此操作不可撤销。")) return
  await dbClearMultiViews()
  history.value = []
  activeHistoryIdx.value = -1
}

async function loadMultiViewHistoryIfAuthenticated() {
  const userKey = sessionUserKey.value
  if (
    props.sessionLoading ||
    !props.authenticated ||
    !userKey ||
    historyLoadedUserKey.value === userKey
  ) {
    return
  }
  historyLoadedUserKey.value = userKey
  try {
    const items = await dbAllMultiViews()
    history.value = items
    activeHistoryIdx.value = items.length ? items.length - 1 : -1
  } catch (event) {
    console.warn("多视角历史读取失败:", event)
  }
}

watch(
  () => [props.sessionLoading, props.authenticated, sessionUserKey.value] as const,
  () => {
    void loadMultiViewHistoryIfAuthenticated()
  },
  { immediate: true },
)
</script>

<template>
  <div class="run-status" aria-label="当前多视角任务状态">
    <span>{{ imageCount }} 个视角</span>
    <span>{{ productImages.length ? `${productImages.length} 张参考图` : "未上传参考图" }}</span>
    <span>{{ remainingCredits }}</span>
    <span>{{ generationLabel }}</span>
    <span>{{ runningLabel }}</span>
  </div>

  <div class="multi-view-grid">
    <aside class="studio-panel input-rail multi-view-input">
      <div class="panel-heading">
        <h2>商品资料</h2>
        <button
          type="button"
          class="inline-action panel-reset-action"
          :disabled="busy"
          @click="handleResetInput"
        >
          重置
        </button>
      </div>

      <div class="input-rail-body multi-view-input-body">
        <div class="field-row-head">
          <label for="multi-view-images">商品参考图</label>
          <button
            v-if="productImages.length > 0"
            type="button"
            class="inline-action"
            :disabled="controlsDisabled"
            @click="productImages = []; productImageIds = []"
          >
            清空
          </button>
        </div>
        <div class="product-media multi-view-media">
          <div
            v-for="(src, index) in productImages"
            :key="`${src.slice(0, 32)}-${index}`"
            class="prompt-thumb"
          >
            <button
              type="button"
              class="prompt-thumb-preview"
              :aria-label="`查看商品参考图 ${index + 1}`"
              @click="emit('zoom', src)"
            >
              <img :src="src" :alt="`商品参考图 ${index + 1}`">
            </button>
            <button
              type="button"
              class="prompt-thumb-del"
              :disabled="controlsDisabled"
              :aria-label="`移除商品参考图 ${index + 1}`"
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
          aria-label="上传商品参考图"
          accept="image/*"
          multiple
          hidden
          @change="event => handleSelectFiles((event.target as HTMLInputElement).files)"
        >

        <div class="multi-view-note">
          <strong>白底商品图</strong>
          <p>系统自动分配标准角度，只输出商品本体。参考图越多，背面、侧面和底部越稳定。</p>
        </div>

        <div class="settings-row multi-view-settings">
          <div class="setting-block">
            <div class="setting-head">
              <label>视角</label>
              <div style="display: flex; align-items: center; gap: 8px;">
                <button
                  type="button"
                  class="btn-link-preset"
                  style="font-size: 0.75rem; color: var(--accent); background: none; border: none; padding: 0; cursor: pointer; font-weight: bold; text-decoration: none;"
                  :disabled="angleControlsDisabled"
                  @click="handleSelectAllAngles"
                >全选</button>
                <span style="color: var(--border); font-size: 0.75rem; opacity: 0.5;">|</span>
                <button
                  type="button"
                  class="btn-link-preset"
                  style="font-size: 0.75rem; color: var(--text-sub); background: none; border: none; padding: 0; cursor: pointer; font-weight: bold; text-decoration: none;"
                  :disabled="angleControlsDisabled"
                  @click="handleClearAllAngles"
                >复位</button>
                <span style="margin-left: 4px; font-weight: 700; color: var(--text-strong);">{{ imageCount }} 张</span>
              </div>
            </div>
            <div class="param-controls" aria-label="视角">
              <div class="multi-view-angle-options" role="group" aria-label="选择视角">
                <button
                  v-for="angle in ANGLE_PRESETS"
                  :key="angle.id"
                  type="button"
                  :class="['multi-view-angle-option', { 'is-selected': isAngleSelected(angle.id) }]"
                  :aria-pressed="isAngleSelected(angle.id)"
                  :disabled="angleControlsDisabled"
                  @click="handleAngleToggle(angle.id)"
                >
                  {{ angle.title }}
                </button>
              </div>
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
                class-name="multi-view-ratio-segments"
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

    <section class="studio-panel canvas-panel multi-view-results">
      <div class="panel-heading" style="display: flex; align-items: center; justify-content: space-between;">
        <h2>视角结果</h2>
        <div style="display: flex; align-items: center; gap: 12px;">
          <button
            v-if="completedCount > 0"
            type="button"
            class="btn-ghost"
            style="min-height: 28px; padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: var(--radius-control);"
            :disabled="downloadAllBusy"
            @click="handleDownloadAll"
          >
            <Icon name="download" />
            {{ downloadAllBusy ? "打包中" : "下载全部" }}
          </button>
          <span class="panel-count">{{ completedCount }} / {{ items.length }}</span>
        </div>
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

  <section class="studio-panel history-dock cutout-history-dock multi-view-history-dock">
    <div class="history-bar">
      <h2>多视角历史</h2>
      <button type="button" class="inline-action" :disabled="!history.length" @click="handleClearHistory">
        清空历史
      </button>
    </div>
    <div v-if="history.length" class="cutout-history-grid">
      <article
        v-for="(item, index) in history"
        :key="item.id ?? `${item.createdAt}-${index}`"
        :class="['cutout-history-card', { 'is-active': index === activeHistoryIdx }]"
      >
        <button type="button" class="cutout-history-main" @click="handleSelectHistory(index)">
          <div class="cutout-history-image multi-view-history-image">
            <img v-if="getMultiViewHistoryCover(item)" :src="getMultiViewHistoryCover(item)!" alt="多视角历史结果">
            <span v-else>{{ item.status === "failed" ? "失败" : "处理中" }}</span>
          </div>
          <div>
            <strong>
              {{
                item.status === "succeeded"
                  ? "多视角白底图"
                  : item.status === "failed"
                    ? "多视角失败"
                    : item.status === "canceled"
                      ? "已中断"
                      : "处理中"
              }}
            </strong>
            <p>{{ item.error || `${item.results.filter(result => result.imageId).length}/${item.results.length} 张视角图` }}</p>
            <small>{{ new Date(item.createdAt).toLocaleString() }}</small>
          </div>
        </button>
        <button type="button" class="tile-del" aria-label="删除多视角历史" @click="handleDeleteHistory(index)">
          <Icon name="trash" />
        </button>
      </article>
    </div>
    <div v-else class="empty">暂无多视角历史。</div>
  </section>
</template>

<style scoped>
.multi-view-grid {
  display: grid;
  grid-template-columns: minmax(292px, 348px) minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
  margin-top: 12px;
}

.multi-view-input,
.multi-view-results {
  height: var(--workbench-h);
  min-height: var(--workbench-h);
}

.multi-view-input-body {
  display: grid;
  gap: 10px;
}

.multi-view-note {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid rgba(15, 118, 110, 0.18);
  border-radius: var(--radius-control);
  background: var(--teal-soft);
}

.multi-view-note strong {
  color: var(--teal);
  font-size: 0.8125rem;
}

.multi-view-note p {
  margin: 0;
  color: var(--text-sub);
  font-size: 0.8125rem;
  line-height: 1.55;
  text-wrap: pretty;
}

.multi-view-media {
  min-height: 82px;
  padding: 8px;
}

.multi-view-media .prompt-upload-tile,
.multi-view-media .prompt-thumb {
  width: 66px;
  height: 66px;
}

.multi-view-settings {
  margin-bottom: 0;
}

.multi-view-results {
  overflow: hidden;
}

.multi-view-result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  align-content: start;
  align-items: start;
  min-height: 0;
  overflow: auto;
  padding: 14px;
}

.multi-view-card {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 10px;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(211, 219, 231, 0.82);
  border-radius: var(--radius-control);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.24)),
    var(--bg-soft);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.68) inset;
}

.multi-view-card.is-succeeded {
  border-color: rgba(15, 118, 110, 0.3);
  box-shadow:
    0 0 0 3px rgba(15, 118, 110, 0.08),
    0 1px 0 rgba(255, 255, 255, 0.68) inset;
}

.multi-view-card.is-failed {
  border-color: rgba(200, 50, 43, 0.3);
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
  border: 1px solid var(--accent);
  border-radius: 7px;
  color: #fff;
  font-size: 0.8125rem;
  font-weight: 700;
  background: var(--accent);
}

.multi-view-card-head strong {
  overflow: hidden;
  color: var(--text);
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-view-card-head em {
  color: var(--text-sub);
  font-size: 0.75rem;
  font-weight: 700;
  font-style: normal;
}

.multi-view-preview {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid rgba(174, 184, 199, 0.62);
  border-radius: 6px;
  background:
    linear-gradient(rgba(17, 24, 39, 0.024) 1px, transparent 1px),
    linear-gradient(90deg, rgba(17, 24, 39, 0.024) 1px, transparent 1px),
    #fff;
  background-size: 24px 24px;
  color: var(--muted);
  cursor: zoom-in;
}

.multi-view-preview:disabled {
  cursor: default;
}

.multi-view-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #fff;
}

.multi-view-preview svg {
  width: 34px;
  height: 34px;
}

.multi-view-history-dock {
  margin-top: 12px;
}

.multi-view-history-image img {
  background: #fff;
  object-fit: contain;
}

.multi-view-error {
  margin: 0;
  color: var(--danger);
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

.multi-view-angle-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  padding: 5px;
  border: 1px solid rgba(211, 219, 231, 0.72);
  border-radius: var(--radius-control);
  background: #edf3f8;
}

.multi-view-angle-option {
  position: relative;
  min-height: 34px;
  padding: 0 20px 0 8px;
  border: 1px solid rgba(203, 215, 230, 0.86);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.6);
  color: var(--text-sub);
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.18s var(--ease),
    border-color 0.18s var(--ease),
    box-shadow 0.18s var(--ease),
    color 0.18s var(--ease);
}

.multi-view-angle-option:hover:not(:disabled) {
  border-color: rgba(23, 105, 255, 0.45);
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.multi-view-angle-option.is-selected {
  border-color: rgba(23, 105, 255, 0.62);
  background: linear-gradient(180deg, #fff 0%, #f4f8ff 100%);
  color: var(--accent-ink);
  box-shadow:
    inset 0 0 0 1px rgba(23, 105, 255, 0.1),
    0 4px 12px rgba(23, 105, 255, 0.1);
}

.multi-view-angle-option.is-selected::after {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  content: "";
  transform: translateY(-50%);
}

.multi-view-angle-option:disabled {
  cursor: not-allowed;
  opacity: 0.64;
}

:deep(.multi-view-ratio-segments) {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 5px;
}

:deep(.multi-view-ratio-segments .segment-option) {
  min-height: 34px;
  font-size: 0.75rem;
}

@media (max-width: 1080px) {
  .multi-view-grid {
    grid-template-columns: 1fr;
  }

  .multi-view-input,
  .multi-view-results {
    position: static;
    height: auto;
    max-height: none;
    min-height: 0;
  }

  .multi-view-result-grid {
    max-height: none;
  }
}
</style>
