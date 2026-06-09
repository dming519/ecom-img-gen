<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue"
import {
  cancelLayerTask,
  createLayerTask,
  pollLayerTask,
} from "@/lib/api"
import {
  dbAddLayer,
  dbAllLayers,
  dbClearLayers,
  dbDelLayer,
  dbGetProductImages,
  dbImageFileUrl,
  dbPutLayer,
  dbPutProductImage,
  dbPutProductImageBlob,
} from "@/lib/db"
import type { AuthSession, LayerHistoryItem, LayerResultItem, LayerTaskStatus } from "@/lib/types"
import Icon from "./Icon.vue"

const props = defineProps<{
  authenticated: boolean
  sessionLoading: boolean
  session: AuthSession | null
}>()

const emit = defineEmits<{
  "update:session": [session: AuthSession | null]
  zoom: [src: string]
}>()

const MAX_LAYER_IMAGE_BYTES = 10 * 1024 * 1024
const LAYER_BACKGROUND_COLOR = "#ffffff"
const fileInputId = "layer-source-file"

interface ImageDimensions {
  width: number
  height: number
}

interface LayerDisplayRow {
  id: string
  name: string
  role: LayerResultItem["role"]
  index: number
  layer?: LayerResultItem
  state: "done" | "running" | "pending"
}

const EXPECTED_LAYER_ROWS: Array<Omit<LayerDisplayRow, "state" | "layer">> = [
  { id: "background", name: "背景层", role: "background", index: 0 },
  { id: "main-subject", name: "商品主体", role: "subject", index: 1 },
  { id: "text", name: "文字层", role: "text", index: 2 },
  { id: "decoration", name: "装饰道具层", role: "decoration", index: 3 },
  { id: "shadow-light", name: "阴影光效层", role: "shadow", index: 4 },
  { id: "preview", name: "原图预览", role: "preview", index: 5 },
]

const fileInputRef = ref<HTMLInputElement | null>(null)
const sourceImage = shallowRef<string | null>(null)
const sourceImageId = shallowRef<string | undefined>()
const sourceDimensions = shallowRef<ImageDimensions | null>(null)
const layersNormalizedToSourceSize = shallowRef(false)
const layers = ref<LayerResultItem[]>([])
const selectedLayerId = shallowRef<string | null>(null)
const busy = shallowRef(false)
const zipBusy = shallowRef(false)
const error = shallowRef<string | null>(null)
const taskIdRef = shallowRef<string | null>(null)
const abortRef = shallowRef<AbortController | null>(null)
const history = ref<LayerHistoryItem[]>([])
const activeHistoryIdx = shallowRef(-1)
const historyLoadedUserKey = shallowRef<string | null>(null)
const progress = ref<{ done: number; total: number; current: string }>({
  done: 0,
  total: 6,
  current: "",
})

const LAYER_ROLE_LABEL: Record<LayerResultItem["role"], string> = {
  background: "背景",
  subject: "商品",
  text: "文字",
  decoration: "装饰",
  shadow: "光影",
  preview: "预览",
  other: "其他",
}

