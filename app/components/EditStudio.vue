<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  cancelEditTask,
  createEditTask,
  pollEditTask,
} from "@/lib/api"
import {
  dbAddEdit,
  dbAllEdits,
  dbClearEdits,
  dbDelEdit,
  dbGetProductImages,
  dbImageFileUrl,
  dbPutEdit,
  dbPutProductImage,
} from "@/lib/db"
import type { AuthSession, EditHistoryItem } from "@/lib/types"
import Icon from "./Icon.vue"

type PaintMode = "brush" | "eraser"

const props = defineProps<{
  authenticated: boolean
  sessionLoading: boolean
  session: AuthSession | null
}>()

const emit = defineEmits<{
  "update:session": [session: AuthSession | null]
  zoom: [src: string]
}>()

const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024
const CANVAS_EDGE = 960
const MASK_HISTORY_LIMIT = 18

const sourceImage = shallowRef<string | null>(null)
const sourceImageId = shallowRef<string | undefined>()
const resultImageId = shallowRef<string | undefined>()
const editInstruction = shallowRef("")
const history = ref<EditHistoryItem[]>([])
const activeHistoryIdx = shallowRef(-1)
const brushSize = shallowRef(34)
const mode = shallowRef<PaintMode>("brush")
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
const canvasReady = shallowRef(false)
const maskDirty = shallowRef(false)
const historyStack = ref<string[]>([])
const canvasSize = ref({ width: 0, height: 0 })
const canvasZoom = shallowRef(1)
const cursorPreview = ref({ visible: false, x: 0, y: 0 })
const historyLoadedUserKey = shallowRef<string | null>(null)

const fileInputRef = ref<HTMLInputElement | null>(null)
const imageCanvasRef = ref<HTMLCanvasElement | null>(null)
const maskCanvasRef = ref<HTMLCanvasElement | null>(null)
const drawingRef = shallowRef(false)
const lastPointRef = shallowRef<{ x: number; y: number } | null>(null)
const abortRef = shallowRef<AbortController | null>(null)
const taskIdRef = shallowRef<string | null>(null)
const pendingMaskRef = shallowRef<string | null>(null)
const pendingCanvasZoomRef = shallowRef<number | null>(null)

const creditLabel = computed(() =>
  `今日剩余 ${props.session?.user?.dailyRemainingCredits ?? props.session?.user?.remainingCredits ?? 0} 次 · 永久 ${props.session?.user?.permanentRemainingCredits ?? 0} 次`,
)
const isSuperAdmin = computed(() => props.session?.user?.role === "super_admin")
const sessionUserKey = computed(() => props.session?.user?.userKey ?? props.session?.user?.id ?? null)
const controlsDisabled = computed(() => props.sessionLoading || busy.value || !props.authenticated)
const resultSrc = computed(() => (resultImageId.value ? dbImageFileUrl(resultImageId.value) : null))
const canvasStyle = computed(() =>
  canvasSize.value.width && canvasSize.value.height
    ? {
        width: `${Math.round(canvasSize.value.width * canvasZoom.value)}px`,
        height: `${Math.round(canvasSize.value.height * canvasZoom.value)}px`,
      }
    : undefined,
)

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getPointerPoint(event: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  }
}

function getCursorPreviewPoint(event: PointerEvent, canvas: HTMLCanvasElement) {
  const stage = canvas.parentElement
  const rect = stage?.getBoundingClientRect() ?? canvas.getBoundingClientRect()
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
}

function drawMaskCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  paintMode: PaintMode,
) {
  ctx.save()
  ctx.globalCompositeOperation = paintMode === "eraser" ? "destination-out" : "source-over"
  ctx.fillStyle = "rgba(23,105,255,0.92)"
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function hasMaskPixels(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return false
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) > 8) return true
  }
  return false
}

