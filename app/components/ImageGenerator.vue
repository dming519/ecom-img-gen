<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  cancelImageTask,
  createImageTask,
  generateDetailPrompts,
  pollImageTask,
} from "@/lib/api"
import {
  dbAdd,
  dbAll,
  dbClear,
  dbDel,
  dbGetProductImages,
  dbImageFileUrl,
  dbPut,
  dbPutProductImage,
} from "@/lib/db"
import { resolveImageSize } from "@/lib/imageOptions"
import type {
  AspectRatio,
  AuthSession,
  DetailPromptItem,
  HistoryItem,
  ImageQuality,
  ProductInput,
} from "@/lib/types"
import AdminPanel from "./AdminPanel.vue"
import AspectRatioSelector from "./AspectRatioSelector.vue"
import CutoutStudio from "./CutoutStudio.vue"
import EditStudio from "./EditStudio.vue"
import HistoryGrid from "./HistoryGrid.vue"
import Icon from "./Icon.vue"
import ImageCountSelector from "./ImageCountSelector.vue"
import LayerStudio from "./LayerStudio.vue"
import Lightbox from "./Lightbox.vue"
import MultiViewStudio from "./MultiViewStudio.vue"
import QualitySelector from "./QualitySelector.vue"
import Stage from "./Stage.vue"

type StudioMode = "image" | "cutout" | "multi-view" | "edit" | "layer"
type WakeLockSentinelLike = { release: () => Promise<void> }

const props = withDefaults(defineProps<{
  initialMode?: StudioMode
}>(), {
  initialMode: "image",
})

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PRODUCT_IMAGE_EDGE = 1280
const PRODUCT_IMAGE_QUALITY = 0.82
const MAX_PROMPT_IMAGE_CHARS = 1_500_000
const MAX_PROMPT_IMAGE_TOTAL_CHARS = 6_000_000
const MAX_DETAIL_IMAGES = 8
const DRAFT_KEY = "ecomimggen_draft_v3"
const ASPECT_RATIO_VALUES: AspectRatio[] = ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"]
const IMAGE_QUALITY_VALUES: ImageQuality[] = ["1K", "2K", "4K"]
const STATUS_LABEL: Record<DetailPromptItem["status"], string> = {
  draft: "待生成",
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
}

interface DraftState {
  productName: string
  sellingPoints: string
  imageCount: number
  prompts: DetailPromptItem[]
  aspectRatio?: AspectRatio
  quality?: ImageQuality
  productImageIds?: string[]
}

// 自定义错误类型：用来区分“用户主动取消”和“真正生成失败”。
class ImageGenerationCancelledError extends Error {
  constructor() {
    super("已中断生成详情图")
    this.name = "ImageGenerationCancelledError"
  }
}

// 页面核心状态。`shallowRef` 适合字符串、数字、布尔值这类只做整体替换的数据。
const studioMode = shallowRef<StudioMode>(props.initialMode)
const productName = shallowRef("")
const sellingPoints = shallowRef("")
const imageCount = shallowRef(5)
const productImages = ref<string[]>([])
const productImageIds = ref<string[]>([])
const aspectRatio = shallowRef<AspectRatio>("3:4")
const quality = shallowRef<ImageQuality>("1K")
const prompts = ref<DetailPromptItem[]>([])
const history = ref<HistoryItem[]>([])
const activeHistoryIdx = shallowRef(-1)
const activePromptIdx = shallowRef(0)
const session = shallowRef<AuthSession | null>(null)
const sessionLoading = shallowRef(true)
const authPopoverOpen = shallowRef(false)
const accessCode = shallowRef("")
const accessBusy = shallowRef(false)
const promptBusy = shallowRef(false)
const imageBusy = shallowRef(false)
const draftLoaded = shallowRef(false)
const adminOpen = shallowRef(false)
const error = shallowRef<string | null>(null)
const lightboxSrc = shallowRef<string | null>(null)
const avatarFailed = shallowRef(false)

// DOM/浏览器能力引用：这些值不是普通业务数据，只在特定操作时使用。
const fileInputRef = ref<HTMLInputElement | null>(null)
const authPopoverRef = ref<HTMLDivElement | null>(null)
const wakeLockRef = shallowRef<WakeLockSentinelLike | null>(null)
const imageAbortRef = shallowRef<AbortController | null>(null)
const imageCancelRequestedRef = shallowRef(false)
const currentImageTaskIdRef = shallowRef<string | null>(null)

// computed 是派生状态：不直接存数据，而是根据上面的源状态实时计算。
const currentProduct = computed<ProductInput>(() => ({
  name: productName.value.trim(),
  sellingPoints: sellingPoints.value.trim(),
  imageCount: imageCount.value,
  productImages: productImages.value,
  productImageIds: productImageIds.value,
}))
const resolvedSize = computed(() => resolveImageSize(aspectRatio.value))
const generationLabel = computed(() =>
  `${aspectRatio.value === "auto" ? "Auto" : aspectRatio.value} · ${quality.value}`,
)
const authenticated = computed(() => !!session.value?.authenticated)
const authLabel = computed(() =>
  authenticated.value ? `${session.value?.user?.name || "已登录用户"} 账户菜单` : "打开登录菜单",
)
const controlsDisabled = computed(
  () =>
    sessionLoading.value ||
    accessBusy.value ||
    promptBusy.value ||
    imageBusy.value ||
    !authenticated.value,
)
const providerLabel = computed(() =>
  session.value?.user?.provider === "github"
    ? "GitHub"
    : session.value?.user?.provider === "google"
      ? "Google"
      : "访问码",
)
const authRedirectPath = computed(() =>
  studioMode.value === "cutout"
    ? "/cutout/"
    : studioMode.value === "multi-view"
      ? "/multi-view/"
      : studioMode.value === "edit"
        ? "/edit/"
        : studioMode.value === "layer"
          ? "/layer/"
        : "/image/",
)
const isAdmin = computed(
  () => session.value?.user?.role === "admin" || session.value?.user?.role === "super_admin",
)
const isSuperAdmin = computed(() => session.value?.user?.role === "super_admin")
const dailyRemainingCredits = computed(
  () => session.value?.user?.dailyRemainingCredits ?? session.value?.user?.remainingCredits ?? 0,
)
const permanentRemainingCredits = computed(() => session.value?.user?.permanentRemainingCredits ?? 0)
const dailyUsedCredits = computed(() => session.value?.user?.dailyUsedCredits ?? 0)
const dailyRemainingLabel = computed(() => (isSuperAdmin.value ? "不限" : `${dailyRemainingCredits.value} 次`))
const permanentRemainingLabel = computed(() => (isSuperAdmin.value ? "不限" : `${permanentRemainingCredits.value} 次`))
const dailyUsedLabel = computed(() => `${dailyUsedCredits.value} 次`)
const creditLabel = computed(() =>
  authenticated.value
    ? isSuperAdmin.value
      ? "不限次数"
      : `今日剩余 ${dailyRemainingCredits.value} 次 · 永久 ${permanentRemainingCredits.value} 次`
    : "未登录",
)
const showUserImage = computed(
  () => !!(authenticated.value && session.value?.user?.image && !avatarFailed.value),
)
const activePromptIndex = computed(() =>
  prompts.value.length
    ? Math.min(Math.max(activePromptIdx.value, 0), prompts.value.length - 1)
    : 0,
)
const activePrompt = computed(() => prompts.value[activePromptIndex.value] ?? null)