const isSuperAdmin = computed(() => props.session?.user?.role === "super_admin")
const sessionUserKey = computed(() => props.session?.user?.userKey ?? props.session?.user?.id ?? null)
const controlsDisabled = computed(() => props.sessionLoading || busy.value || !props.authenticated)
const creditLabel = computed(() =>
  `今日剩余 ${props.session?.user?.dailyRemainingCredits ?? props.session?.user?.remainingCredits ?? 0} 次 · 永久 ${props.session?.user?.permanentRemainingCredits ?? 0} 次`,
)
const progressPercent = computed(() => {
  if (!progress.value.total) return 0
  return Math.min(100, Math.max(0, Math.round((progress.value.done / progress.value.total) * 100)))
})
const progressText = computed(() => {
  if (!busy.value) return "待命"
  return progress.value.current
    ? `${progress.value.current} · ${progress.value.done}/${progress.value.total}`
    : `正在准备分层 · ${progress.value.done}/${progress.value.total}`
})
const busyStageLabel = computed(() =>
  progress.value.current.includes("校准") ? "正在校准图层" : "正在生成图层",
)
const sourceDimensionText = computed(() =>
  sourceDimensions.value
    ? `${sourceDimensions.value.width} x ${sourceDimensions.value.height}`
    : "原图尺寸",
)
const layerPreviewFrameStyle = computed(() =>
  sourceDimensions.value
    ? { aspectRatio: `${sourceDimensions.value.width} / ${sourceDimensions.value.height}` }
    : undefined,
)
const selectedLayer = computed(() =>
  layers.value.find((layer) => layer.id === selectedLayerId.value) ?? layers.value[0] ?? null,
)
const previewLayer = computed(() =>
  selectedLayer.value ?? layers.value.find((layer) => layer.role === "preview") ?? null,
)
const previewSrc = computed(() => (previewLayer.value ? getLayerSrc(previewLayer.value) : null))
const canDownloadZip = computed(() => !busy.value && layers.value.length > 0)
const layerRows = computed<LayerDisplayRow[]>(() => {
  const sortedLayers = [...layers.value].sort((a, b) => a.index - b.index)
  if (!busy.value) {
    return sortedLayers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      role: layer.role,
      index: layer.index,
      layer,
      state: "done",
    }))
  }

  return EXPECTED_LAYER_ROWS.map((row) => {
    const layer = sortedLayers.find((item) => item.id === row.id)
    if (layer) return { ...row, layer, state: "done" }
    return {
      ...row,
      state: progress.value.current.includes(row.name) ? "running" : "pending",
    }
  })
})

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("图片尺寸读取失败"))
    image.decoding = "async"
    image.src = src
  })
}

async function getImageDimensions(src: string): Promise<ImageDimensions> {
  const image = await loadImage(src)
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }
}

function getLayerSrc(layer: LayerResultItem) {
  if (layer.base64) return `data:image/png;base64,${layer.base64}`
  if (layer.imageId) return dbImageFileUrl(layer.imageId)
  return null
}

function getLayerRoleLabel(role: LayerResultItem["role"]) {
  return LAYER_ROLE_LABEL[role] ?? "图层"
}