function redrawSource(dataUrl: string) {
  const imageCanvas = imageCanvasRef.value
  const maskCanvas = maskCanvasRef.value
  if (!imageCanvas || !maskCanvas) return

  const image = new Image()
  image.onload = () => {
    const scale = Math.min(1, CANVAS_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    imageCanvas.width = width
    imageCanvas.height = height
    maskCanvas.width = width
    maskCanvas.height = height
    canvasSize.value = { width, height }
    canvasZoom.value = pendingCanvasZoomRef.value ?? 1
    pendingCanvasZoomRef.value = null
    const ctx = imageCanvas.getContext("2d")
    const maskCtx = maskCanvas.getContext("2d")
    if (!ctx || !maskCtx) return
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(image, 0, 0, width, height)
    maskCtx.clearRect(0, 0, width, height)
    const pendingMask = pendingMaskRef.value
    if (pendingMask) {
      const maskImage = new Image()
      maskImage.onload = () => {
        maskCtx.clearRect(0, 0, width, height)
        maskCtx.drawImage(maskImage, 0, 0, width, height)
        maskDirty.value = hasMaskPixels(maskCanvas)
        pendingMaskRef.value = null
      }
      maskImage.src = pendingMask
    } else {
      maskDirty.value = false
    }
    canvasReady.value = true
    historyStack.value = []
  }
  image.onerror = () => {
    error.value = "图片读取失败，请重新上传。"
  }
  image.src = dataUrl
}

async function persistEdit(item: EditHistoryItem) {
  try {
    if (item.id == null) {
      const id = await dbAddEdit(item)
      item.id = id as number
    } else {
      await dbPutEdit(item)
    }
  } catch (event) {
    console.warn("改图历史写入失败:", event)
  }
}

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = null
  if (!file.type.startsWith("image/")) {
    error.value = "请上传图片文件。"
    return
  }
  if (file.size > MAX_EDIT_IMAGE_BYTES) {
    error.value = "图片过大，请上传 10MB 以内的图片。"
    return
  }
  try {
    const dataUrl = await fileToDataUrl(file)
    const id = await dbPutProductImage(dataUrl)
    pendingMaskRef.value = null
    pendingCanvasZoomRef.value = null
    sourceImage.value = dataUrl
    sourceImageId.value = id
    resultImageId.value = undefined
    canvasZoom.value = 1
    activeHistoryIdx.value = -1
  } catch (uploadError) {
    error.value = uploadError instanceof Error ? uploadError.message : String(uploadError)
  } finally {
    if (fileInputRef.value) fileInputRef.value.value = ""
  }
}

function pushMaskHistory() {
  const maskCanvas = maskCanvasRef.value
  if (!maskCanvas) return
  historyStack.value = [
    ...historyStack.value,
    maskCanvas.toDataURL("image/png"),
  ].slice(-MASK_HISTORY_LIMIT)
}

function handlePointerDown(event: PointerEvent) {
  const canvas = maskCanvasRef.value
  if (!canvas || controlsDisabled.value || !sourceImage.value) return
  event.preventDefault()
  pushMaskHistory()
  drawingRef.value = true
  canvas.setPointerCapture(event.pointerId)
  const point = getPointerPoint(event, canvas)
  lastPointRef.value = point
  cursorPreview.value = { visible: true, ...getCursorPreviewPoint(event, canvas) }
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  drawMaskCircle(ctx, point.x, point.y, brushSize.value / 2, mode.value)
  maskDirty.value = hasMaskPixels(canvas)
}

function handlePointerMove(event: PointerEvent) {
  const canvas = maskCanvasRef.value
  if (!canvas || controlsDisabled.value || !sourceImage.value) return
  event.preventDefault()
  cursorPreview.value = { visible: true, ...getCursorPreviewPoint(event, canvas) }
  if (!drawingRef.value) return
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const next = getPointerPoint(event, canvas)
  const last = lastPointRef.value ?? next
  const distance = Math.hypot(next.x - last.x, next.y - last.y)
  const steps = Math.max(1, Math.ceil(distance / Math.max(4, brushSize.value / 4)))
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps
    drawMaskCircle(
      ctx,
      last.x + (next.x - last.x) * progress,
      last.y + (next.y - last.y) * progress,
      brushSize.value / 2,
      mode.value,
    )
  }
  lastPointRef.value = next
  maskDirty.value = hasMaskPixels(canvas)
}

function handlePointerEnter(event: PointerEvent) {
  const canvas = maskCanvasRef.value
  if (!canvas || controlsDisabled.value || !sourceImage.value) return
  cursorPreview.value = { visible: true, ...getCursorPreviewPoint(event, canvas) }
}

function finishDrawing(event: PointerEvent) {
  const canvas = maskCanvasRef.value
  if (canvas && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId)
  }
  drawingRef.value = false
  lastPointRef.value = null
}

function hideCursorPreview(event: PointerEvent) {
  finishDrawing(event)
  cursorPreview.value = { ...cursorPreview.value, visible: false }
}