// 上传的原图可能很大；先压缩再转成 data URL，减少接口请求体大小。
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

// 服务端只返回 title/promptId，这里补上前端需要跟踪的 id、index 和状态。
function createPromptItem(index: number, title: string, promptId: string): DetailPromptItem {
  return {
    id: crypto.randomUUID(),
    index,
    title,
    promptId,
    status: "draft",
  }
}

function hasPromptImage(item: DetailPromptItem) {
  return !!item.imageId
}

// 页面刷新或中断后，把未完成的 queued/running 状态恢复成可继续操作的状态。
function resetInterruptedPrompt(item: DetailPromptItem): DetailPromptItem {
  if (item.status !== "queued" && item.status !== "running") return item
  const hasImage = hasPromptImage(item)
  return {
    ...item,
    status: hasImage ? "succeeded" : "draft",
    taskId: hasImage ? item.taskId : undefined,
    error: undefined,
    updatedAt: Date.now(),
  }
}

// 批量生成被取消时，需要把所有未完成项一起恢复。
function resetActiveGenerationPrompts(items: DetailPromptItem[]): DetailPromptItem[] {
  return items.map((item) =>
    item.status === "queued" || item.status === "running"
      ? {
          ...item,
          status: hasPromptImage(item) ? "succeeded" : "draft",
          taskId: hasPromptImage(item) ? item.taskId : undefined,
          error: undefined,
          updatedAt: Date.now(),
        }
      : item,
  )
}

// 保存历史前复制商品输入，避免用户继续编辑表单时影响已经创建的历史记录。
function cloneProduct(input: ProductInput): ProductInput {
  return {
    name: input.name,
    sellingPoints: input.sellingPoints,
    imageCount: input.imageCount,
    productImages: [...input.productImages],
    productImageIds: input.productImageIds ? [...input.productImageIds] : [],
  }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error("图片读取失败"))
    }
    reader.onerror = () => reject(new Error("图片读取失败"))
    reader.readAsDataURL(blob)
  })
}

// 历史里的图片可能是 data URL，也可能是服务端图片 URL；提交给模型前统一转 data URL。
async function imageSrcToDataUrl(src: string) {
  const value = src.trim()
  if (value.startsWith("data:image/")) return value
  const response = await fetch(value, { credentials: "same-origin", cache: "no-store" })
  if (!response.ok) throw new Error("商品参考图读取失败，请重新上传图片。")
  const blob = await response.blob()
  if (!blob.type.startsWith("image/")) throw new Error("商品参考图格式无效，请重新上传图片。")
  return blobToDataUrl(blob)
}

// 生成文案和图片前先把参考图存成 imageId，后续任务接口只传 id。
async function ensureProductImageIds() {
  const images = productImages.value.slice(0, 8)
  const nextIds = productImageIds.value.slice(0, images.length)
  const missing = images.map((image, index) => ({ image, index })).filter((item) => !nextIds[item.index])
  const dataUrls = await Promise.all(missing.map((item) => imageSrcToDataUrl(item.image)))
  const validDataUrls = dataUrls
    .filter((image) => image.startsWith("data:image/"))
    .filter((image) => image.length <= MAX_PROMPT_IMAGE_CHARS)
  const total = validDataUrls.reduce((sum, image) => sum + image.length, 0)
  if (missing.length && validDataUrls.length !== missing.length) {
    throw new Error("商品参考图过大或格式无效，请重新上传图片。")
  }
  if (total > MAX_PROMPT_IMAGE_TOTAL_CHARS) {
    throw new Error("商品参考图总大小过大，请减少图片数量或重新上传后再生成。")
  }
  const uploadedIds = await Promise.all(validDataUrls.map((image) => dbPutProductImage(image)))
  missing.forEach((item, index) => {
    nextIds[item.index] = uploadedIds[index] ?? ""
  })
  const ids = nextIds.filter(Boolean).slice(0, images.length)
  if (!ids.length) throw new Error("请至少上传一张商品参考图。")
  if (ids.length !== images.length) throw new Error("商品参考图保存失败，请重新上传后再试。")
  productImageIds.value = ids
  return ids
}

function getPromptImageSrc(item: DetailPromptItem | undefined) {
  if (!item) return null
  if (item.imageId) return dbImageFileUrl(item.imageId)
  return null
}

// 根据正式路由路径判断当前模块。
function readStudioModeFromUrl(): StudioMode {
  if (typeof window === "undefined") return props.initialMode
  const pathname = window.location.pathname.replace(/\/+$/, "")
  if (pathname.endsWith("/cutout")) return "cutout"
  if (pathname.endsWith("/multi-view")) return "multi-view"
  if (pathname.endsWith("/edit")) return "edit"
  if (pathname.endsWith("/layer")) return "layer"
  if (pathname.endsWith("/image")) return "image"
  return "image"
}

async function flushCutoutDraftIfNeeded() {
  const flushCutoutDraft = window.ecomImgGenFlushCutoutDraft
  if (!flushCutoutDraft) return
  try {
    await flushCutoutDraft()
  } catch (draftError) {
    console.warn("抠图草稿保存失败:", draftError)
  }
}

async function handleModuleLinkClick(event: MouseEvent, mode: StudioMode) {
  if (mode === studioMode.value) return
  if (!window.ecomImgGenFlushCutoutDraft) return
  event.preventDefault()
  await flushCutoutDraftIfNeeded()
  window.location.assign(
    mode === "cutout"
      ? "/cutout/"
      : mode === "multi-view"
        ? "/multi-view/"
        : mode === "edit"
          ? "/edit/"
          : mode === "layer"
            ? "/layer/"
          : "/image/",
  )
}