function syncLayerHistoryList(item: LayerHistoryItem) {
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

function updateLayerHistorySnapshot(
  item: LayerHistoryItem,
  options: {
    status?: LayerHistoryItem["status"];
    error?: string | null;
    model?: string;
    taskId?: string | null;
  } = {},
) {
  item.sourceImageId = sourceImageId.value
  item.sourceImage = sourceImage.value ?? undefined
  item.sourceDimensions = sourceDimensions.value ?? undefined
  item.normalizedToSourceSize = layersNormalizedToSourceSize.value
  item.layerBackground = LAYER_BACKGROUND_COLOR
  item.layers = layers.value.map((layer) => ({ ...layer }))
  item.status = options.status ?? item.status
  item.error = options.error === undefined ? item.error : options.error || undefined
  item.model = options.model ?? item.model
  item.taskId = options.taskId === undefined ? item.taskId : options.taskId || undefined
  item.progress = { ...progress.value }
  item.updatedAt = Date.now()
}

async function persistLayer(item: LayerHistoryItem) {
  try {
    if (item.id == null) {
      const id = await dbAddLayer(item)
      item.id = id as number
    } else {
      await dbPutLayer(item)
    }
    syncLayerHistoryList(item)
  } catch (event) {
    console.warn("分层历史写入失败:", event)
  }
}

function syncLayersFromTask(result: Pick<LayerTaskStatus, "layers">, options: { preferPreview?: boolean } = {}) {
  if (!result.layers) return
  const sortedLayers = [...result.layers].sort((a, b) => a.index - b.index)
  layersNormalizedToSourceSize.value = false
  layers.value = sortedLayers
  const currentLayerExists = sortedLayers.some((layer) => layer.id === selectedLayerId.value)
  if (options.preferPreview) {
    selectedLayerId.value =
      sortedLayers.find((layer) => layer.role === "preview")?.id ??
      (currentLayerExists ? selectedLayerId.value : sortedLayers[0]?.id ?? null)
    return
  }
  if (!currentLayerExists) {
    selectedLayerId.value = sortedLayers[0]?.id ?? null
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
  if (file.size > MAX_LAYER_IMAGE_BYTES) {
    error.value = "图片过大，请上传 10MB 以内的图片。"
    return
  }
  try {
    const dataUrl = await fileToDataUrl(file)
    sourceImage.value = dataUrl
    sourceDimensions.value = await getImageDimensions(dataUrl)
    sourceImageId.value = await dbPutProductImage(dataUrl)
    layers.value = []
    layersNormalizedToSourceSize.value = false
    selectedLayerId.value = null
    progress.value = { done: 0, total: 6, current: "" }
    activeHistoryIdx.value = -1
  } catch (uploadError) {
    error.value = uploadError instanceof Error ? uploadError.message : String(uploadError)
    sourceDimensions.value = null
  } finally {
    if (fileInputRef.value) fileInputRef.value.value = ""
  }
}

function updateSessionCredits(result: LayerTaskStatus) {
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
    error.value = "请先登录后再使用分层。"
    return
  }
  if (!sourceImageId.value) {
    error.value = "请先上传需要分层的图片。"
    return
  }
  if (!sourceDimensions.value && sourceImage.value) {
    sourceDimensions.value = await getImageDimensions(sourceImage.value).catch(() => null)
  }

  busy.value = true
  abortRef.value = new AbortController()
  layers.value = []
  layersNormalizedToSourceSize.value = false
  selectedLayerId.value = null
  progress.value = { done: 0, total: 6, current: "" }
  let historyItem: LayerHistoryItem = {
    sourceImageId: sourceImageId.value,
    sourceImage: sourceImage.value ?? undefined,
    layers: [],
    status: "running",
    progress: { ...progress.value },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  let persistQueue = Promise.resolve()
  const queuePersistLayer = () => {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => persistLayer(historyItem))
  }

  try {
    await persistLayer(historyItem)
    const created = await createLayerTask({ sourceImageId: sourceImageId.value }, abortRef.value.signal)
    taskIdRef.value = created.taskId
    updateSessionCredits({ status: "pending", ...created })
    updateLayerHistorySnapshot(historyItem, { status: "running", taskId: created.taskId, error: null })
    await persistLayer(historyItem)
    const result = await pollLayerTask(created.taskId, undefined, abortRef.value.signal, (next) => {
      syncLayersFromTask(next)
      if (!next.progress) return
      progress.value = {
        done: Number(next.progress.done ?? 0),
        total: Number(next.progress.total ?? 6),
        current: next.progress.current ?? "",
      }
      updateLayerHistorySnapshot(historyItem, { status: "running", error: null })
      queuePersistLayer()
    })
    syncLayersFromTask(result, { preferPreview: result.status === "succeeded" })
    await persistQueue
    if (result.status === "canceled") {
      updateLayerHistorySnapshot(historyItem, { status: "canceled", error: "分层已中断", taskId: null })
      await persistLayer(historyItem)
      error.value = "分层已中断"
      return
    }
    if (result.status === "failed") {
      updateLayerHistorySnapshot(historyItem, { status: "failed", error: result.error || "分层失败", taskId: null })
      await persistLayer(historyItem)
      error.value = result.error || "分层失败"
      return
    }
    progress.value = {
      done: Number(progress.value.total || 6),
      total: Number(progress.value.total || 6),
      current: "正在校准白底图层",
    }
    updateLayerHistorySnapshot(historyItem, { status: "running", error: null })
    await persistLayer(historyItem)
    await normalizeLayersToWhiteSourceCanvas()
    updateSessionCredits(result)
    updateLayerHistorySnapshot(historyItem, {
      status: "succeeded",
      error: null,
      model: result.model,
      taskId: null,
    })
    await persistLayer(historyItem)
    if (!layers.value.length) error.value = "分层任务未返回图层"
  } catch (generateError) {
    await persistQueue
    if (generateError instanceof DOMException && generateError.name === "AbortError") {
      updateLayerHistorySnapshot(historyItem, { status: "canceled", error: "分层已中断", taskId: null })
      await persistLayer(historyItem)
      error.value = "分层已中断"
    } else {
      const message = generateError instanceof Error ? generateError.message : String(generateError)
      updateLayerHistorySnapshot(historyItem, { status: "failed", error: message, taskId: null })
      await persistLayer(historyItem)
      error.value = message
    }
  } finally {
    taskIdRef.value = null
    abortRef.value = null
    busy.value = false
  }
}

function handleCancel() {
  const taskId = taskIdRef.value
  if (taskId) cancelLayerTask(taskId).catch((event) => console.warn("取消分层任务失败:", event))
  abortRef.value?.abort()
  busy.value = false
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff)
}

