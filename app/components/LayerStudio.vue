<script setup lang="ts">
import { computed, ref, shallowRef } from "vue"
import {
  cancelLayerTask,
  createLayerTask,
  pollLayerTask,
} from "@/lib/api"
import {
  dbImageFileUrl,
  dbPutProductImage,
} from "@/lib/db"
import type { AuthSession, LayerResultItem, LayerTaskStatus } from "@/lib/types"
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

const fileInputRef = ref<HTMLInputElement | null>(null)
const sourceImage = shallowRef<string | null>(null)
const sourceImageId = shallowRef<string | undefined>()
const layers = ref<LayerResultItem[]>([])
const selectedLayerId = shallowRef<string | null>(null)
const busy = shallowRef(false)
const zipBusy = shallowRef(false)
const error = shallowRef<string | null>(null)
const taskIdRef = shallowRef<string | null>(null)
const abortRef = shallowRef<AbortController | null>(null)
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
const controlsDisabled = computed(() => props.sessionLoading || busy.value || !props.authenticated)
const creditLabel = computed(() =>
  `今日剩余 ${props.session?.user?.dailyRemainingCredits ?? props.session?.user?.remainingCredits ?? 0} 次 · 永久 ${props.session?.user?.permanentRemainingCredits ?? 0} 次`,
)
const progressPercent = computed(() => {
  if (!progress.value.total) return 0
  return Math.min(100, Math.max(0, Math.round((progress.value.done / progress.value.total) * 100)))
})
const selectedLayer = computed(() =>
  layers.value.find((layer) => layer.id === selectedLayerId.value) ?? layers.value[0] ?? null,
)
const previewLayer = computed(() =>
  selectedLayer.value ?? layers.value.find((layer) => layer.role === "preview") ?? null,
)
const previewSrc = computed(() => (previewLayer.value ? getLayerSrc(previewLayer.value) : null))

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function getLayerSrc(layer: LayerResultItem) {
  if (layer.base64) return `data:image/png;base64,${layer.base64}`
  if (layer.imageId) return dbImageFileUrl(layer.imageId)
  return null
}