async function handleHomeLinkClick(event: MouseEvent) {
  if (!window.ecomImgGenFlushCutoutDraft) return
  event.preventDefault()
  await flushCutoutDraftIfNeeded()
  window.location.assign("/")
}

// 写入详情图历史。新增时拿服务端返回的 id，更新时保留当前记录。
async function persistHistory(item: HistoryItem) {
  try {
    if (item.id == null) {
      const id = await dbAdd(item)
      item.id = id as number
    } else {
      await dbPut(item)
    }
    if (item.product.productImageIds?.length) {
      productImageIds.value = item.product.productImageIds
    }
  } catch (event) {
    console.warn("历史记录写入失败:", event)
  }
}

// 普通用户生成成功会扣次数；super_admin 返回 unlimitedCredits 时不改本地次数。
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
  if (!session.value?.user) return
  session.value = {
    ...session.value,
    user: {
      ...session.value.user,
      remainingCredits: result.remainingCredits ?? session.value.user.remainingCredits,
      usedCredits: result.usedCredits ?? session.value.user.usedCredits,
      dailyRemainingCredits: result.dailyRemainingCredits ?? session.value.user.dailyRemainingCredits,
      dailyUsedCredits: result.dailyUsedCredits ?? session.value.user.dailyUsedCredits,
      dailyGrantedCredits: result.dailyGrantedCredits ?? session.value.user.dailyGrantedCredits,
      permanentRemainingCredits: result.permanentRemainingCredits ?? session.value.user.permanentRemainingCredits,
      permanentGrantedCredits: result.permanentGrantedCredits ?? session.value.user.permanentGrantedCredits,
    },
  }
}

// 处理参考图上传：过滤非图片/超大文件，并把可用图片压缩进 productImages。
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

// 重置当前编辑中的商品资料和文案，不清空云端历史。
function handleResetProductInput() {
  if (promptBusy.value || imageBusy.value) return
  error.value = null
  productName.value = ""
  sellingPoints.value = ""
  imageCount.value = 5
  productImages.value = []
  productImageIds.value = []
  aspectRatio.value = "3:4"
  quality.value = "1K"
  prompts.value = []
  activePromptIdx.value = 0
  activeHistoryIdx.value = -1
  if (fileInputRef.value) fileInputRef.value.value = ""
}

// 前端先做基础校验，能把明显问题拦在接口请求之前。
function validateProduct() {
  if (!session.value?.authenticated) {
    error.value = "请先登录后再使用 EcomImgGen。"
    return false
  }
  if (!productName.value.trim()) {
    error.value = "请输入商品名称。"
    return false
  }
  if (!sellingPoints.value.trim()) {
    error.value = "请输入商品核心卖点和功效。"
    return false
  }
  if (!productImages.value.length) {
    error.value = "请至少上传一张商品参考图。系统已禁止纯文案生成，以保证商品外观一致。"
    return false
  }
  return true
}

async function handleLoadDemoData() {
  productName.value = "玻尿酸多效修护精华液"
  sellingPoints.value = "• 深层补水：玻尿酸微分子渗透技术\n• 修护屏障：神经酰胺+角鲨烷双重修护\n• 适合人群：敏感肌、干燥肌、熟龄肌\n• 规格：30ml 旅行装 / 50ml 标准装\n• 使用感：清爽不油腻，快速吸收"
  imageCount.value = 5
  aspectRatio.value = "3:4"
  quality.value = "1K"
  const canvas = document.createElement("canvas")
  canvas.width = 900
  canvas.height = 1200
  const context = canvas.getContext("2d", { alpha: false })
  if (!context) return
  context.fillStyle = "#f8fafc"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#2563eb"
  context.beginPath()
  context.roundRect(300, 360, 300, 600, 45)
  context.fill()
  context.fillStyle = "#1e293b"
  context.fillRect(390, 240, 120, 120)
  context.fillStyle = "#ffffff"
  context.font = "700 64px sans-serif"
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText("SKU", 450, 660)
  productImages.value = [canvas.toDataURL("image/png")]
}

// 第一步：根据商品资料生成详情图文案，不直接生成图片。
async function handleGeneratePrompts() {
  error.value = null
  if (!validateProduct()) return
  promptBusy.value = true
  try {
    const result = await generateDetailPrompts({
      name: productName.value.trim(),
      sellingPoints: sellingPoints.value.trim(),
      imageCount: imageCount.value,
      productImageIds: await ensureProductImageIds(),
    })
    prompts.value = result.prompts.map((item, index) =>
      createPromptItem(index, item.title, item.promptId),
    )
    activePromptIdx.value = 0
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    promptBusy.value = false
  }
}

function handleTitleChange(id: string, value: string) {
  prompts.value = prompts.value.map((item) => (item.id === id ? { ...item, title: value } : item))
}

// 长时间生成时尽量保持屏幕唤醒；浏览器不支持也不影响核心功能。
async function requestWakeLock() {
  try {
    const maybeWakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> }
      }
    ).wakeLock
    if (maybeWakeLock) wakeLockRef.value = await maybeWakeLock.request("screen")
  } catch {
    // Wake Lock is optional.
  }
}

async function cleanupImageGeneration() {
  imageAbortRef.value = null
  imageCancelRequestedRef.value = false
  currentImageTaskIdRef.value = null
  if (wakeLockRef.value) {
    await wakeLockRef.value.release().catch(() => undefined)
    wakeLockRef.value = null
  }
  imageBusy.value = false
}