function writeUint32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

function encodeText(value: string) {
  return new TextEncoder().encode(value)
}

async function blobToBytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("图层白底规范化失败"))
    }, "image/png")
  })
}

function createZip(entries: Array<{ name: string; data: Uint8Array }>) {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encodeText(entry.name)
    const crc = crc32(entry.data)
    const local: number[] = []
    writeUint32(local, 0x04034b50)
    writeUint16(local, 20)
    writeUint16(local, 0)
    writeUint16(local, 0)
    writeUint16(local, 0)
    writeUint16(local, 0)
    writeUint32(local, crc)
    writeUint32(local, entry.data.length)
    writeUint32(local, entry.data.length)
    writeUint16(local, name.length)
    writeUint16(local, 0)
    const localBytes = new Uint8Array([...local, ...name])
    chunks.push(localBytes, entry.data)

    const header: number[] = []
    writeUint32(header, 0x02014b50)
    writeUint16(header, 20)
    writeUint16(header, 20)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint32(header, crc)
    writeUint32(header, entry.data.length)
    writeUint32(header, entry.data.length)
    writeUint16(header, name.length)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint32(header, 0)
    writeUint32(header, offset)
    central.push(new Uint8Array([...header, ...name]))
    offset += localBytes.length + entry.data.length
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end: number[] = []
  writeUint32(end, 0x06054b50)
  writeUint16(end, 0)
  writeUint16(end, 0)
  writeUint16(end, entries.length)
  writeUint16(end, entries.length)
  writeUint32(end, centralSize)
  writeUint32(end, offset)
  writeUint16(end, 0)
  const parts = [...chunks, ...central, new Uint8Array(end)].map((item) => item.buffer as ArrayBuffer)
  return new Blob(parts, { type: "application/zip" })
}

async function fetchLayerBlob(layer: LayerResultItem) {
  const src = getLayerSrc(layer)
  if (!src) throw new Error(`${layer.name} 缺少图片`)
  const response = await fetch(src, { cache: "no-store" })
  if (!response.ok) throw new Error(`${layer.name} 读取失败`)
  return response.blob()
}

async function drawBlobOnWhiteSourceCanvas(blob: Blob, dimensions: ImageDimensions) {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await loadImage(objectUrl)
    const canvas = document.createElement("canvas")
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("浏览器不支持图层白底规范化")
    context.fillStyle = LAYER_BACKGROUND_COLOR
    context.fillRect(0, 0, dimensions.width, dimensions.height)
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height)
    return canvasToBlob(canvas)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function normalizeLayersToWhiteSourceCanvas() {
  const dimensions = sourceDimensions.value
  if (!dimensions?.width || !dimensions.height || layersNormalizedToSourceSize.value) return

  const currentLayerId = selectedLayerId.value
  const normalizedLayers = await Promise.all(
    layers.value.map(async (layer) => {
      if (layer.role === "preview") return layer
      const blob = await fetchLayerBlob(layer)
      const normalizedBlob = await drawBlobOnWhiteSourceCanvas(blob, dimensions)
      const imageId = await dbPutProductImageBlob(normalizedBlob, `${layer.id}.png`)
      const { base64: _base64, ...rest } = layer
      return { ...rest, imageId }
    }),
  )
  layers.value = normalizedLayers
  layersNormalizedToSourceSize.value = true
  selectedLayerId.value = normalizedLayers.some((layer) => layer.id === currentLayerId)
    ? currentLayerId
    : normalizedLayers.find((layer) => layer.role === "preview")?.id ?? normalizedLayers[0]?.id ?? null
}

async function fetchLayerBytes(layer: LayerResultItem) {
  const blob = await fetchLayerBlob(layer)
  const dimensions = sourceDimensions.value
  if (!dimensions?.width || !dimensions.height) return blobToBytes(blob)

  return blobToBytes(await drawBlobOnWhiteSourceCanvas(blob, dimensions))
}