function handleUndo() {
  const maskCanvas = maskCanvasRef.value
  const last = historyStack.value.at(-1)
  if (!maskCanvas || !last) return
  const image = new Image()
  image.onload = () => {
    const ctx = maskCanvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
    ctx.drawImage(image, 0, 0, maskCanvas.width, maskCanvas.height)
    maskDirty.value = hasMaskPixels(maskCanvas)
  }
  image.src = last
  historyStack.value = historyStack.value.slice(0, -1)
}

function handleClearMask() {
  const maskCanvas = maskCanvasRef.value
  if (!maskCanvas) return
  const ctx = maskCanvas.getContext("2d")
  if (!ctx) return
  pushMaskHistory()
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  maskDirty.value = false
}

function exportMaskImage() {
  const maskCanvas = maskCanvasRef.value
  if (!maskCanvas || !hasMaskPixels(maskCanvas)) {
    throw new Error("请先涂抹需要修改的区域。")
  }
  const output = document.createElement("canvas")
  output.width = maskCanvas.width
  output.height = maskCanvas.height
  const ctx = output.getContext("2d")
  if (!ctx) throw new Error("浏览器不支持生成 mask 图片。")
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, output.width, output.height)
  const sourceCtx = maskCanvas.getContext("2d")
  if (!sourceCtx) throw new Error("浏览器不支持读取涂抹区域。")
  const sourcePixels = sourceCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  const outputPixels = ctx.getImageData(0, 0, output.width, output.height)
  for (let index = 0; index < sourcePixels.data.length; index += 4) {
    if ((sourcePixels.data[index + 3] ?? 0) > 8) {
      outputPixels.data[index] = 255
      outputPixels.data[index + 1] = 255
      outputPixels.data[index + 2] = 255
      outputPixels.data[index + 3] = 255
    }
  }
  ctx.putImageData(outputPixels, 0, 0)
  return output.toDataURL("image/png")
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