// 第二步：按文案顺序逐张创建图片任务、轮询结果、保存历史。
async function handleGenerateImages() {
  error.value = null
  if (!validateProduct()) return
  if (!prompts.value.length) {
    error.value = "请先生成详情图方案。"
    return
  }
  if (prompts.value.some((item) => !item.promptId)) {
    error.value = "详情图方案缺少后端引用，请重新生成详情图方案。"
    return
  }

  imageBusy.value = true
  imageCancelRequestedRef.value = false
  imageAbortRef.value = new AbortController()
  let historyItem: HistoryItem = {
    product: cloneProduct(currentProduct.value),
    prompts: prompts.value.map((item) => ({
      ...item,
      status: "draft",
      imageId: undefined,
    })),
    timestamp: Date.now(),
    generation: {
      aspectRatio: aspectRatio.value,
      quality: quality.value,
      size: resolvedSize.value,
    },
  }

  try {
    const generationImageIds = await ensureProductImageIds()
    historyItem = { ...historyItem, product: cloneProduct(currentProduct.value) }
    await requestWakeLock()
    await persistHistory(historyItem)
    history.value = [...history.value, historyItem]
    activeHistoryIdx.value = history.value.length - 1

    // 每张图独立创建任务，方便失败时知道是哪一张出问题，也支持逐张保存历史。
    let working = historyItem.prompts
    for (let index = 0; index < working.length; index += 1) {
      if (imageCancelRequestedRef.value) throw new ImageGenerationCancelledError()
      activePromptIdx.value = index
      working = working.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: "queued", error: undefined, updatedAt: Date.now() }
          : item,
      )
      historyItem = { ...historyItem, prompts: working }
      prompts.value = working
      await persistHistory(historyItem)

      const task = await createImageTask(
        {
          promptId: working[index]?.promptId ?? "",
          size: resolvedSize.value,
          aspectRatio: aspectRatio.value,
          quality: quality.value,
          inputImageIds: generationImageIds,
        },
        imageAbortRef.value?.signal,
      )
      currentImageTaskIdRef.value = task.taskId
      updateSessionCredits(task)

      // 创建任务成功后进入 running；真正图片结果要等 pollImageTask 返回。
      working = working.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: "running", taskId: task.taskId, updatedAt: Date.now() }
          : item,
      )
      historyItem = { ...historyItem, prompts: working }
      prompts.value = working
      await persistHistory(historyItem)

      const result = await pollImageTask(task.taskId, undefined, imageAbortRef.value?.signal)
      if (imageCancelRequestedRef.value || result.status === "canceled") {
        throw new ImageGenerationCancelledError()
      }
      if (result.status === "failed") {
        const message = result.error || "任务执行失败"
        working = working.map((item, itemIndex) =>
          itemIndex === index
            ? { ...item, status: "failed", error: message, updatedAt: Date.now() }
            : item,
        )
        historyItem = { ...historyItem, prompts: working }
        prompts.value = working
        await persistHistory(historyItem)
        throw new Error(message)
      }
      updateSessionCredits(result)
      if (!result.imageId) {
        throw new Error(`${working[index]?.title ?? `第${index + 1}张详情图`}未返回图片 ID`)
      }

      working = working.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              status: "succeeded",
              imageId: result.imageId,
              model: result.model,
              updatedAt: Date.now(),
            }
          : item,
      )
      historyItem = { ...historyItem, prompts: working }
      prompts.value = working
      currentImageTaskIdRef.value = null
      history.value = history.value.map((item) => (item.id === historyItem.id ? historyItem : item))
      await persistHistory(historyItem)
    }
  } catch (event) {
    if (
      event instanceof ImageGenerationCancelledError ||
      (event instanceof DOMException && event.name === "AbortError")
    ) {
      historyItem = { ...historyItem, prompts: resetActiveGenerationPrompts(historyItem.prompts) }
      prompts.value = historyItem.prompts
      history.value = history.value.map((item) => (item.id === historyItem.id ? historyItem : item))
      await persistHistory(historyItem)
    } else {
      error.value = event instanceof Error ? event.message : String(event)
    }
  } finally {
    await cleanupImageGeneration()
  }
}

// 只重新生成当前选中的一张详情图，其余已完成图片保持不变。
async function handleRegenerateActiveImage() {
  error.value = null
  if (!validateProduct()) return
  if (!prompts.value.length) {
    error.value = "请先生成详情图方案。"
    return
  }
  const targetIndex = Math.min(Math.max(activePromptIdx.value, 0), prompts.value.length - 1)
  const target = prompts.value[targetIndex]
  if (!target?.promptId) {
    error.value = "当前详情图方案缺少后端引用，请重新生成详情图方案。"
    return
  }

  imageBusy.value = true
  imageCancelRequestedRef.value = false
  imageAbortRef.value = new AbortController()
  let historyItem: HistoryItem = history.value[activeHistoryIdx.value]
    ? {
        ...history.value[activeHistoryIdx.value],
        product: cloneProduct(currentProduct.value),
        prompts: prompts.value.map(resetInterruptedPrompt),
        timestamp: Date.now(),
        generation: {
          aspectRatio: aspectRatio.value,
          quality: quality.value,
          size: resolvedSize.value,
        },
      }
    : {
        product: cloneProduct(currentProduct.value),
        prompts: prompts.value.map(resetInterruptedPrompt),
        timestamp: Date.now(),
        generation: {
          aspectRatio: aspectRatio.value,
          quality: quality.value,
          size: resolvedSize.value,
        },
      }

  try {
    const generationImageIds = await ensureProductImageIds()
    historyItem = { ...historyItem, product: cloneProduct(currentProduct.value) }
    await requestWakeLock()
    await persistHistory(historyItem)
    const existingIndex = history.value.findIndex((item) => item.id === historyItem.id)
    if (existingIndex >= 0) {
      history.value = history.value.map((item, index) => (index === existingIndex ? historyItem : item))
      activeHistoryIdx.value = existingIndex
    } else {
      history.value = [...history.value, historyItem]
      activeHistoryIdx.value = history.value.length - 1
    }

    let working: DetailPromptItem[] = historyItem.prompts.map((item, itemIndex) =>
      itemIndex === targetIndex
        ? {
            ...item,
            status: "queued" as const,
            imageId: undefined,
            model: undefined,
            taskId: undefined,
            error: undefined,
            updatedAt: Date.now(),
          }
        : item,
    )
    historyItem = { ...historyItem, prompts: working }
    prompts.value = working
    await persistHistory(historyItem)

    const task = await createImageTask(
      {
        promptId: working[targetIndex]?.promptId ?? "",
        size: resolvedSize.value,
        aspectRatio: aspectRatio.value,
        quality: quality.value,
        inputImageIds: generationImageIds,
      },
      imageAbortRef.value?.signal,
    )
    currentImageTaskIdRef.value = task.taskId
    updateSessionCredits(task)

    working = working.map((item, itemIndex): DetailPromptItem =>
      itemIndex === targetIndex
        ? { ...item, status: "running" as const, taskId: task.taskId, updatedAt: Date.now() }
        : item,
    )
    historyItem = { ...historyItem, prompts: working }
    prompts.value = working
    await persistHistory(historyItem)

    const result = await pollImageTask(task.taskId, undefined, imageAbortRef.value?.signal)
    if (imageCancelRequestedRef.value || result.status === "canceled") {
      throw new ImageGenerationCancelledError()
    }
    if (result.status === "failed") {
      const message = result.error || "任务执行失败"
      working = working.map((item, itemIndex): DetailPromptItem =>
        itemIndex === targetIndex
          ? { ...item, status: "failed" as const, error: message, updatedAt: Date.now() }
          : item,
      )
      historyItem = { ...historyItem, prompts: working }
      prompts.value = working
      history.value = history.value.map((item) => (item.id === historyItem.id ? historyItem : item))
      await persistHistory(historyItem)
      throw new Error(message)
    }
    updateSessionCredits(result)
    if (!result.imageId) {
      throw new Error(`${target.title}未返回图片 ID`)
    }

    working = working.map((item, itemIndex): DetailPromptItem =>
      itemIndex === targetIndex
        ? {
            ...item,
            status: "succeeded" as const,
            imageId: result.imageId,
            model: result.model,
            taskId: undefined,
            error: undefined,
            updatedAt: Date.now(),
          }
        : item,
    )
    historyItem = { ...historyItem, prompts: working }
    prompts.value = working
    currentImageTaskIdRef.value = null
    history.value = history.value.map((item) => (item.id === historyItem.id ? historyItem : item))
    await persistHistory(historyItem)
  } catch (event) {
    if (
      event instanceof ImageGenerationCancelledError ||
      (event instanceof DOMException && event.name === "AbortError")
    ) {
      historyItem = { ...historyItem, prompts: resetActiveGenerationPrompts(historyItem.prompts) }
      prompts.value = historyItem.prompts
      history.value = history.value.map((item) => (item.id === historyItem.id ? historyItem : item))
      await persistHistory(historyItem)
    } else {
      error.value = event instanceof Error ? event.message : String(event)
    }
  } finally {
    await cleanupImageGeneration()
  }
}