function getLayerRoleLabel(role: LayerResultItem["role"]) {
  return LAYER_ROLE_LABEL[role] ?? "图层"
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
    sourceImageId.value = await dbPutProductImage(dataUrl)
    layers.value = []
    selectedLayerId.value = null
    progress.value = { done: 0, total: 6, current: "" }
  } catch (uploadError) {
    error.value = uploadError instanceof Error ? uploadError.message : String(uploadError)
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

  busy.value = true
  abortRef.value = new AbortController()
  layers.value = []
  selectedLayerId.value = null
  progress.value = { done: 0, total: 6, current: "" }

  try {
    const created = await createLayerTask({ sourceImageId: sourceImageId.value }, abortRef.value.signal)
    taskIdRef.value = created.taskId
    updateSessionCredits({ status: "pending", ...created })
    const result = await pollLayerTask(created.taskId, undefined, abortRef.value.signal, (next) => {
      if (!next.progress) return
      progress.value = {
        done: Number(next.progress.done ?? 0),
        total: Number(next.progress.total ?? 6),
        current: next.progress.current ?? "",
      }
    })
    if (result.status === "canceled") {
      error.value = "分层已中断"
      return
    }
    if (result.status === "failed") {
      error.value = result.error || "分层失败"
      return
    }
    updateSessionCredits(result)
    layers.value = (result.layers ?? []).sort((a, b) => a.index - b.index)
    selectedLayerId.value =
      layers.value.find((layer) => layer.role === "preview")?.id ?? layers.value[0]?.id ?? null
    if (!layers.value.length) error.value = "分层任务未返回图层"
  } catch (generateError) {
    if (generateError instanceof DOMException && generateError.name === "AbortError") {
      error.value = "分层已中断"
    } else {
      error.value = generateError instanceof Error ? generateError.message : String(generateError)
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

async function fetchLayerBytes(layer: LayerResultItem) {
  const src = getLayerSrc(layer)
  if (!src) throw new Error(`${layer.name} 缺少图片`)
  const response = await fetch(src, { cache: "no-store" })
  if (!response.ok) throw new Error(`${layer.name} 读取失败`)
  return blobToBytes(await response.blob())
}

async function handleDownloadZip() {
  if (!layers.value.length) return
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
        <button
          type="button"
          :class="['cutout-upload-zone', { 'has-image': sourceImage }]"
          :disabled="controlsDisabled"
          @click="fileInputRef?.click()"
        >
          <img v-if="sourceImage" :src="sourceImage" alt="待分层原图">
          <span v-else>
            <Icon name="upload" />
            <strong>上传商品图片</strong>
            <small>支持商品图、详情图、主图或海报图</small>
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
        <div class="cutout-help layer-output-note">
          <strong>输出内容</strong>
          <p>自动拆出背景、商品主体、文字、装饰道具、阴影光效和合成预览，并打包为 ZIP。</p>
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
        <span class="panel-count">{{ previewLayer?.name ?? "预览" }}</span>
      </div>
      <div class="cutout-result-stage layer-preview-stage">
        <template v-if="previewSrc">
          <button type="button" class="layer-preview-image" @click="emit('zoom', previewSrc)">
            <img :src="previewSrc" :alt="previewLayer?.name ?? '分层预览'">
          </button>
          <div class="stage-actions">
            <button type="button" class="btn-ghost" :disabled="zipBusy" @click="handleDownloadZip">
              <Icon name="download" />
              {{ zipBusy ? "打包中" : "下载 ZIP" }}
            </button>
            <button type="button" class="btn-ghost" @click="emit('zoom', previewSrc)">
              <Icon name="zoom" />
              放大
            </button>
          </div>
        </template>
        <div v-else-if="busy" class="busy-card">
          <span class="busy-orbit" aria-hidden="true" />
          <strong>正在生成图层</strong>
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
      </div>
    </section>

    <aside class="studio-panel cutout-panel cutout-result-panel layer-list-panel">
      <div class="panel-heading">
        <h2>图层列表</h2>
        <span class="panel-count">{{ layers.length }} 个</span>
      </div>
      <div class="cutout-panel-body layer-list-body">
        <div v-if="layers.length" class="layer-list">
          <button
            v-for="layer in layers"
            :key="layer.id"
            type="button"
            :class="['layer-row', { 'is-active': selectedLayer?.id === layer.id }]"
            @click="selectedLayerId = layer.id"
          >
            <span class="layer-thumb">
              <img v-if="getLayerSrc(layer)" :src="getLayerSrc(layer)!" :alt="layer.name">
            </span>
            <span class="layer-row-copy">
              <strong>{{ layer.name }}</strong>
              <small>第 {{ layer.index + 1 }} 层 · {{ getLayerRoleLabel(layer.role) }}</small>
            </span>
          </button>
        </div>
        <div v-else class="empty layer-list-empty">
          上传图片并开始分层后，这里会显示可下载图层。
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.layer-grid {
  grid-template-columns: minmax(292px, 348px) minmax(460px, 1fr) minmax(300px, 400px);
}

.layer-source-body {
  display: block;
}

.layer-source-panel .cutout-upload-zone {
  min-height: 254px;
}

.layer-source-panel .cutout-upload-zone img {
  max-height: 300px;
}

.layer-output-note {
  background:
    linear-gradient(135deg, rgba(15, 118, 110, 0.08), rgba(255, 255, 255, 0.52)),
    var(--bg-soft);
}

.layer-preview-stage {
  align-content: stretch;
  gap: 12px;
}

.layer-preview-image {
  width: 100%;
  height: 100%;
  min-height: 420px;
  background:
    linear-gradient(45deg, rgba(15, 23, 42, 0.06) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(15, 23, 42, 0.06) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(15, 23, 42, 0.06) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(15, 23, 42, 0.06) 75%);
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  background-size: 20px 20px;
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

.layer-row:hover {
  transform: translateY(-1px);
  border-color: rgba(23, 105, 255, 0.36);
  background: #fff;
}

.layer-row.is-active {
  border-color: var(--accent);
  background: #fff;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.1);
}

.layer-thumb {
  width: 54px;
  height: 54px;
  border-radius: 6px;
  border: 1px solid rgba(174, 184, 199, 0.52);
  background:
    linear-gradient(45deg, rgba(148, 163, 184, 0.12) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(148, 163, 184, 0.12) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.12) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.12) 75%),
    #fff;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.layer-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
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