async function handleGenerate() {
  error.value = null
  if (!props.authenticated) {
    error.value = "请先登录后再使用改图。"
    return
  }
  if (!sourceImage.value || !sourceImageId.value) {
    error.value = "请先上传一张需要改图的商品图片。"
    return
  }
  const instruction = editInstruction.value.trim()
  if (!instruction) {
    error.value = "请输入需要更改的内容。"
    return
  }
  let apiMaskImage: string
  try {
    apiMaskImage = exportMaskImage()
  } catch (maskError) {
    error.value = maskError instanceof Error ? maskError.message : String(maskError)
    return
  }

  busy.value = true
  abortRef.value = new AbortController()
  let item: EditHistoryItem = {
    sourceImageId: sourceImageId.value,
    instruction,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  try {
    const editorMaskImage = maskCanvasRef.value?.toDataURL("image/png")
    const maskImageId = editorMaskImage ? await dbPutProductImage(editorMaskImage) : undefined
    const taskMaskImageId = await dbPutProductImage(apiMaskImage)
    item = { ...item, maskImageId }
    await persistEdit(item)
    history.value = [...history.value, item]
    activeHistoryIdx.value = history.value.length - 1

    const created = await createEditTask(
      {
        sourceImageId: sourceImageId.value,
        maskImageId: taskMaskImageId,
        instruction,
      },
      abortRef.value.signal,
    )
    taskIdRef.value = created.taskId
    updateSessionCredits(created)
    item = { ...item, taskId: created.taskId, status: "running", updatedAt: Date.now() }
    await persistEdit(item)
    history.value = history.value.map((historyItem) =>
      historyItem.id === item.id ? item : historyItem,
    )

    const result = await pollEditTask(created.taskId, undefined, abortRef.value.signal)
    if (result.status === "canceled") {
      item = { ...item, status: "canceled", error: "改图已中断", updatedAt: Date.now() }
      await persistEdit(item)
      history.value = history.value.map((historyItem) =>
        historyItem.id === item.id ? item : historyItem,
      )
      return
    }
    if (result.status === "failed") {
      const message = result.error || "改图失败"
      item = { ...item, status: "failed", error: message, updatedAt: Date.now() }
      await persistEdit(item)
      history.value = history.value.map((historyItem) =>
        historyItem.id === item.id ? item : historyItem,
      )
      error.value = message
      return
    }
    updateSessionCredits(result)
    if (!result.imageId) throw new Error("改图任务未返回图片 ID")
    item = {
      ...item,
      status: "succeeded",
      taskId: undefined,
      error: undefined,
      model: result.model,
      resultImageId: result.imageId,
      updatedAt: Date.now(),
    }
    resultImageId.value = result.imageId
    await persistEdit(item)
    resultImageId.value = item.resultImageId
    history.value = history.value.map((historyItem) =>
      historyItem.id === item.id ? item : historyItem,
    )
  } catch (generateError) {
    if (generateError instanceof DOMException && generateError.name === "AbortError") {
      item = { ...item, status: "canceled", error: "改图已中断", updatedAt: Date.now() }
      await persistEdit(item)
    } else {
      const message = generateError instanceof Error ? generateError.message : String(generateError)
      item = { ...item, status: "failed", error: message, updatedAt: Date.now() }
      await persistEdit(item)
      error.value = message
    }
    history.value = history.value.map((historyItem) =>
      historyItem.id === item.id ? item : historyItem,
    )
  } finally {
    taskIdRef.value = null
    abortRef.value = null
    busy.value = false
  }
}

function handleCancel() {
  const taskId = taskIdRef.value
  if (taskId) cancelEditTask(taskId).catch((event) => console.warn("取消改图任务失败:", event))
  abortRef.value?.abort()
  busy.value = false
}

async function handleSelectHistory(index: number) {
  const item = history.value[index]
  if (!item) return
  activeHistoryIdx.value = index
  editInstruction.value = item.instruction
  resultImageId.value = item.resultImageId
  error.value = item.error ?? null
  if (item.sourceImageId) {
    const [restored] = await dbGetProductImages([item.sourceImageId])
    if (item.maskImageId) {
      const [restoredMask] = await dbGetProductImages([item.maskImageId])
      pendingMaskRef.value = restoredMask ?? null
    } else {
      pendingMaskRef.value = null
    }
    if (restored) {
      sourceImageId.value = item.sourceImageId
      sourceImage.value = restored
    }
  }
}

function handleDeleteHistory(index: number) {
  const item = history.value[index]
  if (!item) return
  if (item.id != null) dbDelEdit(item.id).catch((event) => console.warn(event))
  history.value = history.value.filter((_, itemIndex) => itemIndex !== index)
  if (activeHistoryIdx.value === index) {
    activeHistoryIdx.value = history.value.length ? Math.min(index, history.value.length - 1) : -1
  } else if (activeHistoryIdx.value > index) {
    activeHistoryIdx.value -= 1
  }
}

async function handleClearHistory() {
  if (!confirm("确定清空所有改图历史？此操作不可撤销。")) return
  await dbClearEdits()
  history.value = []
  activeHistoryIdx.value = -1
}

function handleDownload() {
  if (!resultSrc.value) return
  const anchor = document.createElement("a")
  anchor.href = resultSrc.value
  anchor.download = `ecom-edit-${Date.now()}.png`
  anchor.click()
}

function getEditResultSrc(item: EditHistoryItem) {
  if (item.resultImageId) return dbImageFileUrl(item.resultImageId)
  return null
}

async function loadEditHistoryIfAuthenticated() {
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
    const items = await dbAllEdits()
    history.value = items
    activeHistoryIdx.value = items.length ? items.length - 1 : -1
  } catch (event) {
    console.warn("改图历史读取失败:", event)
  }
}

function handleGlobalKeyDown(event: KeyboardEvent) {
  const activeEl = document.activeElement as HTMLElement | null
  if (
    activeEl &&
    (activeEl.tagName === "INPUT" ||
      activeEl.tagName === "TEXTAREA" ||
      activeEl.isContentEditable)
  ) {
    return
  }

  const key = event.key.toLowerCase()

  if (key === "b" && !event.ctrlKey && !event.metaKey) {
    mode.value = "brush"
  } else if (key === "e" && !event.ctrlKey && !event.metaKey) {
    mode.value = "eraser"
  } else if (event.key === "[") {
    brushSize.value = clamp(brushSize.value - 4, 12, 96)
  } else if (event.key === "]") {
    brushSize.value = clamp(brushSize.value + 4, 12, 96)
  } else if (key === "z" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    handleUndo()
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleGlobalKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeyDown)
})

watch(sourceImage, (next) => {
  if (next) redrawSource(next)
})

watch(
  () => [props.sessionLoading, props.authenticated, sessionUserKey.value] as const,
  () => {
    void loadEditHistoryIfAuthenticated()
  },
  { immediate: true },
)
</script>