// 中断当前正在轮询的图片任务，并通知服务端把任务标记为取消。
function handleCancelImageGeneration() {
  if (!imageBusy.value) return
  imageCancelRequestedRef.value = true
  const taskId = currentImageTaskIdRef.value
  if (taskId) cancelImageTask(taskId).catch((event) => console.warn("取消图片任务失败:", event))
  imageAbortRef.value?.abort()
}

// 从历史记录恢复到编辑区，用户可以继续改文案或重新生成某张图。
function handleSelectHistory(idx: number) {
  const item = history.value[idx]
  if (!item) return
  activeHistoryIdx.value = idx
  productName.value = item.product.name
  sellingPoints.value = item.product.sellingPoints
  imageCount.value = Math.min(MAX_DETAIL_IMAGES, Math.max(1, item.product.imageCount))
  productImageIds.value = item.product.productImageIds ?? []
  productImages.value = item.product.productImages
  if (item.product.productImageIds?.length) {
    dbGetProductImages(item.product.productImageIds)
      .then((images) => {
        productImages.value = images.slice(0, 8)
      })
      .catch((event) => console.warn("商品参考图恢复失败:", event))
  }
  prompts.value = item.prompts.map(resetInterruptedPrompt)
  if (item.generation?.aspectRatio && ASPECT_RATIO_VALUES.includes(item.generation.aspectRatio)) {
    aspectRatio.value = item.generation.aspectRatio
  }
  if (item.generation?.quality && IMAGE_QUALITY_VALUES.includes(item.generation.quality)) {
    quality.value = item.generation.quality
  }
  activePromptIdx.value = 0
}

// 删除单条历史时，同步维护当前选中的历史下标。
function handleDeleteHistory(idx: number) {
  const item = history.value[idx]
  if (!item) return
  if (item.id != null) dbDel(item.id).catch((event) => console.warn(event))
  history.value = history.value.filter((_, index) => index !== idx)
  if (activeHistoryIdx.value === idx) {
    activeHistoryIdx.value = history.value.length ? Math.min(idx, history.value.length - 1) : -1
  } else if (activeHistoryIdx.value > idx) {
    activeHistoryIdx.value -= 1
  }
}

async function handleClearHistory() {
  if (!confirm("确定清空所有商品详情图历史？此操作不可撤销。")) return
  try {
    await dbClear()
  } catch (event) {
    console.warn(event)
  }
  history.value = []
  activeHistoryIdx.value = -1
}

// 访问码登录，用于没有 OAuth 的场景。
async function handleAccessLogin() {
  const code = accessCode.value.trim()
  if (!code) {
    error.value = "请输入访问码。"
    return
  }
  error.value = null
  accessBusy.value = true
  try {
    const response = await fetch("/api/auth/login/access", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
    const payload = (await response.json().catch(() => null)) as AuthSession | { error?: string } | null
    if (!response.ok) {
      throw new Error(
        payload && "error" in payload && payload.error ? payload.error : `HTTP ${response.status}`,
      )
    }
    session.value = payload as AuthSession
    accessCode.value = ""
    authPopoverOpen.value = false
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
  } finally {
    accessBusy.value = false
  }
}

// 下载时直接使用当前图片 src，可能是 data URL，也可能是服务端文件 URL。
function handleDownload(index: number) {
  const imageSrc = getPromptImageSrc(prompts.value[index])
  if (!imageSrc) return
  const anchor = document.createElement("a")
  anchor.href = imageSrc
  anchor.download = `ecom-detail-${productName.value || "product"}-${index + 1}.png`
  anchor.click()
}

function handleLocationChange() {
  studioMode.value = readStudioModeFromUrl()
}

function handlePointerDownOutside(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Node)) return
  if (!authPopoverRef.value?.contains(target)) authPopoverOpen.value = false
}

function handleAuthEscape(event: KeyboardEvent) {
  if (event.key === "Escape") authPopoverOpen.value = false
}

watch(
  () => session.value?.user?.image,
  () => {
    avatarFailed.value = false
  },
)

// 登录菜单打开时监听外部点击和 Escape；关闭时及时移除监听，避免泄漏。
watch(authPopoverOpen, (open) => {
  if (typeof window === "undefined") return
  document.removeEventListener("mousedown", handlePointerDownOutside)
  document.removeEventListener("keydown", handleAuthEscape)
  if (open) {
    document.addEventListener("mousedown", handlePointerDownOutside)
    document.addEventListener("keydown", handleAuthEscape)
  }
})