async function handleDownloadZip() {
  if (!canDownloadZip.value) return
  zipBusy.value = true
  error.value = null
  try {
    const imageEntries = await Promise.all(
      layers.value.map(async (layer, index) => ({
        name: `${String(index + 1).padStart(2, "0")}-${layer.id}.png`,
        data: await fetchLayerBytes(layer),
      })),
    )
    const manifest = {
      createdAt: new Date().toISOString(),
      sourceImageId: sourceImageId.value,
      sourceDimensions: sourceDimensions.value,
      normalizedToSourceSize: !!sourceDimensions.value,
      layerBackground: LAYER_BACKGROUND_COLOR,
      layers: layers.value.map(({ base64: _base64, ...layer }) => layer),
    }
    const zip = createZip([
      ...imageEntries,
      {
        name: "layers.json",
        data: encodeText(JSON.stringify(manifest, null, 2)),
      },
    ])
    const url = URL.createObjectURL(zip)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `ecom-layers-${Date.now()}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (downloadError) {
    error.value = downloadError instanceof Error ? downloadError.message : String(downloadError)
  } finally {
    zipBusy.value = false
  }
}

function getLayerHistoryCover(item: LayerHistoryItem) {
  const layer = item.layers.find((entry) => entry.role === "preview" && (entry.imageId || entry.base64)) ??
    item.layers.find((entry) => entry.imageId || entry.base64)
  if (!layer) return null
  if (layer.base64) return `data:image/png;base64,${layer.base64}`
  if (layer.imageId) return dbImageFileUrl(layer.imageId)
  return null
}

async function handleSelectHistory(index: number) {
  const item = history.value[index]
  if (!item) return
  activeHistoryIdx.value = index
  sourceImageId.value = item.sourceImageId
  sourceImage.value = null
  if (item.sourceImageId) {
    const [restored] = await dbGetProductImages([item.sourceImageId])
    sourceImage.value = restored ?? null
  } else {
    sourceImage.value = item.sourceImage ?? null
  }
  sourceDimensions.value = item.sourceDimensions ??
    (sourceImage.value ? await getImageDimensions(sourceImage.value).catch(() => null) : null)
  layers.value = [...item.layers].sort((a, b) => a.index - b.index)
  layersNormalizedToSourceSize.value = !!item.normalizedToSourceSize
  selectedLayerId.value =
    layers.value.find((layer) => layer.role === "preview")?.id ?? layers.value[0]?.id ?? null
  progress.value = {
    done: Number(item.progress?.done ?? layers.value.length),
    total: Number(item.progress?.total ?? 6),
    current: item.progress?.current ?? "",
  }
  error.value = item.error ?? null
}

function handleDeleteHistory(index: number) {
  const item = history.value[index]
  if (!item) return
  if (item.id != null) dbDelLayer(item.id).catch((event) => console.warn(event))
  history.value = history.value.filter((_, itemIndex) => itemIndex !== index)
  if (activeHistoryIdx.value === index) {
    activeHistoryIdx.value = history.value.length ? Math.min(index, history.value.length - 1) : -1
  } else if (activeHistoryIdx.value > index) {
    activeHistoryIdx.value -= 1
  }
}

async function handleClearHistory() {
  if (!confirm("确定清空所有分层历史？此操作不可撤销。")) return
  await dbClearLayers()
  history.value = []
  activeHistoryIdx.value = -1
}

async function loadLayerHistoryIfAuthenticated() {
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
    const items = await dbAllLayers()
    history.value = items
    activeHistoryIdx.value = items.length ? items.length - 1 : -1
  } catch (event) {
    console.warn("分层历史读取失败:", event)
  }
}

watch(
  () => [props.sessionLoading, props.authenticated, sessionUserKey.value] as const,
  () => {
    void loadLayerHistoryIfAuthenticated()
  },
  { immediate: true },
)
</script>

<template>
  <div class="run-status cutout-status" aria-label="分层任务状态">
    <span>{{ sourceImage ? "原图已上传" : "等待上传" }}</span>
    <span>{{ layers.length ? `${layers.length} 个图层` : "未分层" }}</span>
    <span>{{ isSuperAdmin ? "不限次数" : creditLabel }}</span>
    <span>{{ busy ? "分层中" : "待命" }}</span>
  </div>

  <div class="cutout-grid layer-grid">
    <aside class="studio-panel cutout-panel cutout-source-panel layer-source-panel">
      <div class="panel-heading">
        <h2>商品图片</h2>
        <span class="panel-count">分层源图</span>
      </div>
      <div class="cutout-panel-body layer-source-body">
        <label
          :class="['cutout-upload-zone', { 'has-image': sourceImage, 'is-disabled': controlsDisabled }]"
        >
          <img v-if="sourceImage" :src="sourceImage" alt="待分层原图">
          <span v-else>
            <Icon name="upload" />
            <strong>上传商品图片</strong>
            <small>支持商品图、详情图、主图或海报图</small>
          </span>
          <input
            :id="fileInputId"
            ref="fileInputRef"
            class="layer-file-input"
            type="file"
            accept="image/*"
            :disabled="controlsDisabled"
            @change="handleFileChange"
          >
        </label>
        <div class="cutout-source-actions">
          <label
            :class="['btn-ghost layer-change-trigger', { 'is-disabled': controlsDisabled }]"
            :for="controlsDisabled ? undefined : fileInputId"
          >
            <Icon name="upload" />
            更换图片
          </label>
          <button type="button" class="btn-ghost" :disabled="!sourceImage" @click="sourceImage && emit('zoom', sourceImage)">
            <Icon name="zoom" />
            查看原图
          </button>
        </div>
        <div class="cutout-help layer-output-note">
          <strong>输出内容</strong>
          <p>自动拆出背景、商品主体、文字、装饰道具和阴影光效；结果统一为白底同尺寸 PNG，可打包为 ZIP。</p>
        </div>
      </div>
      <div v-if="error" class="alert cutout-alert">{{ error }}</div>
      <div class="cutout-action-bar">
        <button v-if="busy" type="button" class="btn-danger" @click="handleCancel">
          中断分层
        </button>
        <button
          v-else
          type="button"
          class="btn-primary"
          :disabled="controlsDisabled || !sourceImageId"
          @click="handleGenerate"
        >
          <Icon name="text" />
          开始分层
        </button>
      </div>
    </aside>

    <section class="studio-panel cutout-panel cutout-result-panel layer-preview-panel">
      <div class="panel-heading">
        <h2>图层预览</h2>
        <span class="panel-count">{{ previewLayer?.name ?? sourceDimensionText }}</span>
      </div>
      <div class="cutout-result-stage layer-preview-stage">
        <template v-if="previewSrc">
          <button
            type="button"
            class="layer-preview-image"
            :style="layerPreviewFrameStyle"
            @click="emit('zoom', previewSrc)"
          >
            <img :src="previewSrc" :alt="previewLayer?.name ?? '分层预览'">
          </button>
          <div class="stage-actions">
            <button type="button" class="btn-ghost" :disabled="!canDownloadZip || zipBusy" @click="handleDownloadZip">
              <Icon name="download" />
              {{ zipBusy ? "打包中" : busy ? "完成后下载" : "下载 ZIP" }}
            </button>
            <button type="button" class="btn-ghost" @click="emit('zoom', previewSrc)">
              <Icon name="zoom" />
              放大
            </button>
          </div>
        </template>
        <div v-else-if="busy" class="busy-card">
          <span class="busy-orbit" aria-hidden="true" />
          <strong>{{ busyStageLabel }}</strong>
          <p>
            {{
              progress.current
                ? `${progress.current} ${progress.done}/${progress.total}`
                : "系统正在识别画面结构。"
            }}
          </p>
          <div class="layer-progress" aria-hidden="true">
            <span :style="{ width: `${progressPercent}%` }" />
          </div>
        </div>
        <div v-else class="stage-placeholder cutout-result-empty">
          <Icon name="text" class="icon-large" />
          <div class="icon-hint">上传图片后预览分层结果</div>
        </div>
        <div v-if="busy && previewSrc" class="layer-progress-overlay" role="status" aria-live="polite">
          <div class="layer-progress-copy">
            <span class="layer-progress-dot" aria-hidden="true" />
            <div>
              <strong>{{ busyStageLabel }}</strong>
              <small>{{ progressText }}</small>
            </div>
            <em>{{ progressPercent }}%</em>
          </div>
          <div class="layer-progress" aria-hidden="true">
            <span :style="{ width: `${progressPercent}%` }" />
          </div>
        </div>
      </div>
    </section>

    <aside class="studio-panel cutout-panel cutout-result-panel layer-list-panel">
      <div class="panel-heading">
        <h2>图层列表</h2>
        <span class="panel-count">{{ busy ? `${progress.done}/${progress.total}` : `${layers.length} 个` }}</span>
      </div>
      <div class="cutout-panel-body layer-list-body">
        <div v-if="layerRows.length" class="layer-list">
          <button
            v-for="row in layerRows"
            :key="row.id"
            type="button"
            :class="[
              'layer-row',
              `is-${row.state}`,
              { 'is-active': row.layer && selectedLayer?.id === row.layer.id },
            ]"
            :disabled="!row.layer"
            @click="row.layer && (selectedLayerId = row.layer.id)"
          >
            <span class="layer-thumb">
              <img v-if="row.layer && getLayerSrc(row.layer)" :src="getLayerSrc(row.layer)!" :alt="row.layer.name">
              <span v-else-if="row.state === 'running'" class="layer-mini-spinner" aria-hidden="true" />
              <span v-else class="layer-thumb-placeholder" aria-hidden="true" />
            </span>
            <span class="layer-row-copy">
              <strong>{{ row.layer?.name ?? row.name }}</strong>
              <small>
                {{
                  row.layer
                    ? `第 ${row.layer.index + 1} 层 · ${getLayerRoleLabel(row.layer.role)}`
                    : row.state === "running"
                      ? "正在生成"
                      : "等待生成"
                }}
              </small>
            </span>
          </button>
        </div>
        <div v-else class="empty layer-list-empty">
          上传图片并开始分层后，这里会显示可下载图层。
        </div>
      </div>
    </aside>
  </div>

  <section class="studio-panel history-dock cutout-history-dock layer-history-dock">
    <div class="history-bar">
      <h2>分层历史</h2>
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
          <div class="cutout-history-image layer-history-image">
            <img v-if="getLayerHistoryCover(item)" :src="getLayerHistoryCover(item)!" alt="分层历史结果">
            <span v-else>{{ item.status === "failed" ? "失败" : "处理中" }}</span>
          </div>
          <div>
            <strong>
              {{
                item.status === "succeeded"
                  ? "商品分层"
                  : item.status === "failed"
                    ? "分层失败"
                    : item.status === "canceled"
                      ? "已中断"
                      : "处理中"
              }}
            </strong>
            <p>{{ item.error || `${item.layers.length} 个图层` }}</p>
            <small>{{ new Date(item.createdAt).toLocaleString() }}</small>
          </div>
        </button>
        <button type="button" class="tile-del" aria-label="删除分层历史" @click="handleDeleteHistory(index)">
          <Icon name="trash" />
        </button>
      </article>
    </div>
    <div v-else class="empty">暂无分层历史。</div>
  </section>
</template>

<style scoped>
.layer-grid {
  grid-template-columns: minmax(292px, 348px) minmax(460px, 1fr) minmax(300px, 400px);
}

.layer-source-body {
  display: block;
}

.layer-history-dock {
  margin-top: 12px;
}

.layer-history-image img {
  object-fit: contain;
}

.layer-source-panel .cutout-upload-zone {
  position: relative;
  min-height: 254px;
  cursor: pointer;
}

.layer-source-panel .cutout-upload-zone img {
  max-height: 300px;
}

.layer-source-panel .cutout-upload-zone.is-disabled {
  cursor: not-allowed;
  opacity: 0.72;
  pointer-events: none;
}

.layer-source-panel .cutout-upload-zone.is-disabled:hover {
  transform: none;
  border-color: var(--border-strong);
  background:
    linear-gradient(135deg, rgba(255,255,255,0.72), rgba(255,255,255,0.08)),
    var(--bg-soft);
  box-shadow: none;
}

.layer-file-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.layer-file-input:disabled {
  cursor: not-allowed;
}

.layer-change-trigger {
  cursor: pointer;
}

.layer-change-trigger.is-disabled {
  cursor: not-allowed;
  opacity: 0.68;
  pointer-events: none;
}

.layer-output-note {
  background:
    linear-gradient(135deg, rgba(15, 118, 110, 0.08), rgba(255, 255, 255, 0.52)),
    var(--bg-soft);
}

.layer-preview-stage {
  position: relative;
  align-content: stretch;
  gap: 12px;
}

.layer-preview-image {
  width: 100%;
  height: auto;
  min-height: 420px;
  max-height: 100%;
  background: #fff;
  border: 1px solid rgba(174, 184, 199, 0.62);
  border-radius: var(--radius-panel);
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 14px;
  cursor: zoom-in;
}

.layer-preview-image img {
  max-width: calc(100% - 12px);
  max-height: calc(100% - 12px);
  object-fit: contain;
}

.layer-progress {
  width: min(260px, 100%);
  height: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(23, 105, 255, 0.12);
}

.layer-progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--teal));
  transition: width 0.2s var(--ease);
}

.layer-progress-overlay {
  position: absolute;
  right: 18px;
  bottom: 74px;
  left: 18px;
  display: grid;
  gap: 9px;
  padding: 12px 13px;
  border: 1px solid rgba(170, 183, 200, 0.72);
  border-radius: var(--radius-panel);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.14);
  backdrop-filter: blur(10px);
  z-index: 2;
}

.layer-progress-copy {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.layer-progress-copy strong,
.layer-progress-copy small {
  display: block;
  min-width: 0;
}

.layer-progress-copy strong {
  color: var(--text);
  font-size: 0.84rem;
  line-height: 1.2;
}

.layer-progress-copy small {
  margin-top: 2px;
  overflow: hidden;
  color: var(--text-sub);
  font-size: 0.74rem;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-progress-copy em {
  color: var(--accent-ink);
  font-style: normal;
  font-size: 0.78rem;
  font-weight: 820;
}

.layer-progress-dot,
.layer-mini-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(23, 105, 255, 0.22);
  border-top-color: var(--accent);
  border-radius: 999px;
  animation: spin 0.72s linear infinite;
}

.layer-list-body {
  display: grid;
  align-content: start;
}

.layer-list {
  display: grid;
  gap: 8px;
}

.layer-row {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 72px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.18)),
    var(--bg-soft);
  color: inherit;
  text-align: left;
  transition:
    transform 0.16s var(--ease),
    border-color 0.16s var(--ease),
    box-shadow 0.16s var(--ease),
    background 0.16s var(--ease);
}

.layer-row:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(23, 105, 255, 0.36);
  background: #fff;
}

.layer-row:disabled {
  cursor: default;
}

.layer-row.is-active {
  border-color: var(--accent);
  background: #fff;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.1);
}

.layer-row.is-running {
  border-color: rgba(23, 105, 255, 0.34);
  background: #f7fbff;
}

.layer-row.is-pending {
  opacity: 0.72;
}

.layer-thumb {
  width: 54px;
  height: 54px;
  border-radius: 6px;
  border: 1px solid rgba(174, 184, 199, 0.52);
  background: #fff;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.layer-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.layer-thumb-placeholder {
  width: 18px;
  height: 18px;
  border: 1px dashed rgba(119, 131, 153, 0.62);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.68);
}

.layer-row-copy,
.layer-row-copy strong,
.layer-row-copy small {
  display: block;
  min-width: 0;
}

.layer-row-copy strong {
  overflow: hidden;
  color: var(--text);
  font-size: 0.88rem;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-row-copy small {
  color: var(--muted);
  margin-top: 5px;
  font-size: 0.74rem;
}

.layer-list-empty {
  min-height: 220px;
}

@media (max-width: 1180px) {
  .layer-grid {
    grid-template-columns: 1fr;
  }

  .layer-preview-image {
    min-height: 340px;
  }

  .layer-preview-image img {
    max-height: 340px;
  }
}
</style>