<template>
  <div class="run-status cutout-status" aria-label="改图任务状态">
    <span>{{ sourceImage ? "原图已上传" : "等待上传" }}</span>
    <span>{{ maskDirty ? "已涂抹区域" : "未涂抹" }}</span>
    <span>{{ isSuperAdmin ? "不限次数" : creditLabel }}</span>
    <span>{{ busy ? "改图中" : "待命" }}</span>
  </div>

  <div class="cutout-grid edit-grid">
    <aside class="studio-panel cutout-panel cutout-source-panel edit-source-panel">
      <div class="panel-heading">
        <h2>商品原图</h2>
        <span class="panel-count">改图</span>
      </div>
      <div class="cutout-panel-body">
        <button
          type="button"
          :class="['cutout-upload-zone', { 'has-image': sourceImage }]"
          :disabled="controlsDisabled"
          @click="fileInputRef?.click()"
        >
          <img v-if="sourceImage" :src="sourceImage" alt="待改图商品原图">
          <span v-else>
            <Icon name="upload" />
            <strong>上传商品图片</strong>
            <small>建议使用商品清晰、主体完整的图片</small>
          </span>
        </button>
        <input ref="fileInputRef" type="file" accept="image/*" hidden @change="handleFileChange">
        <div class="cutout-source-actions">
          <button type="button" class="btn-ghost" :disabled="controlsDisabled" @click="fileInputRef?.click()">
            <Icon name="upload" />
            更换图片
          </button>
          <button type="button" class="btn-ghost" :disabled="!sourceImage" @click="sourceImage && emit('zoom', sourceImage)">
            <Icon name="zoom" />
            查看原图
          </button>
        </div>
        <label class="edit-instruction-field">
          <span>修改内容</span>
          <textarea
            v-model="editInstruction"
            :disabled="controlsDisabled"
            maxlength="600"
            placeholder="例如：把涂抹区域改成哑光黑色；去掉划痕；把标签换成金色边框"
          />
        </label>
        <div class="cutout-help">
          <strong>操作逻辑</strong>
          <p>先涂抹需要修改的局部，再输入修改内容。系统只改涂抹区域，其余画面尽量保持不变。</p>
        </div>
      </div>
      <div v-if="error" class="alert cutout-alert">{{ error }}</div>
    </aside>

    <section class="studio-panel cutout-panel cutout-canvas-panel">
      <div class="panel-heading">
        <h2>涂抹区域</h2>
        <span class="panel-count">{{ brushSize }}px</span>
      </div>
      <div class="cutout-toolbar">
        <div class="tool-segment">
          <button type="button" :class="{ 'is-active': mode === 'brush' }" :disabled="controlsDisabled" @click="mode = 'brush'">
            <Icon name="brush" />
            画笔
          </button>
          <button type="button" :class="{ 'is-active': mode === 'eraser' }" :disabled="controlsDisabled" @click="mode = 'eraser'">
            <Icon name="eraser" />
            橡皮
          </button>
        </div>
         <label class="brush-slider">
          <span>笔刷 ({{ brushSize }}px)</span>
          <div class="brush-slider-wrap" style="display: flex; align-items: center; gap: 10px; flex: 1; width: 100%;">
            <input
              type="range"
              min="12"
              max="96"
              :value="brushSize"
              :disabled="controlsDisabled"
              @input="event => brushSize = clamp(Number((event.target as HTMLInputElement).value), 12, 96)"
              style="flex: 1;"
            >
            <div
              class="brush-size-dot-preview"
              :style="{
                width: `${brushSize}px`,
                height: `${brushSize}px`,
                maxWidth: '24px',
                maxHeight: '24px',
                borderRadius: '50%',
                background: mode === 'eraser' ? 'rgba(239, 68, 68, 0.5)' : 'rgba(23, 105, 255, 0.5)',
                border: '1px solid #fff',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                flexShrink: 0,
                transition: 'width 0.1s, height 0.1s, background-color 0.1s'
              }"
            />
          </div>
        </label>
        <div class="cutout-toolbar-actions">
          <div class="cutout-zoom-actions" aria-label="画布缩放">
            <button type="button" class="btn-ghost" :disabled="!sourceImage" @click="canvasZoom = clamp(canvasZoom - 0.15, 0.45, 2.2)">-</button>
            <span>{{ Math.round(canvasZoom * 100) }}%</span>
            <button type="button" class="btn-ghost" :disabled="!sourceImage" @click="canvasZoom = clamp(canvasZoom + 0.15, 0.45, 2.2)">+</button>
            <button type="button" class="btn-ghost" :disabled="!sourceImage || canvasZoom === 1" @click="canvasZoom = 1">复位</button>
          </div>
          <button type="button" class="btn-ghost" :disabled="controlsDisabled || !historyStack.length" @click="handleUndo">
            <Icon name="undo" />
            撤销
          </button>
          <button type="button" class="btn-ghost" :disabled="controlsDisabled || !maskDirty" @click="handleClearMask">
            清空
          </button>
        </div>
      </div>
      <div class="cutout-canvas-wrap">
        <div :class="['cutout-canvas-stage', { 'has-image': sourceImage, 'is-busy': busy }]">
          <canvas ref="imageCanvasRef" aria-hidden="true" :style="canvasStyle" />
          <canvas
            ref="maskCanvasRef"
            class="cutout-mask-canvas"
            :style="canvasStyle"
            aria-label="涂抹需要修改的商品区域"
            @pointerenter="handlePointerEnter"
            @pointerdown="handlePointerDown"
            @pointermove="handlePointerMove"
            @pointerup="finishDrawing"
            @pointercancel="hideCursorPreview"
            @pointerleave="hideCursorPreview"
          />
          <span
            v-if="sourceImage && cursorPreview.visible && !busy"
            :class="['cutout-brush-cursor', `is-${mode}`]"
            aria-hidden="true"
            :style="{
              width: `${Math.max(10, brushSize * canvasZoom)}px`,
              height: `${Math.max(10, brushSize * canvasZoom)}px`,
              left: `${cursorPreview.x}px`,
              top: `${cursorPreview.y}px`,
            }"
          />
          <div v-if="!sourceImage" class="cutout-canvas-empty">
            <Icon name="brush" />
            <span>上传图片后在这里涂抹需要修改的区域</span>
          </div>
          <div v-if="busy" class="cutout-busy-layer">
            <span class="busy-orbit" aria-hidden="true" />
            <strong>正在改图</strong>
            <p>正在根据涂抹区域和修改内容生成结果。</p>
          </div>
        </div>
      </div>
      <div class="cutout-action-bar">
        <button v-if="busy" type="button" class="btn-danger" @click="handleCancel">
          中断改图
        </button>
        <button
          v-else
          type="button"
          class="btn-primary"
          :disabled="controlsDisabled || !sourceImage || !canvasReady || !maskDirty || !editInstruction.trim()"
          @click="handleGenerate"
        >
          <Icon name="brush" />
          开始改图
        </button>
      </div>
    </section>

    <section class="studio-panel cutout-panel cutout-result-panel">
      <div class="panel-heading">
        <h2>改图结果</h2>
        <span class="panel-count">{{ resultSrc ? "已生成" : "预览" }}</span>
      </div>
      <div class="cutout-result-stage">
        <template v-if="resultSrc">
          <button type="button" class="cutout-result-image" @click="emit('zoom', resultSrc)">
            <img :src="resultSrc" alt="商品改图结果">
          </button>
          <div class="stage-actions">
            <button type="button" class="btn-ghost" @click="handleDownload">
              <Icon name="download" />
              下载
            </button>
            <button type="button" class="btn-ghost" @click="emit('zoom', resultSrc)">
              <Icon name="zoom" />
              放大
            </button>
          </div>
        </template>
        <div v-else class="stage-placeholder cutout-result-empty">
          <Icon name="image" class="icon-large" />
          <div class="icon-hint">改图结果会显示在这里</div>
        </div>
      </div>
    </section>
  </div>

  <section class="studio-panel history-dock cutout-history-dock">
    <div class="history-bar">
      <h2>改图历史</h2>
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
          <div class="cutout-history-image">
            <img v-if="getEditResultSrc(item)" :src="getEditResultSrc(item)!" alt="改图历史结果">
            <span v-else>{{ item.status === "failed" ? "失败" : "处理中" }}</span>
          </div>
          <div>
            <strong>
              {{
                item.status === "succeeded"
                  ? "局部改图"
                  : item.status === "failed"
                    ? "改图失败"
                    : item.status === "canceled"
                      ? "已中断"
                      : "处理中"
              }}
            </strong>
            <p>{{ item.error || item.instruction }}</p>
            <small>{{ new Date(item.createdAt).toLocaleString() }}</small>
          </div>
        </button>
        <button type="button" class="tile-del" aria-label="删除改图历史" @click="handleDeleteHistory(index)">
          <Icon name="trash" />
        </button>
      </article>
    </div>
    <div v-else class="empty">暂无改图历史。</div>
  </section>
</template>