// 自动保存草稿到 localStorage。这里 deep: true 是为了监听 prompts 数组内部变化。
watch(
  [draftLoaded, productName, sellingPoints, imageCount, prompts, aspectRatio, quality, productImageIds],
  () => {
    if (!draftLoaded.value || studioMode.value !== "image" || !import.meta.client) return
    try {
      const draft: DraftState = {
        productName: productName.value,
        sellingPoints: sellingPoints.value,
        imageCount: imageCount.value,
        prompts: prompts.value,
        aspectRatio: aspectRatio.value,
        quality: quality.value,
        productImageIds: productImageIds.value,
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
      // Ignore storage failures.
    }
  },
  { deep: true },
)

// 页面初始化：恢复草稿、加载历史、读取登录态。
onMounted(() => {
  studioMode.value = readStudioModeFromUrl()
  window.addEventListener("popstate", handleLocationChange)
  window.addEventListener("hashchange", handleLocationChange)

  if (studioMode.value === "image") {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const draft = JSON.parse(raw) as DraftState
        productName.value = draft.productName || ""
        sellingPoints.value = draft.sellingPoints || ""
        imageCount.value = Number.isFinite(draft.imageCount)
          ? Math.min(MAX_DETAIL_IMAGES, Math.max(1, Math.round(draft.imageCount)))
          : 5
        prompts.value = Array.isArray(draft.prompts)
          ? draft.prompts.map(resetInterruptedPrompt)
          : []
        if (draft.aspectRatio && ASPECT_RATIO_VALUES.includes(draft.aspectRatio)) {
          aspectRatio.value = draft.aspectRatio
        }
        if (draft.quality && IMAGE_QUALITY_VALUES.includes(draft.quality)) {
          quality.value = draft.quality
        }
        if (Array.isArray(draft.productImageIds) && draft.productImageIds.length) {
          productImageIds.value = draft.productImageIds
          dbGetProductImages(draft.productImageIds)
            .then((images) => {
              productImages.value = images.slice(0, 8)
            })
            .catch((event) => console.warn("商品参考图恢复失败:", event))
        }
      }
    } catch {
      // Ignore invalid local draft.
    } finally {
      draftLoaded.value = true
    }
  } else {
    draftLoaded.value = true
  }

  if (studioMode.value === "image") {
    void (async () => {
      try {
        const items = (await dbAll()) ?? []
        history.value = items
        if (items.length) activeHistoryIdx.value = items.length - 1
      } catch (event) {
        console.warn("历史记录读取失败:", event)
      }
    })()
  }

  void (async () => {
    try {
      const response = await fetch("/api/auth/session", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      session.value = (await response.json()) as AuthSession
    } catch {
      session.value = { authenticated: false, user: null }
    } finally {
      sessionLoading.value = false
    }
  })()
})

// 组件卸载时清理全局监听，防止切换页面后事件重复触发。
onBeforeUnmount(() => {
  window.removeEventListener("popstate", handleLocationChange)
  window.removeEventListener("hashchange", handleLocationChange)
  document.removeEventListener("mousedown", handlePointerDownOutside)
  document.removeEventListener("keydown", handleAuthEscape)
})
</script>

<template>
  <main class="app-shell">
    <header class="studio-topbar">
      <div class="brand-block">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="brand" />
        </span>
        <div>
          <h1>EcomImgGen</h1>
          <p class="tagline">Image Studio</p>
        </div>
      </div>

      <nav class="creative-tabs" aria-label="创作类型">
        <a href="/" class="creative-tab" @click="handleHomeLinkClick">
          <Icon name="brand" />
          <span>首页</span>
        </a>
        <a
          href="/image/"
          :class="['creative-tab', { 'is-active': studioMode === 'image' }]"
          :aria-current="studioMode === 'image' ? 'page' : undefined"
          @click="event => handleModuleLinkClick(event, 'image')"
        >
          <Icon name="spark" />
          <span>详情图</span>
        </a>
        <a
          href="/cutout/"
          :class="['creative-tab', { 'is-active': studioMode === 'cutout' }]"
          :aria-current="studioMode === 'cutout' ? 'page' : undefined"
          @click="event => handleModuleLinkClick(event, 'cutout')"
        >
          <Icon name="cutout" />
          <span>抠图</span>
        </a>
        <a
          href="/multi-view/"
          :class="['creative-tab', { 'is-active': studioMode === 'multi-view' }]"
          :aria-current="studioMode === 'multi-view' ? 'page' : undefined"
          @click="event => handleModuleLinkClick(event, 'multi-view')"
        >
          <Icon name="queue" />
          <span>多视角</span>
        </a>
        <a
          href="/edit/"
          :class="['creative-tab', { 'is-active': studioMode === 'edit' }]"
          :aria-current="studioMode === 'edit' ? 'page' : undefined"
          @click="event => handleModuleLinkClick(event, 'edit')"
        >
          <Icon name="brush" />
          <span>改图</span>
        </a>
        <a
          href="/layer/"
          :class="['creative-tab', { 'is-active': studioMode === 'layer' }]"
          :aria-current="studioMode === 'layer' ? 'page' : undefined"
          @click="event => handleModuleLinkClick(event, 'layer')"
        >
          <Icon name="text" />
          <span>分层</span>
        </a>
      </nav>

      <div class="top-actions">
        <div ref="authPopoverRef" class="auth-popover-wrap">
          <button
            type="button"
            :class="[
              'auth-toggle',
              { 'is-open': authPopoverOpen, 'is-authenticated': authenticated, 'is-guest': !authenticated },
            ]"
            :aria-label="authLabel"
            :aria-expanded="authPopoverOpen"
            aria-haspopup="dialog"
            :title="authenticated ? session?.user?.name || '账户' : '登录'"
            @click="authPopoverOpen = !authPopoverOpen"
          >
            <img
              v-if="showUserImage && session?.user?.image"
              :src="session.user.image"
              :alt="session.user.name"
              class="auth-toggle-avatar"
              @error="avatarFailed = true"
            >
            <Icon v-else name="user" class="auth-toggle-icon" />
          </button>

          <div v-if="authPopoverOpen" class="auth-popover" role="dialog" aria-label="登录菜单">
            <p v-if="sessionLoading" class="auth-popover-note">正在检查登录状态...</p>

            <template v-else-if="authenticated && session?.user">
              <div class="auth-popover-user">
                <img
                  v-if="showUserImage && session.user.image"
                  :src="session.user.image"
                  :alt="session.user.name"
                  class="auth-avatar"
                  @error="avatarFailed = true"
                >
                <div v-else class="auth-avatar auth-avatar-fallback">
                  {{ session.user.name.slice(0, 1).toUpperCase() }}
                </div>
                <div>
                  <p class="auth-name">{{ session.user.name }}</p>
                  <p class="auth-meta">
                    {{ providerLabel }}{{ session.user.email ? ` · ${session.user.email}` : "" }}
                  </p>
                </div>
              </div>
              <div class="account-stats" aria-label="账户额度">
                <div class="account-stat account-stat-primary">
                  <span>今日剩余</span>
                  <strong>{{ dailyRemainingLabel }}</strong>
                </div>
                <div class="account-stat">
                  <span>永久额度</span>
                  <strong>{{ permanentRemainingLabel }}</strong>
                </div>
                <div class="account-stat">
                  <span>今日已用</span>
                  <strong>{{ dailyUsedLabel }}</strong>
                </div>
              </div>
              <button
                v-if="isAdmin"
                class="btn-secondary auth-popover-link"
                type="button"
                @click="adminOpen = true; authPopoverOpen = false"
              >
                后台管理
              </button>
              <a
                class="btn-ghost auth-link auth-popover-link auth-popover-logout"
                :href="`/api/auth/logout?redirectTo=${encodeURIComponent(authRedirectPath)}`"
              >
                退出登录
              </a>
            </template>

            <template v-else>
              <p class="auth-popover-note">登录后才能生成详情图文案和商品详情图。</p>
              <form class="access-form access-form-compact" @submit.prevent="handleAccessLogin">
                <label class="sr-only" for="access-code-popover-username">用户名</label>
                <input
                  id="access-code-popover-username"
                  class="sr-only"
                  name="username"
                  type="text"
                  aria-label="用户名"
                  value="access-code"
                  readonly
                  tabindex="-1"
                  autocomplete="username"
                >
                <label class="sr-only" for="access-code-popover">访问码</label>
                <input
                  id="access-code-popover"
                  v-model="accessCode"
                  name="accessCode"
                  type="password"
                  placeholder="访问码"
                  aria-label="访问码"
                  autocomplete="current-password"
                >
                <button class="btn-primary" type="submit" :disabled="accessBusy">
                  {{ accessBusy ? "登录中..." : "访问码登录" }}
                </button>
              </form>
              <a
                class="btn-ghost auth-link auth-popover-link"
                :href="`/api/auth/login/github?redirectTo=${encodeURIComponent(authRedirectPath)}`"
              >
                使用 GitHub 登录
              </a>
              <a
                class="btn-ghost auth-link auth-popover-link"
                :href="`/api/auth/login/google?redirectTo=${encodeURIComponent(authRedirectPath)}`"
              >
                使用 Google 登录
              </a>
            </template>
          </div>
        </div>
      </div>
    </header>

    <template v-if="studioMode === 'image'">
      <div class="run-status" aria-label="当前任务状态">
        <span>{{ prompts.length ? `${prompts.length} 个方案` : "方案未生成" }}</span>
        <span>{{ productImages.length ? `${productImages.length} 张参考图` : "未上传参考图" }}</span>
        <span>{{ creditLabel }}</span>
        <span>{{ generationLabel }}</span>
        <span v-if="imageBusy" class="status-generating">
          <span class="status-pulse" aria-hidden="true"></span>
          生成中 {{ activePromptIndex + 1 }}/{{ prompts.length }}
        </span>
        <span v-else>待命</span>
      </div>

      <div class="studio-grid">
        <aside class="studio-panel input-rail">
          <div class="panel-heading">
            <h2>商品资料</h2>
            <button
              type="button"
              class="inline-action panel-reset-action"
              :disabled="promptBusy || imageBusy"
              @click="handleResetProductInput"
            >
              重置
            </button>
          </div>

          <div class="input-rail-body">
            <div class="form-grid">
              <div>
                <label for="product-name">商品名称</label>
                <input
                  id="product-name"
                  v-model="productName"
                  type="text"
                  :disabled="controlsDisabled"
                  placeholder="示例：玻尿酸修护精华液 | 真皮沙发双人座 | 儿童智能手表"
                >
              </div>
            </div>

            <label for="selling-points">核心卖点/功效</label>
            <textarea
              id="selling-points"
              v-model="sellingPoints"
              class="selling-points"
              :disabled="controlsDisabled"
              placeholder="请输入商品核心卖点、适用人群、规格信息和购买理由。&#10;&#10;示例：&#10;• 深层补水：玻尿酸微分子渗透技术&#10;• 修护屏障：神经酰胺+角鲨烷双重修护&#10;• 适合人群：敏感肌、干燥肌、熟龄肌&#10;• 规格：30ml 旅行装 / 50ml 标准装&#10;• 使用感：清爽不油腻，快速吸收"
            />

            <div class="field-row-head">
              <label for="product-images">商品参考图 <span class="field-hint">(至少1张，最多8张)</span></label>
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
            <div class="product-media">
              <div
                v-for="(src, index) in productImages"
                :key="`${src.slice(0, 32)}-${index}`"
                class="prompt-thumb"
              >
                <button
                  type="button"
                  class="prompt-thumb-preview"
                  :aria-label="`查看商品图 ${index + 1}`"
                  @click="lightboxSrc = src"
                >
                  <img :src="src" :alt="`商品图 ${index + 1}`">
                </button>
                <button
                  type="button"
                  class="prompt-thumb-del"
                  :disabled="controlsDisabled"
                  :aria-label="`移除商品图 ${index + 1}`"
                  @click="productImages = productImages.filter((_, i) => i !== index); productImageIds = productImageIds.filter((_, i) => i !== index)"
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
              id="product-images"
              ref="fileInputRef"
              name="productImages"
              type="file"
              aria-label="上传商品参考图"
              accept="image/*"
              multiple
              hidden
              @change="event => handleSelectFiles((event.target as HTMLInputElement).files)"
            >

            <div class="settings-row">
              <div class="setting-block">
                <div class="setting-head">
                  <label>张数</label>
                  <span>{{ imageCount }} 张</span>
                </div>
                <div class="param-controls" aria-label="详情图张数">
                  <ImageCountSelector
                    :value="imageCount"
                    :disabled="controlsDisabled"
                    @change="imageCount = $event"
                  />
                </div>
              </div>
              <div class="setting-block">
                <div class="setting-head">
                  <label>画面比例</label>
                  <span>{{ aspectRatio === "auto" ? "Auto" : aspectRatio }}</span>
                </div>
                <div class="param-controls" aria-label="画面比例">
                  <AspectRatioSelector
                    :value="aspectRatio"
                    :disabled="controlsDisabled"
                    @change="aspectRatio = $event"
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
            <button type="button" class="btn-primary" :disabled="controlsDisabled" @click="handleGeneratePrompts">
              <span v-if="promptBusy" class="btn-spinner" aria-hidden="true" />
              {{ promptBusy ? "AI 生成方案中..." : "生成详情图方案" }}
            </button>
            <div v-if="error" class="alert">{{ error }}</div>
          </div>
        </aside>

        <aside class="studio-panel prompt-rail">
          <div class="panel-heading">
            <h2>详情图方案</h2>
            <span class="panel-count">
              {{ activePrompt ? `${activePromptIndex + 1} / ${prompts.length}` : `${prompts.length} 个` }}
            </span>
          </div>
          <div class="prompt-editor-list">
            <div v-if="promptBusy" class="busy-card">
              <span class="busy-orbit" aria-hidden="true" />
              <strong>正在生成详情图方案</strong>
              <p>AI 正在分析商品资料和参考图，预计需要 10-20 秒...</p>
            </div>
            <div v-else-if="!activePrompt" class="empty" style="display: flex; flex-direction: column; align-items: center; gap: 14px; justify-content: center; padding: 32px; text-align: center;">
              <Icon name="spark" style="width: 32px; height: 32px; color: var(--accent); opacity: 0.8;" />
              <div style="font-size: 0.84rem; color: var(--text-sub);">还没有详情图生成方案。</div>
              <button
                type="button"
                class="btn-secondary"
                style="min-height: 32px; padding: 6px 12px; font-size: 0.78rem; border-radius: var(--radius-control); cursor: pointer; font-weight: bold;"
                :disabled="controlsDisabled"
                @click="handleLoadDemoData"
              >
                导入示例数据
              </button>
            </div>
            <template v-else>
              <div class="prompt-switcher" aria-label="详情图方案切换">
                <button
                  type="button"
                  class="prompt-nav-btn"
                  :disabled="activePromptIndex === 0"
                  @click="activePromptIdx = Math.max(0, activePromptIndex - 1)"
                >
                  上一张
                </button>
                <div class="prompt-step-list" role="tablist" aria-label="切换详情图方案">
                  <button
                    v-for="(item, index) in prompts"
                    :key="item.id"
                    type="button"
                    role="tab"
                    :aria-selected="index === activePromptIndex"
                    :class="['prompt-step', { 'is-active': index === activePromptIndex }]"
                    @click="activePromptIdx = index"
                  >
                    <span>{{ index + 1 }}</span>
                    <span :class="['prompt-step-status', `is-${item.status}`]" aria-hidden="true" />
                  </button>
                </div>
                <button
                  type="button"
                  class="prompt-nav-btn"
                  :disabled="activePromptIndex >= prompts.length - 1"
                  @click="activePromptIdx = Math.min(prompts.length - 1, activePromptIndex + 1)"
                >
                  下一张
                </button>
              </div>

              <div :key="activePrompt.id" class="prompt-editor prompt-editor-single is-active">
                <div class="prompt-editor-head">
                  <span class="prompt-index">{{ activePromptIndex + 1 }}</span>
                  <input
                    aria-label="详情图方案标题"
                    type="text"
                    :value="activePrompt.title"
                    :disabled="imageBusy"
                    @input="event => handleTitleChange(activePrompt!.id, (event.target as HTMLInputElement).value)"
                  >
                  <span :class="['status-pill', `is-${activePrompt.status}`]">
                    {{ STATUS_LABEL[activePrompt.status] }}
                  </span>
                </div>
                <div class="prompt-plan-summary">
                  <strong>{{ activePrompt.title || `第${activePromptIndex + 1}张详情图` }}</strong>
                  <span>方案内容由系统在后端保存。</span>
                </div>
              </div>
            </template>
          </div>
          <div class="prompt-action-bar">
            <div class="generation-action-row">
              <button
                type="button"
                class="btn-secondary"
                :disabled="controlsDisabled || !prompts.length"
                @click="handleGenerateImages"
              >
                <span v-if="imageBusy" class="btn-spinner" aria-hidden="true" />
                {{ imageBusy ? `生成中 (${activePromptIndex + 1}/${prompts.length})` : "批量生成详情图" }}
              </button>
              <button
                v-if="!imageBusy"
                type="button"
                class="btn-ghost"
                :disabled="controlsDisabled || !activePrompt?.promptId"
                @click="handleRegenerateActiveImage"
              >
                重新生成当前图
              </button>
              <button
                v-if="imageBusy"
                type="button"
                class="btn-danger cancel-generation-btn"
                @click="handleCancelImageGeneration"
              >
                中断生成
              </button>
            </div>
          </div>
        </aside>

        <section class="studio-panel canvas-panel">
          <div class="panel-heading">
            <h2>详情图预览</h2>
            <span class="panel-count">{{ generationLabel }}</span>
          </div>
          <Stage
            :prompts="prompts"
            :active-index="activePromptIndex"
            :busy="imageBusy"
            @select="activePromptIdx = $event"
            @download="handleDownload"
            @load-demo="handleLoadDemoData"
            @zoom="index => {
              const imageSrc = getPromptImageSrc(prompts[index])
              if (imageSrc) lightboxSrc = imageSrc
            }"
          />
        </section>
      </div>

      <section class="studio-panel history-dock">
        <HistoryGrid
          :history="history"
          :active-idx="activeHistoryIdx"
          @select="handleSelectHistory"
          @delete="handleDeleteHistory"
          @clear-all="handleClearHistory"
        />
      </section>
    </template>

    <CutoutStudio
      v-else-if="studioMode === 'cutout'"
      :authenticated="authenticated"
      :session-loading="sessionLoading"
      :session="session"
      @update:session="session = $event"
      @zoom="lightboxSrc = $event"
    />

    <MultiViewStudio
      v-else-if="studioMode === 'multi-view'"
      :authenticated="authenticated"
      :session-loading="sessionLoading"
      :session="session"
      @update:session="session = $event"
      @zoom="lightboxSrc = $event"
    />

    <EditStudio
      v-else-if="studioMode === 'edit'"
      :authenticated="authenticated"
      :session-loading="sessionLoading"
      :session="session"
      @update:session="session = $event"
      @zoom="lightboxSrc = $event"
    />

    <LayerStudio
      v-else
      :authenticated="authenticated"
      :session-loading="sessionLoading"
      :session="session"
      @update:session="session = $event"
      @zoom="lightboxSrc = $event"
    />

    <footer>
      EcomImgGen · 历史记录云端同步 · GitHub
      <a
        class="github-link"
        href="https://github.com/dming519/ecom-img-gen"
        target="_blank"
        rel="noreferrer"
        aria-label="查看 GitHub 仓库"
        title="查看 GitHub 仓库"
      >
        GH
      </a>
    </footer>

    <Lightbox :src="lightboxSrc" @close="lightboxSrc = null" />
    <AdminPanel :open="adminOpen" @close="adminOpen = false" />
  </main>
</template>
