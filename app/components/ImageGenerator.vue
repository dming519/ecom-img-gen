<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from "vue"
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
import {resolveImageSize} from "@/lib/imageOptions"
import {
  createProductMaterialsMarkdown,
  convertProductMaterialFile,
  getProductMaterialKind,
  getProductMaterialKindLabel,
  MAX_PRODUCT_MATERIAL_BYTES,
  MAX_PRODUCT_MATERIAL_FILES,
  MAX_PRODUCT_MATERIAL_TOTAL_CHARS,
  PRODUCT_MATERIAL_ACCEPT,
} from "@/lib/productMaterials"
import type {
  AspectRatio,
  AuthSession,
  DetailImageMode,
  DetailPromptItem,
  HistoryItem,
  ImageQuality,
  MaterialFeature,
  ProductMaterialFile,
  ProductMaterialKind,
  ProductInput,
  PromptFeatureAssignment,
} from "@/lib/types"
import AdminPanel from "./AdminPanel.vue"
import CutoutStudio from "./CutoutStudio.vue"
import EditStudio from "./EditStudio.vue"
import HistoryDrawer from "./HistoryDrawer.vue"
import HistoryGrid from "./HistoryGrid.vue"
import Icon from "./Icon.vue"
import LayerStudio from "./LayerStudio.vue"
import Lightbox from "./Lightbox.vue"
import MultiViewStudio from "./MultiViewStudio.vue"
import QualitySelector from "./QualitySelector.vue"

type StudioMode = "image" | "cutout" | "multi-view" | "edit" | "layer"
type WakeLockSentinelLike = { release: () => Promise<void> }
type ProductMaterialStatus = "pending" | "converting" | "converted" | "failed"
type PackColumnEntry = { item: DetailPromptItem; index: number }
type PackColumn = {
  mode: DetailImageMode
  label: string
  countLabel: string
  aspectRatio: AspectRatio
  items: PackColumnEntry[]
  activeEntry: PackColumnEntry | null
  activePosition: number
}
type ProductMaterialUpload = Omit<ProductMaterialFile, "markdown"> & {
  file?: File
  markdown?: string
  status: ProductMaterialStatus
  error?: string
}

const props = withDefaults(defineProps<{
  initialMode?: StudioMode
}>(), {
  initialMode: "image",
})

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PRODUCT_IMAGE_EDGE = 1800
const PRODUCT_IMAGE_QUALITY = 0.9
const MAX_PROMPT_IMAGE_CHARS = 1_500_000
const MAX_PROMPT_IMAGE_TOTAL_CHARS = 6_000_000
const MAX_STYLE_REFERENCE_IMAGES = 4
const MAX_MODEL_REFERENCE_IMAGES = 2
const DRAFT_KEY = "ecomimggen_draft_v5"
const IMAGE_QUALITY_VALUES: ImageQuality[] = ["1K", "2K", "4K"]
const IMAGE_MODE_ORDER: DetailImageMode[] = ["main", "detail", "sku"]
const IMAGE_MODE_OPTIONS: Array<{ label: string; value: DetailImageMode }> = [
  {label: "主图", value: "main"},
  {label: "详情图", value: "detail"},
  {label: "SKU图", value: "sku"},
]
const PLATFORM_OPTIONS = [
  {label: "淘宝/天猫", value: "淘宝/天猫", description: "标准货架"},
  {label: "京东", value: "京东", description: "参数信任"},
  {label: "抖音商城", value: "抖音商城", description: "场景转化"},
  {label: "小红书", value: "小红书", description: "种草内容"},
] as const
type TargetPlatformValue = (typeof PLATFORM_OPTIONS)[number]["value"]
const DEFAULT_TARGET_PLATFORM: TargetPlatformValue = "淘宝/天猫"
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
  skuInfo?: string
  imageModes: DetailImageMode[]
  targetPlatform?: string
  audience?: string
  priceBand?: string
  proofMaterials?: string
  offer?: string
  extraRequirements?: string
  prompts: DetailPromptItem[]
  quality?: ImageQuality
  productImageIds?: string[]
  styleReferenceImageIds?: string[]
  modelReferenceImageIds?: string[]
  productMaterials?: ProductMaterialFile[]
  skuMaterials?: ProductMaterialFile[]
  // 智能素材路由
  materialFeatures?: MaterialFeature[]
  featureAssignments?: PromptFeatureAssignment[]
}

// 自定义错误类型：用来区分“用户主动取消”和“真正生成失败”。
class ImageGenerationCancelledError extends Error {
  constructor() {
    super("已中断生成商品图")
    this.name = "ImageGenerationCancelledError"
  }
}

// 页面核心状态。`shallowRef` 适合字符串、数字、布尔值这类只做整体替换的数据。
const studioMode = shallowRef<StudioMode>(props.initialMode)
const productName = shallowRef("")
const sellingPoints = shallowRef("")
const skuInfo = shallowRef("")
const imageModes = ref<DetailImageMode[]>(["main", "detail"])
const targetPlatform = shallowRef<TargetPlatformValue>(DEFAULT_TARGET_PLATFORM)
const audience = shallowRef("")
const priceBand = shallowRef("")
const proofMaterials = shallowRef("")
const offer = shallowRef("")
const extraRequirements = shallowRef("")
const productImages = ref<string[]>([])
const productImageIds = ref<string[]>([])
const styleReferenceImages = ref<string[]>([])
const styleReferenceImageIds = ref<string[]>([])
const modelReferenceImages = ref<string[]>([])
const modelReferenceImageIds = ref<string[]>([])
const productMaterials = ref<ProductMaterialUpload[]>([])
const skuMaterials = ref<ProductMaterialUpload[]>([])
const quality = shallowRef<ImageQuality>("1K")
const prompts = ref<DetailPromptItem[]>([])
const history = ref<HistoryItem[]>([])
const activeHistoryIdx = shallowRef(-1)
const activePromptIdx = shallowRef(0)
const columnPromptCursors = ref<Partial<Record<DetailImageMode, number>>>({})
const session = shallowRef<AuthSession | null>(null)
const sessionLoading = shallowRef(true)
const authPopoverOpen = shallowRef(false)
const accessCode = shallowRef("")
const accessBusy = shallowRef(false)
const promptBusy = shallowRef(false)
const imageBusy = shallowRef(false)
const materialBusy = shallowRef(false)
const secondaryProductDetailsOpen = shallowRef(false)
const draftLoaded = shallowRef(false)
const adminOpen = shallowRef(false)
// 智能素材路由状态
const materialFeatures = shallowRef<MaterialFeature[]>([])
const featureAssignments = shallowRef<PromptFeatureAssignment[]>([])
const showFeatureRouting = ref(false)
const galleryOpen = shallowRef(false)
const error = shallowRef<string | null>(null)
const lightboxSrc = shallowRef<string | null>(null)
const avatarFailed = shallowRef(false)

// DOM/浏览器能力引用：这些值不是普通业务数据，只在特定操作时使用。
const fileInputRef = ref<HTMLInputElement | null>(null)
const skuFileInputRef = ref<HTMLInputElement | null>(null)
const styleFileInputRef = ref<HTMLInputElement | null>(null)
const modelFileInputRef = ref<HTMLInputElement | null>(null)
const authPopoverRef = ref<HTMLDivElement | null>(null)
const marketingCardRef = ref<HTMLElement | null>(null)
const wakeLockRef = shallowRef<WakeLockSentinelLike | null>(null)
const imageAbortRef = shallowRef<AbortController | null>(null)
const imageCancelRequestedRef = shallowRef(false)
const currentImageTaskIdRef = shallowRef<string | null>(null)
const suppressImageModeReset = shallowRef(false)

function getImageModeCount(mode: DetailImageMode) {
  if (mode === "sku") return 0
  return mode === "main" ? 5 : 8
}

function getImageModeAspectRatio(mode: DetailImageMode): AspectRatio {
  return mode === "detail" ? "3:4" : "1:1"
}

function getImageModeLabel(mode: DetailImageMode) {
  if (mode === "main") return "主图"
  if (mode === "detail") return "详情图"
  return "SKU图"
}

function getImageModeCountLabel(mode: DetailImageMode) {
  return mode === "sku" ? "动态识别" : `${getImageModeCount(mode)} 张`
}

function normalizeImageModes(value: unknown): DetailImageMode[] {
  const source = Array.isArray(value) ? value : []
  const seen = new Set<DetailImageMode>()
  for (const mode of source) {
    if (mode === "main" || mode === "detail" || mode === "sku") seen.add(mode)
  }
  const ordered = IMAGE_MODE_ORDER.filter((mode) => seen.has(mode))
  return ordered.length ? ordered : ["main", "detail"]
}

function normalizeTargetPlatform(value: unknown): TargetPlatformValue {
  const text = typeof value === "string" ? value : ""
  return PLATFORM_OPTIONS.find((option) => (
    text.includes(option.value) || option.value.split("/").some((part) => text.includes(part))
  ))?.value ?? DEFAULT_TARGET_PLATFORM
}

function getImageModesCount(modes: DetailImageMode[]) {
  return modes.reduce((sum, mode) => sum + getImageModeCount(mode), 0)
}

function getImageModesLabel(modes: DetailImageMode[]) {
  return modes.map((mode) => `${getImageModeLabel(mode)} ${getImageModeCountLabel(mode)}`).join(" + ")
}

function getPromptImageMode(item: DetailPromptItem | null | undefined): DetailImageMode {
  return item?.imageMode ?? "detail"
}

function getPromptAspectRatio(item: DetailPromptItem | null | undefined): AspectRatio {
  return getImageModeAspectRatio(getPromptImageMode(item))
}

function getPromptSize(item: DetailPromptItem | null | undefined) {
  return resolveImageSize(getPromptAspectRatio(item))
}

function toConvertedProductMaterial(item: ProductMaterialUpload): ProductMaterialFile | null {
  if (item.status !== "converted" || !item.markdown) return null
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    kind: item.kind,
    markdown: item.markdown,
  }
}

function restoreProductMaterials(materials: ProductMaterialFile[] | undefined): ProductMaterialUpload[] {
  return (materials ?? []).map((material) => ({
    ...material,
    status: "converted" as const,
  }))
}

// computed 是派生状态：不直接存数据，而是根据上面的源状态实时计算。
const imageCount = computed(() => getImageModesCount(imageModes.value))
const skuPromptCount = computed(() => prompts.value.filter((item) => item.imageMode === "sku").length)
const imageCountLabel = computed(() => {
  if (!imageModes.value.includes("sku")) return `${imageCount.value} 张`
  const total = imageCount.value + skuPromptCount.value
  if (skuPromptCount.value) return `${total} 张`
  return imageCount.value ? `${imageCount.value} 张 + SKU动态` : "SKU动态"
})
const targetPlatformLabel = computed(() => normalizeTargetPlatform(targetPlatform.value))
const convertedProductMaterials = computed<ProductMaterialFile[]>(() =>
    productMaterials.value
        .map((item) => toConvertedProductMaterial(item))
        .filter((item): item is ProductMaterialFile => !!item),
)
const convertedSkuMaterials = computed<ProductMaterialFile[]>(() =>
    skuMaterials.value
        .map((item) => toConvertedProductMaterial(item))
        .filter((item): item is ProductMaterialFile => !!item),
)
const currentProduct = computed<ProductInput>(() => ({
  name: productName.value.trim(),
  sellingPoints: sellingPoints.value.trim(),
  skuInfo: skuInfo.value.trim(),
  imageModes: [...imageModes.value],
  imageCount: imageCount.value + skuPromptCount.value,
  targetPlatform: targetPlatformLabel.value,
  audience: audience.value.trim(),
  priceBand: priceBand.value.trim(),
  proofMaterials: proofMaterials.value.trim(),
  offer: offer.value.trim(),
  extraRequirements: extraRequirements.value.trim(),
  productImages: productImages.value,
  productImageIds: productImageIds.value,
  styleReferenceImages: styleReferenceImages.value,
  styleReferenceImageIds: styleReferenceImageIds.value,
  modelReferenceImages: modelReferenceImages.value,
  modelReferenceImageIds: modelReferenceImageIds.value,
  productMaterials: convertedProductMaterials.value,
  skuMaterials: convertedSkuMaterials.value,
}))
const productMaterialsMarkdown = computed(() => createProductMaterialsMarkdown(convertedProductMaterials.value))
const skuMaterialsMarkdown = computed(() => createProductMaterialsMarkdown(convertedSkuMaterials.value))
// 智能素材路由：根据 promptId 查找该图分配的特征列表
function getPromptFeatureIds(promptId: string | undefined): MaterialFeature[] {
  if (!promptId) return []
  const assignment = featureAssignments.value.find(
    (a) => a.promptId === promptId,
  )
  if (!assignment?.assignedFeatureIds.length) return []
  return assignment.assignedFeatureIds
    .map((fid) => materialFeatures.value.find((f) => f.id === fid))
    .filter(Boolean) as MaterialFeature[]
}
const hasProductUploads = computed(() => productImages.value.length > 0 || productMaterials.value.length > 0)
const productUploadStatusLabel = computed(() => {
  const imageText = productImages.value.length ? `${productImages.value.length} 张图片` : "未上传图片"
  const materialText = productMaterials.value.length ? `${productMaterials.value.length} 份资料` : ""
  const styleText = styleReferenceImages.value.length ? `${styleReferenceImages.value.length} 张风格参考` : ""
  return [imageText, materialText, styleText].filter(Boolean).join(" · ")
})
const secondaryProductInfoCount = computed(() =>
    [priceBand.value, audience.value, proofMaterials.value, offer.value]
        .filter((value) => value.trim()).length,
)
const secondaryProductInfoLabel = computed(() =>
    secondaryProductInfoCount.value ? `已填写 ${secondaryProductInfoCount.value} 项` : "",
)
const generationLabel = computed(() =>
    `${getImageModesLabel(imageModes.value)} · 共 ${imageCountLabel.value} · ${quality.value}`,
)
const authenticated = computed(() => !!session.value?.authenticated)
const authLabel = computed(() =>
    authenticated.value ? `${session.value?.user?.name || "已登录用户"} 账户菜单` : "打开登录菜单",
)
// 所有已出图的图片（按主图→详情图→SKU图排序）
const allGeneratedImages = computed(() =>
  prompts.value
    .filter((item) => item.imageId)
    .map((item) => ({
      ...item,
      src: getPromptImageSrc(item)!,
      modeLabel: item.imageMode === "main" ? "主图" : item.imageMode === "detail" ? "详情图" : "SKU图",
    })),
)
const allGeneratedCount = computed(() => allGeneratedImages.value.length)

const controlsDisabled = computed(
    () =>
        sessionLoading.value ||
        accessBusy.value ||
        promptBusy.value ||
        imageBusy.value ||
        materialBusy.value ||
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
const packColumns = computed<PackColumn[]>(() =>
  IMAGE_MODE_ORDER
    .filter((mode) => imageModes.value.includes(mode))
    .map((mode) => {
      const items = prompts.value
        .map((item, index) => ({item, index}))
        .filter(({item}) => item.imageMode === mode)
      const cursor = columnPromptCursors.value[mode] ?? activePromptIndex.value
      const activePosition = Math.min(
          Math.max(0, items.findIndex(({index}) => index === cursor)),
          Math.max(0, items.length - 1),
      )
      return {
        mode,
        label: getImageModeLabel(mode),
        countLabel: getImageModeCountLabel(mode),
        aspectRatio: getImageModeAspectRatio(mode),
        items,
        activeEntry: items[activePosition] ?? null,
        activePosition,
      }
    }),
)

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
        const ctx = canvas.getContext("2d", {alpha: false, desynchronized: true})
        if (!ctx) {
          reject(new Error("浏览器不支持图片压缩，请更换图片后重试"))
          return
        }
        ctx.fillStyle = "#ffffff"
        ctx.fillRect(0, 0, width, height)
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

// 服务端返回 title/promptId/prompt，这里补上前端需要跟踪的 id、index 和状态。
function createPromptItem(
    index: number,
    title: string,
    promptId: string,
    prompt: string | undefined,
    imageMode: DetailImageMode,
): DetailPromptItem {
  return {
    id: crypto.randomUUID(),
    index,
    title,
    imageMode,
    prompt,
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
  const modes = normalizeImageModes(input.imageModes)
  return {
    name: input.name,
    sellingPoints: input.sellingPoints,
    skuInfo: input.skuInfo ?? "",
    imageModes: modes,
    imageCount: input.imageCount || getImageModesCount(modes),
    targetPlatform: normalizeTargetPlatform(input.targetPlatform),
    audience: input.audience ?? "",
    priceBand: input.priceBand ?? "",
    proofMaterials: input.proofMaterials ?? "",
    offer: input.offer ?? "",
    extraRequirements: input.extraRequirements ?? "",
    productImages: [...input.productImages],
    productImageIds: input.productImageIds ? [...input.productImageIds] : [],
    styleReferenceImages: input.styleReferenceImages ? [...input.styleReferenceImages] : [],
    styleReferenceImageIds: input.styleReferenceImageIds ? [...input.styleReferenceImageIds] : [],
    modelReferenceImages: input.modelReferenceImages ? [...input.modelReferenceImages] : [],
    modelReferenceImageIds: input.modelReferenceImageIds ? [...input.modelReferenceImageIds] : [],
    productMaterials: input.productMaterials?.map((item) => ({...item})) ?? [],
    skuMaterials: input.skuMaterials?.map((item) => ({...item})) ?? [],
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
  const response = await fetch(value, {credentials: "same-origin", cache: "no-store"})
  if (!response.ok) throw new Error("商品参考图读取失败，请重新上传图片。")
  const blob = await response.blob()
  if (!blob.type.startsWith("image/")) throw new Error("商品参考图格式无效，请重新上传图片。")
  return blobToDataUrl(blob)
}

// 生成文案和图片前先把参考图存成 imageId，后续任务接口只传 id。
async function ensureProductImageIds() {
  const images = productImages.value.slice(0, 8)
  const nextIds = productImageIds.value.slice(0, images.length)
  const missing = images.map((image, index) => ({image, index})).filter((item) => !nextIds[item.index])
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

async function ensureStyleReferenceImageIds() {
  const images = styleReferenceImages.value.slice(0, MAX_STYLE_REFERENCE_IMAGES)
  const nextIds = styleReferenceImageIds.value.slice(0, images.length)
  const missing = images.map((image, index) => ({image, index})).filter((item) => !nextIds[item.index])
  const dataUrls = await Promise.all(missing.map((item) => imageSrcToDataUrl(item.image)))
  const validDataUrls = dataUrls
      .filter((image) => image.startsWith("data:image/"))
      .filter((image) => image.length <= MAX_PROMPT_IMAGE_CHARS)
  const total = validDataUrls.reduce((sum, image) => sum + image.length, 0)
  if (missing.length && validDataUrls.length !== missing.length) {
    throw new Error("风格参考图过大或格式无效，请重新上传图片。")
  }
  if (total > MAX_PROMPT_IMAGE_TOTAL_CHARS) {
    throw new Error("风格参考图总大小过大，请减少图片数量或重新上传后再生成。")
  }
  const uploadedIds = await Promise.all(validDataUrls.map((image) => dbPutProductImage(image)))
  missing.forEach((item, index) => {
    nextIds[item.index] = uploadedIds[index] ?? ""
  })
  const ids = nextIds.filter(Boolean).slice(0, images.length)
  if (ids.length !== images.length) throw new Error("风格参考图保存失败，请重新上传后再试。")
  styleReferenceImageIds.value = ids
  return ids
}

function getPromptImageSrc(item: DetailPromptItem | undefined) {
  if (!item) return null
  if (item.imageId) return dbImageFileUrl(item.imageId)
  return null
}

function getColumnStatusText(column: PackColumn) {
  if (promptBusy.value) return "生成方案中"
  if (!column.items.length) return "方案未生成"
  return `${column.items.filter(({item}) => item.imageId).length}/${column.items.length} 已出图`
}

function resetColumnPromptCursors(items = prompts.value) {
  const nextCursors: Partial<Record<DetailImageMode, number>> = {}
  for (const mode of IMAGE_MODE_ORDER) {
    const entryIndex = items.findIndex((item) => item.imageMode === mode)
    if (entryIndex >= 0) nextCursors[mode] = entryIndex
  }
  columnPromptCursors.value = nextCursors
}

function setActivePromptIndex(index: number) {
  const nextIndex = Math.min(Math.max(index, 0), Math.max(0, prompts.value.length - 1))
  activePromptIdx.value = nextIndex
  const prompt = prompts.value[nextIndex]
  if (prompt) {
    columnPromptCursors.value = {
      ...columnPromptCursors.value,
      [prompt.imageMode]: nextIndex,
    }
  }
}

function handleSelectColumnPrompt(column: PackColumn, position: number) {
  const entry = column.items[Math.min(Math.max(position, 0), Math.max(0, column.items.length - 1))]
  if (entry) setActivePromptIndex(entry.index)
}

function handleStepColumnPrompt(column: PackColumn, step: number) {
  if (!column.items.length) return
  const nextPosition = (column.activePosition + step + column.items.length) % column.items.length
  handleSelectColumnPrompt(column, nextPosition)
}

function handlePreviewPrompt(index: number) {
  const nextIndex = Math.min(Math.max(index, 0), Math.max(0, prompts.value.length - 1))
  setActivePromptIndex(nextIndex)
  const imageSrc = getPromptImageSrc(prompts.value[nextIndex])
  if (imageSrc) lightboxSrc.value = imageSrc
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

// 写入商品图历史。新增时拿服务端返回的 id，更新时保留当前记录。
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
    if (item.product.styleReferenceImageIds?.length) {
      styleReferenceImageIds.value = item.product.styleReferenceImageIds
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

function formatMaterialSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  if (size >= 1024) return `${Math.ceil(size / 1024)}KB`
  return `${size}B`
}

function createProductMaterialUploadId() {
  return crypto.randomUUID?.() ?? `material-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createPendingProductMaterial(file: File, kind: ProductMaterialKind): ProductMaterialUpload {
  return {
    id: createProductMaterialUploadId(),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind,
    file,
    status: "pending",
  }
}

function getProductMaterialStatusLabel(status: ProductMaterialStatus) {
  if (status === "converted") return "已转 MD"
  if (status === "converting") return "转换中"
  if (status === "failed") return "转换失败"
  return "待转换"
}

function getProductMaterialTitle(material: ProductMaterialUpload) {
  const status = getProductMaterialStatusLabel(material.status)
  const errorText = material.error ? ` · ${material.error}` : ""
  return `${material.name} · ${formatMaterialSize(material.size)} · ${status}${errorText}`
}

function updateProductMaterial(id: string, patch: Partial<ProductMaterialUpload>) {
  productMaterials.value = productMaterials.value.map((item) =>
      item.id === id ? {...item, ...patch} : item,
  )
}

function updateSkuMaterial(id: string, patch: Partial<ProductMaterialUpload>) {
  skuMaterials.value = skuMaterials.value.map((item) =>
      item.id === id ? {...item, ...patch} : item,
  )
}

function handleClearProductUploads() {
  productImages.value = []
  productImageIds.value = []
  productMaterials.value = []
}

function handleClearSkuMaterials() {
  skuMaterials.value = []
}

function handleClearStyleReferences() {
  styleReferenceImages.value = []
  styleReferenceImageIds.value = []
}

function handleRemoveProductImage(index: number) {
  productImages.value = productImages.value.filter((_, imageIndex) => imageIndex !== index)
  productImageIds.value = productImageIds.value.filter((_, imageIndex) => imageIndex !== index)
}

function handleRemoveProductMaterial(id: string) {
  productMaterials.value = productMaterials.value.filter((item) => item.id !== id)
}

function handleRemoveSkuMaterial(id: string) {
  skuMaterials.value = skuMaterials.value.filter((item) => item.id !== id)
}

function handleRemoveStyleReferenceImage(index: number) {
  styleReferenceImages.value = styleReferenceImages.value.filter((_, imageIndex) => imageIndex !== index)
  styleReferenceImageIds.value = styleReferenceImageIds.value.filter((_, imageIndex) => imageIndex !== index)
}

function handleClearModelReferences() {
  modelReferenceImages.value = []
  modelReferenceImageIds.value = []
}

function handleRemoveModelReferenceImage(index: number) {
  modelReferenceImages.value = modelReferenceImages.value.filter((_, imageIndex) => imageIndex !== index)
  modelReferenceImageIds.value = modelReferenceImageIds.value.filter((_, imageIndex) => imageIndex !== index)
}

// 处理商品资料上传：图片进入参考图链路，文档类文件先暂存，点击生成方案时再转 Markdown。
async function handleSelectFiles(files: FileList | null) {
  if (!files?.length) return
  error.value = null
  const accepted: string[] = []
  const acceptedMaterials: ProductMaterialUpload[] = []
  const messages: string[] = []
  materialBusy.value = true
  try {
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_BYTES) {
          messages.push(`图片过大（>8MB）已忽略：${file.name}`)
          continue
        }
        try {
          accepted.push(await fileToCompressedDataURL(file))
        } catch (event) {
          console.warn("读取图片失败:", event)
          messages.push(`图片读取失败：${file.name}`)
        }
        continue
      }

      const kind = getProductMaterialKind(file)
      if (!kind) {
        messages.push(`已忽略不支持的商品资料：${file.name}`)
        continue
      }
      if (file.size > MAX_PRODUCT_MATERIAL_BYTES) {
        messages.push(`商品资料文件过大（>25MB）已忽略：${file.name}`)
        continue
      }
      if (productMaterials.value.length + acceptedMaterials.length >= MAX_PRODUCT_MATERIAL_FILES) {
        messages.push(`商品资料最多上传 ${MAX_PRODUCT_MATERIAL_FILES} 个文件，已忽略：${file.name}`)
        continue
      }
      acceptedMaterials.push(createPendingProductMaterial(file, kind))
    }
  } finally {
    materialBusy.value = false
  }
  if (accepted.length) productImages.value = [...productImages.value, ...accepted].slice(0, 8)
  if (acceptedMaterials.length) productMaterials.value = [...productMaterials.value, ...acceptedMaterials]
  if (messages.length) error.value = messages[messages.length - 1] ?? null
  if (fileInputRef.value) fileInputRef.value.value = ""
}

// SKU资料只接收可转 Markdown 的文件，不接收图片；图片事实来源仍放在商品素材里。
async function handleSelectSkuFiles(files: FileList | null) {
  if (!files?.length) return
  error.value = null
  const acceptedMaterials: ProductMaterialUpload[] = []
  const messages: string[] = []
  materialBusy.value = true
  try {
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        messages.push(`SKU资料不接收图片，已忽略：${file.name}`)
        continue
      }

      const kind = getProductMaterialKind(file)
      if (!kind) {
        messages.push(`已忽略不支持的 SKU资料：${file.name}`)
        continue
      }
      if (file.size > MAX_PRODUCT_MATERIAL_BYTES) {
        messages.push(`SKU资料文件过大（>25MB）已忽略：${file.name}`)
        continue
      }
      if (skuMaterials.value.length + acceptedMaterials.length >= MAX_PRODUCT_MATERIAL_FILES) {
        messages.push(`SKU资料最多上传 ${MAX_PRODUCT_MATERIAL_FILES} 个文件，已忽略：${file.name}`)
        continue
      }
      acceptedMaterials.push(createPendingProductMaterial(file, kind))
    }
  } finally {
    materialBusy.value = false
  }
  if (acceptedMaterials.length) skuMaterials.value = [...skuMaterials.value, ...acceptedMaterials]
  if (messages.length) error.value = messages[messages.length - 1] ?? null
  if (skuFileInputRef.value) skuFileInputRef.value.value = ""
}

async function handleSelectStyleReferenceFiles(files: FileList | null) {
  if (!files?.length) return
  error.value = null
  const accepted: string[] = []
  const messages: string[] = []
  materialBusy.value = true
  try {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        messages.push(`已忽略非图片风格参考：${file.name}`)
        continue
      }
      if (styleReferenceImages.value.length + accepted.length >= MAX_STYLE_REFERENCE_IMAGES) {
        messages.push(`风格参考最多上传 ${MAX_STYLE_REFERENCE_IMAGES} 张，已忽略：${file.name}`)
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        messages.push(`风格参考图过大（>8MB）已忽略：${file.name}`)
        continue
      }
      try {
        accepted.push(await fileToCompressedDataURL(file))
      } catch (event) {
        console.warn("读取风格参考图失败:", event)
        messages.push(`风格参考图读取失败：${file.name}`)
      }
    }
  } finally {
    materialBusy.value = false
  }
  if (accepted.length) {
    styleReferenceImages.value = [...styleReferenceImages.value, ...accepted].slice(0, MAX_STYLE_REFERENCE_IMAGES)
  }
  if (messages.length) error.value = messages[messages.length - 1] ?? null
  if (styleFileInputRef.value) styleFileInputRef.value.value = ""
}

async function handleSelectModelReferenceFiles(files: FileList | null) {
  if (!files?.length) return
  error.value = null
  const accepted: string[] = []
  const messages: string[] = []
  materialBusy.value = true
  try {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        messages.push(`已忽略非图片模特参考：${file.name}`)
        continue
      }
      if (modelReferenceImages.value.length + accepted.length >= MAX_MODEL_REFERENCE_IMAGES) {
        messages.push(`模特参考最多上传 ${MAX_MODEL_REFERENCE_IMAGES} 张，已忽略：${file.name}`)
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        messages.push(`模特参考图过大（>8MB）已忽略：${file.name}`)
        continue
      }
      try {
        accepted.push(await fileToCompressedDataURL(file))
      } catch (event) {
        console.warn("读取模特参考图失败:", event)
        messages.push(`模特参考图读取失败：${file.name}`)
      }
    }
  } finally {
    materialBusy.value = false
  }
  if (accepted.length) {
    modelReferenceImages.value = [...modelReferenceImages.value, ...accepted].slice(0, MAX_MODEL_REFERENCE_IMAGES)
  }
  if (messages.length) error.value = messages[messages.length - 1] ?? null
  if (modelFileInputRef.value) modelFileInputRef.value.value = ""
}

async function ensureModelReferenceImageIds() {
  const images = modelReferenceImages.value.slice(0, MAX_MODEL_REFERENCE_IMAGES)
  const nextIds = modelReferenceImageIds.value.slice(0, images.length)
  const missing = images.map((image, index) => ({image, index})).filter((item) => !nextIds[item.index])
  const dataUrls = await Promise.all(missing.map((item) => imageSrcToDataUrl(item.image)))
  const validDataUrls = dataUrls
      .filter((image) => image.startsWith("data:image/"))
      .filter((image) => image.length <= MAX_PROMPT_IMAGE_CHARS)
  const total = validDataUrls.reduce((sum, image) => sum + image.length, 0)
  if (missing.length && validDataUrls.length !== missing.length) {
    throw new Error("模特参考图过大或格式无效，请重新上传图片。")
  }
  if (total > MAX_PROMPT_IMAGE_TOTAL_CHARS) {
    throw new Error("模特参考图总大小过大，请减少图片数量或重新上传后再生成。")
  }
  const uploadedIds = await Promise.all(validDataUrls.map((image) => dbPutProductImage(image)))
  missing.forEach((item, index) => {
    nextIds[item.index] = uploadedIds[index] ?? ""
  })
  const ids = nextIds.filter(Boolean).slice(0, images.length)
  if (ids.length !== images.length) throw new Error("模特参考图保存失败，请重新上传后再试。")
  modelReferenceImageIds.value = ids
  return ids
}

async function ensureProductMaterialsConverted() {
  const pendingMaterials = productMaterials.value.filter((item) => item.status !== "converted")
  if (!pendingMaterials.length) return productMaterialsMarkdown.value

  materialBusy.value = true
  try {
    let totalMarkdownLength = convertedProductMaterials.value.reduce(
        (sum, item) => sum + item.markdown.length,
        0,
    )
    for (const material of pendingMaterials) {
      if (!material.file) {
        const message = `商品资料 ${material.name} 需要重新上传后才能转换。`
        updateProductMaterial(material.id, {status: "failed", error: message})
        throw new Error(message)
      }

      updateProductMaterial(material.id, {status: "converting", error: undefined})
      try {
        const converted = await convertProductMaterialFile(material.file)
        if (totalMarkdownLength + converted.markdown.length > MAX_PRODUCT_MATERIAL_TOTAL_CHARS) {
          throw new Error(`商品资料文本过长，请移除或缩短：${material.name}`)
        }
        totalMarkdownLength += converted.markdown.length
        updateProductMaterial(material.id, {
          file: undefined,
          markdown: converted.markdown,
          status: "converted",
          error: undefined,
        })
      } catch (event) {
        const message = event instanceof Error ? event.message : String(event)
        updateProductMaterial(material.id, {status: "failed", error: message})
        throw new Error(message)
      }
    }
  } finally {
    materialBusy.value = false
  }

  return productMaterialsMarkdown.value
}

async function ensureSkuMaterialsConverted() {
  const pendingMaterials = skuMaterials.value.filter((item) => item.status !== "converted")
  if (!pendingMaterials.length) return skuMaterialsMarkdown.value

  materialBusy.value = true
  try {
    let totalMarkdownLength = convertedSkuMaterials.value.reduce(
        (sum, item) => sum + item.markdown.length,
        0,
    )
    for (const material of pendingMaterials) {
      if (!material.file) {
        const message = `SKU资料 ${material.name} 需要重新上传后才能转换。`
        updateSkuMaterial(material.id, {status: "failed", error: message})
        throw new Error(message)
      }

      updateSkuMaterial(material.id, {status: "converting", error: undefined})
      try {
        const converted = await convertProductMaterialFile(material.file)
        if (totalMarkdownLength + converted.markdown.length > MAX_PRODUCT_MATERIAL_TOTAL_CHARS) {
          throw new Error(`SKU资料文本过长，请移除或缩短：${material.name}`)
        }
        totalMarkdownLength += converted.markdown.length
        updateSkuMaterial(material.id, {
          file: undefined,
          markdown: converted.markdown,
          status: "converted",
          error: undefined,
        })
      } catch (event) {
        const message = event instanceof Error ? event.message : String(event)
        updateSkuMaterial(material.id, {status: "failed", error: message})
        throw new Error(message)
      }
    }
  } finally {
    materialBusy.value = false
  }

  return skuMaterialsMarkdown.value
}

// 重置当前编辑中的商品资料和文案，不清空云端历史。
function handleResetProductInput() {
  if (promptBusy.value || imageBusy.value) return
  error.value = null
  productName.value = ""
  sellingPoints.value = ""
  skuInfo.value = ""
  imageModes.value = ["main", "detail"]
  targetPlatform.value = DEFAULT_TARGET_PLATFORM
  audience.value = ""
  priceBand.value = ""
  proofMaterials.value = ""
  offer.value = ""
  extraRequirements.value = ""
  productImages.value = []
  productImageIds.value = []
  styleReferenceImages.value = []
  styleReferenceImageIds.value = []
  modelReferenceImages.value = []
  modelReferenceImageIds.value = []
  productMaterials.value = []
  skuMaterials.value = []
  quality.value = "1K"
  prompts.value = []
  materialFeatures.value = []
  featureAssignments.value = []
  showFeatureRouting.value = false
  setActivePromptIndex(0)
  resetColumnPromptCursors([])
  activeHistoryIdx.value = -1
  if (fileInputRef.value) fileInputRef.value.value = ""
  if (skuFileInputRef.value) skuFileInputRef.value.value = ""
  if (styleFileInputRef.value) styleFileInputRef.value.value = ""
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
  if (imageModes.value.includes("sku") && !skuInfo.value.trim() && !skuMaterials.value.length) {
    error.value = "选中 SKU图 时，请填写 SKU信息，或上传包含 SKU 资料的文件。"
    return false
  }
  if (!productImages.value.length) {
    error.value = "请至少上传一张商品图片作为参考图。系统已禁止纯文案生成，以保证商品外观一致。"
    return false
  }
  return true
}

// 第一步：根据商品资料生成图包方案，不直接生成图片。
async function handleGeneratePrompts() {
  error.value = null
  if (!validateProduct()) return
  promptBusy.value = true
  try {
    const materialsMarkdown = await ensureProductMaterialsConverted()
    const skuMarkdown = await ensureSkuMaterialsConverted()
    const styleReferenceIds = await ensureStyleReferenceImageIds()
    const modelReferenceIds = await ensureModelReferenceImageIds()
    const result = await generateDetailPrompts({
      name: productName.value.trim(),
      sellingPoints: sellingPoints.value.trim(),
      skuInfo: skuInfo.value.trim(),
      imageModes: imageModes.value,
      targetPlatform: targetPlatformLabel.value,
      audience: audience.value.trim(),
      priceBand: priceBand.value.trim(),
      proofMaterials: proofMaterials.value.trim(),
      offer: offer.value.trim(),
      extraRequirements: extraRequirements.value.trim(),
      productImageIds: await ensureProductImageIds(),
      styleReferenceImageIds: styleReferenceIds,
      modelReferenceImageIds: modelReferenceIds,
      productMaterialsMarkdown: materialsMarkdown,
      skuMaterialsMarkdown: skuMarkdown,
    })
    prompts.value = result.prompts.map((item, index) =>
        createPromptItem(index, item.title, item.promptId, item.prompt, item.imageMode),
    )
    // 智能素材路由：存储特征数据
    materialFeatures.value = result.materialFeatures ?? []
    featureAssignments.value = result.featureAssignments ?? []
    if (materialFeatures.value.length) {
      showFeatureRouting.value = true
    }
    setActivePromptIndex(0)
    resetColumnPromptCursors()
  } catch (event) {
    error.value = event instanceof Error ? event.message : String(event)
    materialFeatures.value = []
    featureAssignments.value = []
  } finally {
    promptBusy.value = false
  }
}

function handleTitleChange(id: string, value: string) {
  prompts.value = prompts.value.map((item) => (item.id === id ? {...item, title: value} : item))
}

function handlePromptChange(id: string, value: string) {
  prompts.value = prompts.value.map((item) => (item.id === id ? {...item, prompt: value} : item))
}

function isImageModeSelected(mode: DetailImageMode) {
  return imageModes.value.includes(mode)
}

function handleImageModeToggle(mode: DetailImageMode) {
  if (promptBusy.value || imageBusy.value) return
  const selected = isImageModeSelected(mode)
  if (selected && imageModes.value.length <= 1) return
  imageModes.value = selected
      ? imageModes.value.filter((item) => item !== mode)
      : IMAGE_MODE_ORDER.filter((item) => item === mode || imageModes.value.includes(item))
}

function isTargetPlatformSelected(platform: TargetPlatformValue) {
  return targetPlatformLabel.value === platform
}

function handleTargetPlatformSelect(platform: TargetPlatformValue) {
  if (controlsDisabled.value) return
  targetPlatform.value = platform
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
    error.value = "请先生成图包方案。"
    return
  }
  if (prompts.value.some((item) => !item.promptId)) {
    error.value = "图包方案缺少后端引用，请重新生成图包方案。"
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
      quality: quality.value,
    },
  }

  try {
    const generationImageIds = await ensureProductImageIds()
    historyItem = {...historyItem, product: cloneProduct(currentProduct.value)}
    await requestWakeLock()
    await persistHistory(historyItem)
    history.value = [...history.value, historyItem]
    activeHistoryIdx.value = history.value.length - 1

    // 每张图独立创建任务，方便失败时知道是哪一张出问题，也支持逐张保存历史。
    let working = historyItem.prompts
    for (let index = 0; index < working.length; index += 1) {
      if (imageCancelRequestedRef.value) throw new ImageGenerationCancelledError()
      setActivePromptIndex(index)
      working = working.map((item, itemIndex) =>
          itemIndex === index
              ? {...item, status: "queued", error: undefined, updatedAt: Date.now()}
              : item,
      )
      historyItem = {...historyItem, prompts: working}
      prompts.value = working
      await persistHistory(historyItem)

      const task = await createImageTask(
          {
            promptId: working[index]?.promptId ?? "",
            prompt: working[index]?.prompt,
            size: getPromptSize(working[index]),
            aspectRatio: getPromptAspectRatio(working[index]),
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
              ? {...item, status: "running", taskId: task.taskId, updatedAt: Date.now()}
              : item,
      )
      historyItem = {...historyItem, prompts: working}
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
                ? {...item, status: "failed", error: message, updatedAt: Date.now()}
                : item,
        )
        historyItem = {...historyItem, prompts: working}
        prompts.value = working
        await persistHistory(historyItem)
        throw new Error(message)
      }
      updateSessionCredits(result)
      if (!result.imageId) {
        throw new Error(`${working[index]?.title ?? `第${index + 1}张商品图`}未返回图片 ID`)
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
      historyItem = {...historyItem, prompts: working}
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
      historyItem = {...historyItem, prompts: resetActiveGenerationPrompts(historyItem.prompts)}
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

// 只重新生成当前选中的一张商品图，其余已完成图片保持不变。
async function handleRegenerateActiveImage() {
  error.value = null
  if (!validateProduct()) return
  if (!prompts.value.length) {
    error.value = "请先生成图包方案。"
    return
  }
  const targetIndex = Math.min(Math.max(activePromptIdx.value, 0), prompts.value.length - 1)
  const target = prompts.value[targetIndex]
  if (!target?.promptId) {
    error.value = "当前图包方案缺少后端引用，请重新生成图包方案。"
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
          quality: quality.value,
        },
      }
      : {
        product: cloneProduct(currentProduct.value),
        prompts: prompts.value.map(resetInterruptedPrompt),
        timestamp: Date.now(),
        generation: {
          quality: quality.value,
        },
      }

  try {
    const generationImageIds = await ensureProductImageIds()
    historyItem = {...historyItem, product: cloneProduct(currentProduct.value)}
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
    historyItem = {...historyItem, prompts: working}
    prompts.value = working
    await persistHistory(historyItem)

    const task = await createImageTask(
        {
          promptId: working[targetIndex]?.promptId ?? "",
          prompt: working[targetIndex]?.prompt,
          size: getPromptSize(working[targetIndex]),
          aspectRatio: getPromptAspectRatio(working[targetIndex]),
          quality: quality.value,
          inputImageIds: generationImageIds,
        },
        imageAbortRef.value?.signal,
    )
    currentImageTaskIdRef.value = task.taskId
    updateSessionCredits(task)

    working = working.map((item, itemIndex): DetailPromptItem =>
        itemIndex === targetIndex
            ? {...item, status: "running" as const, taskId: task.taskId, updatedAt: Date.now()}
            : item,
    )
    historyItem = {...historyItem, prompts: working}
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
              ? {...item, status: "failed" as const, error: message, updatedAt: Date.now()}
              : item,
      )
      historyItem = {...historyItem, prompts: working}
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
    historyItem = {...historyItem, prompts: working}
    prompts.value = working
    currentImageTaskIdRef.value = null
    history.value = history.value.map((item) => (item.id === historyItem.id ? historyItem : item))
    await persistHistory(historyItem)
  } catch (event) {
    if (
        event instanceof ImageGenerationCancelledError ||
        (event instanceof DOMException && event.name === "AbortError")
    ) {
      historyItem = {...historyItem, prompts: resetActiveGenerationPrompts(historyItem.prompts)}
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

async function handleRegeneratePromptAt(index: number) {
  setActivePromptIndex(index)
  await handleRegenerateActiveImage()
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
  suppressImageModeReset.value = true
  productName.value = item.product.name
  sellingPoints.value = item.product.sellingPoints
  skuInfo.value = item.product.skuInfo || ""
  const restoredModes = normalizeImageModes(item.product.imageModes)
  imageModes.value = restoredModes
  targetPlatform.value = normalizeTargetPlatform(item.product.targetPlatform || targetPlatform.value)
  audience.value = item.product.audience || ""
  priceBand.value = item.product.priceBand || ""
  proofMaterials.value = item.product.proofMaterials || ""
  offer.value = item.product.offer || ""
  extraRequirements.value = item.product.extraRequirements || ""
  productImageIds.value = item.product.productImageIds ?? []
  productImages.value = item.product.productImages
  productMaterials.value = restoreProductMaterials(item.product.productMaterials)
  skuMaterials.value = restoreProductMaterials(item.product.skuMaterials)
  if (item.product.productImageIds?.length) {
    dbGetProductImages(item.product.productImageIds)
        .then((images) => {
          productImages.value = images.slice(0, 8)
        })
        .catch((event) => console.warn("商品参考图恢复失败:", event))
  }
  styleReferenceImageIds.value = item.product.styleReferenceImageIds ?? []
  styleReferenceImages.value = item.product.styleReferenceImages ?? []
  if (item.product.styleReferenceImageIds?.length) {
    dbGetProductImages(item.product.styleReferenceImageIds)
        .then((images) => {
          styleReferenceImages.value = images.slice(0, MAX_STYLE_REFERENCE_IMAGES)
        })
        .catch((event) => console.warn("风格参考图恢复失败:", event))
  }
  modelReferenceImageIds.value = item.product.modelReferenceImageIds ?? []
  modelReferenceImages.value = item.product.modelReferenceImages ?? []
  if (item.product.modelReferenceImageIds?.length) {
    dbGetProductImages(item.product.modelReferenceImageIds)
        .then((images) => {
          modelReferenceImages.value = images.slice(0, MAX_MODEL_REFERENCE_IMAGES)
        })
        .catch((event) => console.warn("模特参考图恢复失败:", event))
  }
  prompts.value = item.prompts.map((prompt) => resetInterruptedPrompt(prompt))
  // 智能素材路由：恢复特征数据
  if (Array.isArray(item.materialFeatures) && item.materialFeatures.length) {
    materialFeatures.value = item.materialFeatures
    showFeatureRouting.value = true
  } else {
    materialFeatures.value = []
    showFeatureRouting.value = false
  }
  if (Array.isArray(item.featureAssignments) && item.featureAssignments.length) {
    featureAssignments.value = item.featureAssignments
  } else {
    featureAssignments.value = []
  }
  if (item.generation?.quality && IMAGE_QUALITY_VALUES.includes(item.generation.quality)) {
    quality.value = item.generation.quality
  }
  setActivePromptIndex(0)
  resetColumnPromptCursors()
  window.setTimeout(() => {
    suppressImageModeReset.value = false
  }, 0)
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
  if (!confirm("确定清空所有商品图历史？此操作不可撤销。")) return
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
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code}),
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
  const packType = getPromptImageMode(prompts.value[index])
  anchor.download = `ecom-${packType}-${productName.value || "product"}-${index + 1}.png`
  anchor.click()
}

async function handleDownloadAll() {
  const images = allGeneratedImages.value
  if (!images.length) return
  if (images.length === 1) {
    handleDownload(prompts.value.indexOf(images[0]))
    return
  }
  const JSZip = (await import("jszip")).default
  const zip = new JSZip()
  const promises = images.map(async (image, i) => {
    const resp = await fetch(image.src)
    const blob = await resp.blob()
    const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg"
    zip.file(`${image.modeLabel}-${i + 1}-${productName.value || "product"}.${ext}`, blob)
  })
  await Promise.all(promises)
  const zipBlob = await zip.generateAsync({ type: "blob" })
  const url = URL.createObjectURL(zipBlob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `ecom-全部图片-${productName.value || "product"}.zip`
  anchor.click()
  URL.revokeObjectURL(url)
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

watch(() => imageModes.value.join(","), () => {
  if (!draftLoaded.value) return
  if (suppressImageModeReset.value) return
  if (promptBusy.value || imageBusy.value) return
  prompts.value = []
  setActivePromptIndex(0)
  resetColumnPromptCursors([])
  activeHistoryIdx.value = -1
})

// 展开营销设置时自动滚动到可见区域
watch(secondaryProductDetailsOpen, (open) => {
  if (open) {
    setTimeout(() => marketingCardRef.value?.scrollIntoView({ behavior: "smooth", block: "start" }), 100)
  }
})

// 自动保存草稿到 localStorage。这里 deep: true 是为了监听 prompts 数组内部变化。
watch(
    [
      draftLoaded,
      productName,
      sellingPoints,
      skuInfo,
      imageModes,
      targetPlatform,
      audience,
      priceBand,
      proofMaterials,
      offer,
      extraRequirements,
      prompts,
      quality,
      productImageIds,
      styleReferenceImageIds,
      productMaterials,
      skuMaterials,
    ],
    () => {
      if (!draftLoaded.value || studioMode.value !== "image" || !import.meta.client) return
      try {
        const draft: DraftState = {
          productName: productName.value,
          sellingPoints: sellingPoints.value,
          skuInfo: skuInfo.value,
          imageModes: [...imageModes.value],
          targetPlatform: targetPlatformLabel.value,
          audience: audience.value,
          priceBand: priceBand.value,
          proofMaterials: proofMaterials.value,
          offer: offer.value,
          extraRequirements: extraRequirements.value,
          prompts: prompts.value,
          quality: quality.value,
          productImageIds: productImageIds.value,
          styleReferenceImageIds: styleReferenceImageIds.value,
          modelReferenceImageIds: modelReferenceImageIds.value,
          productMaterials: convertedProductMaterials.value,
          skuMaterials: convertedSkuMaterials.value,
          materialFeatures: materialFeatures.value.length ? materialFeatures.value : undefined,
          featureAssignments: featureAssignments.value.length ? featureAssignments.value : undefined,
        }
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      } catch {
        // Ignore storage failures.
      }
    },
    {deep: true},
)

// 页面初始化：恢复草稿、加载历史、读取登录态。
onMounted(() => {
  studioMode.value = readStudioModeFromUrl()
  window.addEventListener("popstate", handleLocationChange)
  window.addEventListener("hashchange", handleLocationChange)

  if (studioMode.value === "image") {
    let shouldReleaseImageModeReset = false
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const draft = JSON.parse(raw) as DraftState
        suppressImageModeReset.value = true
        shouldReleaseImageModeReset = true
        productName.value = draft.productName || ""
        sellingPoints.value = draft.sellingPoints || ""
        skuInfo.value = draft.skuInfo || ""
        const restoredModes = normalizeImageModes(draft.imageModes)
        imageModes.value = restoredModes
        targetPlatform.value = normalizeTargetPlatform(draft.targetPlatform || targetPlatform.value)
        audience.value = draft.audience || ""
        priceBand.value = draft.priceBand || ""
        proofMaterials.value = draft.proofMaterials || ""
        offer.value = draft.offer || ""
        extraRequirements.value = draft.extraRequirements || ""
        productMaterials.value = restoreProductMaterials(
            Array.isArray(draft.productMaterials) ? draft.productMaterials : undefined,
        )
        skuMaterials.value = restoreProductMaterials(
            Array.isArray(draft.skuMaterials) ? draft.skuMaterials : undefined,
        )
        prompts.value = Array.isArray(draft.prompts)
            ? draft.prompts.map((prompt) => resetInterruptedPrompt(prompt))
            : []
        setActivePromptIndex(0)
        resetColumnPromptCursors()
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
        if (Array.isArray(draft.styleReferenceImageIds) && draft.styleReferenceImageIds.length) {
          styleReferenceImageIds.value = draft.styleReferenceImageIds
          dbGetProductImages(draft.styleReferenceImageIds)
              .then((images) => {
                styleReferenceImages.value = images.slice(0, MAX_STYLE_REFERENCE_IMAGES)
              })
              .catch((event) => console.warn("风格参考图恢复失败:", event))
        }
        if (Array.isArray(draft.modelReferenceImageIds) && draft.modelReferenceImageIds.length) {
          modelReferenceImageIds.value = draft.modelReferenceImageIds
          dbGetProductImages(draft.modelReferenceImageIds)
              .then((images) => {
                modelReferenceImages.value = images.slice(0, MAX_MODEL_REFERENCE_IMAGES)
              })
              .catch((event) => console.warn("模特参考图恢复失败:", event))
        }
        // 智能素材路由：恢复特征数据
        if (Array.isArray(draft.materialFeatures) && draft.materialFeatures.length) {
          materialFeatures.value = draft.materialFeatures
          showFeatureRouting.value = true
        }
        if (Array.isArray(draft.featureAssignments) && draft.featureAssignments.length) {
          featureAssignments.value = draft.featureAssignments
        }
      }
    } catch {
      // Ignore invalid local draft.
    } finally {
      draftLoaded.value = true
      if (shouldReleaseImageModeReset) {
        window.setTimeout(() => {
          suppressImageModeReset.value = false
        }, 0)
      }
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
      session.value = {authenticated: false, user: null}
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
          <Icon name="brand"/>
        </span>
        <div>
          <h1>EcomImgGen</h1>
          <p class="tagline">Image Studio</p>
        </div>
      </div>

      <nav class="creative-tabs" aria-label="创作类型">
        <NuxtLink to="/" class="creative-tab" @click="handleHomeLinkClick">
          <Icon name="brand"/>
          <span>首页</span>
        </NuxtLink>
        <NuxtLink
            to="/image/"
            :class="['creative-tab', { 'is-active': studioMode === 'image' }]"
            :aria-current="studioMode === 'image' ? 'page' : undefined"
            @click="event => handleModuleLinkClick(event, 'image')"
        >
          <Icon name="spark"/>
          <span>生图</span>
        </NuxtLink>
        <NuxtLink
            to="/cutout/"
            :class="['creative-tab', { 'is-active': studioMode === 'cutout' }]"
            :aria-current="studioMode === 'cutout' ? 'page' : undefined"
            @click="event => handleModuleLinkClick(event, 'cutout')"
        >
          <Icon name="cutout"/>
          <span>抠图</span>
        </NuxtLink>
        <NuxtLink
            to="/edit/"
            :class="['creative-tab', { 'is-active': studioMode === 'edit' }]"
            :aria-current="studioMode === 'edit' ? 'page' : undefined"
            @click="event => handleModuleLinkClick(event, 'edit')"
        >
          <Icon name="brush"/>
          <span>改图</span>
        </NuxtLink>
        <NuxtLink
            to="/layer/"
            :class="['creative-tab', { 'is-active': studioMode === 'layer' }]"
            :aria-current="studioMode === 'layer' ? 'page' : undefined"
            @click="event => handleModuleLinkClick(event, 'layer')"
        >
          <Icon name="text"/>
          <span>拆图</span>
        </NuxtLink>
        <NuxtLink
            to="/multi-view/"
            :class="['creative-tab', { 'is-active': studioMode === 'multi-view' }]"
            :aria-current="studioMode === 'multi-view' ? 'page' : undefined"
            @click="event => handleModuleLinkClick(event, 'multi-view')"
        >
          <Icon name="queue"/>
          <span>多视角</span>
        </NuxtLink>
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
            <Icon v-else name="user" class="auth-toggle-icon"/>
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
              <p class="auth-popover-note">登录后才能生成主图/详情图方案和商品图。</p>
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
        <span>{{ productUploadStatusLabel }}</span>
        <span>{{ creditLabel }}</span>
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
            <!-- 基础信息 -->
            <section class="input-card">
              <div class="input-card-head">
                <h3>基础信息</h3>
              </div>
              <div class="input-card-body">
                <div class="form-field">
                  <label for="product-name"><span class="card-badge must">必填</span> 商品名称</label>
                  <input
                      id="product-name"
                      v-model="productName"
                      type="text"
                      :disabled="controlsDisabled"
                      placeholder="示例：玻尿酸修护精华液 | 真皮沙发双人座 | 儿童智能手表"
                  >
                </div>

                <div class="form-field">
                  <label for="selling-points"><span class="card-badge must">必填</span> 核心卖点/功效</label>
                  <textarea
                      id="selling-points"
                      v-model="sellingPoints"
                      class="selling-points"
                      :disabled="controlsDisabled"
                      placeholder="请输入商品核心卖点、适用人群、规格信息和购买理由。&#10;&#10;示例：&#10;• 深层补水：玻尿酸微分子渗透技术&#10;• 修护屏障：神经酰胺+角鲨烷双重修护&#10;• 适合人群：敏感肌、干燥肌、熟龄肌&#10;• 规格：30ml 旅行装 / 50ml 标准装&#10;• 使用感：清爽不油腻，快速吸收"
                  />
                </div>

                <div class="form-field">
                  <label for="extra-requirements"><span class="card-badge optional">可选</span> 补充要求</label>
                  <textarea
                      id="extra-requirements"
                      v-model="extraRequirements"
                      class="compact-textarea"
                      :disabled="controlsDisabled"
                      placeholder="示例：整体更高级、少文字、突出礼盒感、避免真人出镜、主色更接近品牌蓝"
                  />
                </div>
              </div>
            </section>

            <!-- 商品素材 -->
            <section class="input-card">
              <div class="input-card-head">
                <span class="card-badge must">必填</span>
                <h3>商品素材</h3>
                <button
                    v-if="hasProductUploads"
                    type="button"
                    class="inline-action"
                    :disabled="controlsDisabled"
                    @click="handleClearProductUploads"
                >
                  清空
                </button>
              </div>
              <div class="input-card-body">
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
                        @click="handleRemoveProductImage(index)"
                    >
                      <Icon name="close"/>
                    </button>
                  </div>
                  <button
                      type="button"
                      class="prompt-upload-tile"
                      :disabled="controlsDisabled"
                      @click="fileInputRef?.click()"
                  >
                    <Icon name="upload"/>
                    <span>{{ materialBusy ? "转换中" : "上传" }}</span>
                  </button>
                </div>
                <details class="material-file-fold">
                  <summary class="material-file-summary">
                    <span>资料文件</span>
                    <span>{{ productMaterials.length ? `${productMaterials.length} 份` : "可选" }}</span>
                  </summary>
                  <div v-if="productMaterials.length" class="material-file-list">
                    <div
                        v-for="material in productMaterials"
                        :key="material.id"
                        :class="['product-material-chip', `is-${material.status}`]"
                        :title="getProductMaterialTitle(material)"
                    >
                      <span class="product-material-type">{{ getProductMaterialKindLabel(material.kind) }}</span>
                      <strong>{{ material.name }}</strong>
                      <button
                          type="button"
                          class="product-material-del"
                          :disabled="controlsDisabled"
                          :aria-label="`移除商品资料 ${material.name}`"
                          @click="handleRemoveProductMaterial(material.id)"
                      >
                        <Icon name="close"/>
                      </button>
                    </div>
                  </div>
                  <p v-else class="material-file-empty">上传 PDF、Word、Excel 等资料后会显示在这里。</p>
                </details>
                <!-- 智能素材路由：特征面板 -->
                <details v-if="materialFeatures.length" class="material-file-fold feature-routing-fold" :open="showFeatureRouting">
                  <summary class="material-file-summary">
                    <span>素材特征路由</span>
                    <span>{{ materialFeatures.length }} 个特征</span>
                  </summary>
                  <div class="feature-routing-list">
                    <div
                        v-for="feature in materialFeatures"
                        :key="feature.id"
                        class="feature-chip"
                        :title="`${feature.description}\n来源：${feature.sourceFile}`"
                    >
                      <span class="feature-category">{{ feature.category }}</span>
                      <strong>{{ feature.label }}</strong>
                      <span class="feature-relevance">{{ feature.relevance }}</span>
                    </div>
                  </div>
                </details>
                <p class="field-help">支持图片、PDF、PPTX、DOCX、Excel、HTML、CSV、JSON、XML；非图片资料会先转换为 Markdown 后参与方案生成。</p>
                <input
                    id="product-images"
                    ref="fileInputRef"
                    name="productImages"
                    type="file"
                    aria-label="上传商品素材"
                    :accept="PRODUCT_MATERIAL_ACCEPT"
                    multiple
                    hidden
                    @change="event => handleSelectFiles((event.target as HTMLInputElement).files)"
                >
              </div>
            </section>

            <!-- 风格参考 -->
            <section class="input-card">
              <div class="input-card-head">
                <span class="card-badge optional">可选</span>
                <h3>风格参考</h3>
                <button
                    v-if="styleReferenceImages.length > 0"
                    type="button"
                    class="inline-action"
                    :disabled="controlsDisabled"
                    @click="handleClearStyleReferences"
                >
                  清空
                </button>
              </div>
              <div class="input-card-body">
                <div class="product-media style-reference-media">
                  <div
                      v-for="(src, index) in styleReferenceImages"
                      :key="`${src.slice(0, 32)}-${index}`"
                      class="prompt-thumb"
                  >
                    <button
                        type="button"
                        class="prompt-thumb-preview"
                        :aria-label="`查看风格参考 ${index + 1}`"
                        @click="lightboxSrc = src"
                    >
                      <img :src="src" :alt="`风格参考 ${index + 1}`">
                    </button>
                    <button
                        type="button"
                        class="prompt-thumb-del"
                        :disabled="controlsDisabled"
                        :aria-label="`移除风格参考 ${index + 1}`"
                        @click="handleRemoveStyleReferenceImage(index)"
                    >
                      <Icon name="close"/>
                    </button>
                  </div>
                  <button
                      type="button"
                      class="prompt-upload-tile"
                      :disabled="controlsDisabled || styleReferenceImages.length >= MAX_STYLE_REFERENCE_IMAGES"
                      @click="styleFileInputRef?.click()"
                  >
                    <Icon name="upload"/>
                    <span>上传</span>
                  </button>
                </div>
                <p class="field-help">风格参考只用于学习构图、光影、配色和排版气质，不作为商品外观事实来源。</p>
                <input
                    id="style-reference-images"
                    ref="styleFileInputRef"
                    name="styleReferenceImages"
                    type="file"
                    aria-label="上传风格参考图"
                    accept="image/*"
                    multiple
                    hidden
                    @change="event => handleSelectStyleReferenceFiles((event.target as HTMLInputElement).files)"
                >
              </div>
            </section>

            <!-- 模特参考 -->
            <section class="input-card">
              <div class="input-card-head">
                <span class="card-badge optional">可选</span>
                <h3>模特参考</h3>
                <button
                    v-if="modelReferenceImages.length > 0"
                    type="button"
                    class="inline-action"
                    :disabled="controlsDisabled"
                    @click="handleClearModelReferences"
                >
                  清空
                </button>
              </div>
              <div class="input-card-body">
                <div class="product-media model-reference-media">
                  <div
                      v-for="(src, index) in modelReferenceImages"
                      :key="`${src.slice(0, 32)}-${index}`"
                      class="prompt-thumb"
                  >
                    <button
                        type="button"
                        class="prompt-thumb-preview"
                        :aria-label="`查看模特参考 ${index + 1}`"
                        @click="lightboxSrc = src"
                    >
                      <img :src="src" :alt="`模特参考 ${index + 1}`">
                    </button>
                    <button
                        type="button"
                        class="prompt-thumb-del"
                        :disabled="controlsDisabled"
                        :aria-label="`移除模特参考 ${index + 1}`"
                        @click="handleRemoveModelReferenceImage(index)"
                    >
                      <Icon name="close"/>
                    </button>
                  </div>
                  <button
                      type="button"
                      class="prompt-upload-tile"
                      :disabled="controlsDisabled || modelReferenceImages.length >= MAX_MODEL_REFERENCE_IMAGES"
                      @click="modelFileInputRef?.click()"
                  >
                    <Icon name="upload"/>
                    <span>上传</span>
                  </button>
                </div>
                <p class="field-help">模特参考图用于固定出图中人物模特的容貌和形象气质，最多 2 张。</p>
                <input
                    id="model-reference-images"
                    ref="modelFileInputRef"
                    name="modelReferenceImages"
                    type="file"
                    aria-label="上传模特参考图"
                    accept="image/*"
                    multiple
                    hidden
                    @change="event => handleSelectModelReferenceFiles((event.target as HTMLInputElement).files)"
                >
              </div>
            </section>

            <!-- 图包配置 -->
            <section class="input-card">
              <div class="input-card-body">
                <div class="setting-block">
                  <div class="setting-head">
                    <label>图包类型</label>
                    <span class="field-hint">{{ imageCountLabel }}</span>
                  </div>
                  <div class="image-mode-toggle-group" role="group" aria-label="图包类型">
                    <button
                        v-for="option in IMAGE_MODE_OPTIONS"
                        :key="option.value"
                        type="button"
                        :class="['image-mode-toggle', { 'is-active': isImageModeSelected(option.value) }]"
                        :aria-pressed="isImageModeSelected(option.value)"
                        :disabled="controlsDisabled || (isImageModeSelected(option.value) && imageModes.length <= 1)"
                        @click="handleImageModeToggle(option.value)"
                    >
                      <span>{{ option.label }}</span>
                      <small>{{ getImageModeCountLabel(option.value) }} · {{
                          getImageModeAspectRatio(option.value)
                      }}</small>
                    </button>
                  </div>
                </div>

                <Transition name="collapse">
                  <div v-if="isImageModeSelected('sku')" class="sku-inline-panel">
                    <div class="form-field">
                      <label for="sku-info">SKU信息 <span class="field-hint">(二选一)</span></label>
                      <textarea
                          id="sku-info"
                          v-model="skuInfo"
                          class="compact-textarea"
                          :disabled="controlsDisabled"
                          placeholder="示例：白色/S/M/L；黑色/S/M/L；单瓶装/三瓶装；A款基础版、B款升级版。"
                      />
                    </div>

                    <div class="form-field">
                      <div class="field-row-head">
                        <label for="sku-materials">SKU资料 <span class="field-hint">(二选一)</span></label>
                        <button
                            v-if="skuMaterials.length"
                            type="button"
                            class="inline-action"
                            :disabled="controlsDisabled"
                            @click="handleClearSkuMaterials"
                        >
                          清空
                        </button>
                      </div>
                      <div class="product-media sku-material-media">
                        <div
                            v-for="material in skuMaterials"
                            :key="material.id"
                            :class="['product-material-chip', `is-${material.status}`]"
                            :title="getProductMaterialTitle(material)"
                        >
                          <span class="product-material-type">{{ getProductMaterialKindLabel(material.kind) }}</span>
                          <strong>{{ material.name }}</strong>
                          <button
                              type="button"
                              class="product-material-del"
                              :disabled="controlsDisabled"
                              :aria-label="`移除 SKU资料 ${material.name}`"
                              @click="handleRemoveSkuMaterial(material.id)"
                          >
                            <Icon name="close"/>
                          </button>
                        </div>
                        <button
                            type="button"
                            class="prompt-upload-tile"
                            :disabled="controlsDisabled"
                            @click="skuFileInputRef?.click()"
                        >
                          <Icon name="upload"/>
                          <span>{{ materialBusy ? "转换中" : "上传" }}</span>
                        </button>
                      </div>
                      <p class="field-help">SKU资料会转 Markdown，用于动态识别 SKU 图数量。</p>
                      <input
                          id="sku-materials"
                          ref="skuFileInputRef"
                          name="skuMaterials"
                          type="file"
                          aria-label="上传 SKU 资料"
                          :accept="PRODUCT_MATERIAL_ACCEPT"
                          multiple
                          hidden
                          @change="event => handleSelectSkuFiles((event.target as HTMLInputElement).files)"
                      >
                    </div>
                  </div>
                </Transition>

                <div class="setting-block">
                  <div class="setting-head">
                    <label>比例/清晰度</label>
                    <span>按图包自动 · {{ quality }}</span>
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
            </section>

            <!-- 营销设置 -->
            <section ref="marketingCardRef" class="input-card">
              <div class="input-card-head">
                <span class="card-badge optional">可选</span>
                <h3>营销设置</h3>
                <button
                    type="button"
                    class="inline-action"
                    :aria-expanded="secondaryProductDetailsOpen"
                    @click="secondaryProductDetailsOpen = !secondaryProductDetailsOpen"
                >
                  <span class="field-hint">{{ secondaryProductInfoLabel }}</span>
                  {{ secondaryProductDetailsOpen ? "收起" : "展开" }}
                </button>
              </div>
              <Transition name="collapse">
                <div v-show="secondaryProductDetailsOpen" class="input-card-body">
                  <div class="form-field">
                    <div class="field-row-head">
                      <label>目标平台</label>
                    </div>
                    <div class="platform-toggle-group" role="radiogroup" aria-label="目标平台">
                      <button
                          v-for="option in PLATFORM_OPTIONS"
                          :key="option.value"
                          type="button"
                          role="radio"
                          :class="['platform-toggle', { 'is-active': isTargetPlatformSelected(option.value) }]"
                          :aria-checked="isTargetPlatformSelected(option.value)"
                          :disabled="controlsDisabled"
                          @click="handleTargetPlatformSelect(option.value)"
                      >
                        <span>{{ option.label }}</span>
                        <small>{{ option.description }}</small>
                      </button>
                    </div>
                  </div>

                  <div class="form-field">
                    <label for="price-band">价格带</label>
                    <input
                        id="price-band"
                        v-model="priceBand"
                        type="text"
                        :disabled="controlsDisabled"
                        placeholder="示例：平价走量 | 中高客单 | 高端礼品"
                    >
                  </div>

                  <div class="form-field">
                    <label for="audience">目标人群/购买场景</label>
                    <textarea
                        id="audience"
                        v-model="audience"
                        class="compact-textarea"
                        :disabled="controlsDisabled"
                        placeholder="示例：宝妈囤货、租房收纳、通勤办公、换季敏感肌、送礼场景"
                    />
                  </div>

                  <div class="form-field">
                    <label for="proof-materials">证明素材/资质/评价</label>
                    <textarea
                        id="proof-materials"
                        v-model="proofMaterials"
                        class="compact-textarea"
                        :disabled="controlsDisabled"
                        placeholder="示例：检测报告、材质认证、用户好评关键词、真实参数。没有可留空，系统不会编造硬证据。"
                    />
                  </div>

                  <div class="form-field">
                    <label for="offer">活动/售后/服务承诺</label>
                    <textarea
                        id="offer"
                        v-model="offer"
                        class="compact-textarea"
                        :disabled="controlsDisabled"
                        placeholder="示例：买一送一、7天无理由、赠品、包邮、质保、试用装"
                    />
                  </div>
                </div>
              </Transition>
            </section>
          </div>

          <div class="input-action-bar">
            <button type="button" class="btn-primary" :disabled="controlsDisabled" @click="handleGeneratePrompts">
              <span v-if="promptBusy" class="btn-spinner" aria-hidden="true"/>
              {{ promptBusy ? "AI 生成方案中..." : "生成图包方案" }}
            </button>
            <div v-if="error" class="alert">{{ error }}</div>
          </div>
        </aside>

        <section class="studio-panel pack-workspace">
          <div class="pack-workspace-head">
            <div>
              <h2>图包工作区</h2>
              <span>{{ generationLabel }}</span>
            </div>
            <div class="pack-workspace-actions">
              <button
                  type="button"
                  class="btn-secondary"
                  :disabled="controlsDisabled || !prompts.length"
                  @click="handleGenerateImages"
              >
                <span v-if="imageBusy" class="btn-spinner" aria-hidden="true"/>
                {{ imageBusy ? `生成中 ${activePromptIndex + 1}/${prompts.length}` : "批量生成商品图" }}
              </button>
              <button
                  type="button"
                  class="btn-ghost"
                  :disabled="!allGeneratedCount"
                  @click="galleryOpen = true"
              >
                查看所有图片{{ allGeneratedCount ? ` (${allGeneratedCount})` : "" }}
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

          <div class="pack-column-grid">
            <article
                v-for="column in packColumns"
                :key="column.mode"
                :class="['pack-column', `is-${column.mode}`]"
            >
              <header class="pack-column-head">
                <div>
                  <h3>{{ column.label }}</h3>
                  <small>{{ column.countLabel }} · {{ column.aspectRatio }}</small>
                </div>
                <span>{{ getColumnStatusText(column) }}</span>
              </header>

              <div v-if="promptBusy" class="pack-column-empty">
                <span class="busy-orbit" aria-hidden="true"/>
                <strong>正在生成方案</strong>
                <p>AI 正在规划 {{ column.label }} 的 prompt。</p>
              </div>
              <div v-else-if="!column.items.length" class="pack-column-empty">
                <Icon name="spark"/>
                <strong>暂无{{ column.label }}方案</strong>
                <p>填写商品资料后点击左侧“生成图包方案”。</p>
              </div>
              <div v-else-if="column.activeEntry" class="pack-card-list">
                <article
                    :key="column.activeEntry.item.id"
                    :class="['pack-card', { 'is-active': column.activeEntry.index === activePromptIndex }]"
                >
                  <div class="pack-card-head">
                    <button
                        type="button"
                        class="pack-step-btn"
                        :disabled="column.items.length <= 1"
                        :aria-label="`查看上一张${column.label}`"
                        title="上一张"
                        @click="handleStepColumnPrompt(column, -1)"
                    >
                      ‹
                    </button>
                    <input
                        type="text"
                        :aria-label="`${column.label}方案标题`"
                        :value="column.activeEntry.item.title"
                        :disabled="imageBusy"
                        @input="event => handleTitleChange(column.activeEntry!.item.id, (event.target as HTMLInputElement).value)"
                    >
                    <span :class="['status-pill', `is-${column.activeEntry.item.status}`]">
                      {{ STATUS_LABEL[column.activeEntry.item.status] }}
                    </span>
                    <span class="pack-step-count">{{ column.activePosition + 1 }}/{{ column.items.length }}</span>
                    <button
                        type="button"
                        class="pack-step-btn"
                        :disabled="column.items.length <= 1"
                        :aria-label="`查看下一张${column.label}`"
                        title="下一张"
                        @click="handleStepColumnPrompt(column, 1)"
                    >
                      ›
                    </button>
                  </div>

                  <label class="sr-only" :for="`prompt-text-${column.activeEntry.item.id}`">{{ column.label }} Prompt</label>
                  <textarea
                      :id="`prompt-text-${column.activeEntry.item.id}`"
                      class="prompt-textarea"
                      :value="column.activeEntry.item.prompt || ''"
                      :disabled="imageBusy"
                      placeholder="当前方案没有返回 Prompt，请重新生成图包方案。"
                      @input="event => handlePromptChange(column.activeEntry!.item.id, (event.target as HTMLTextAreaElement).value)"
                  />

                  <!-- 智能素材路由：当前图引用的特征 -->
                  <div v-if="getPromptFeatureIds(column.activeEntry.item.promptId).length" class="prompt-feature-refs">
                    <span class="prompt-feature-label">引用特征：</span>
                    <span
                        v-for="f in getPromptFeatureIds(column.activeEntry.item.promptId)"
                        :key="f.id"
                        class="prompt-feature-tag"
                        :title="f.description"
                    >{{ f.label }}</span>
                  </div>

                  <button
                      v-if="getPromptImageSrc(column.activeEntry.item)"
                      type="button"
                      class="pack-preview"
                      :aria-label="`预览 ${column.activeEntry.item.title}`"
                      @click="handlePreviewPrompt(column.activeEntry!.index)"
                  >
                    <img :src="getPromptImageSrc(column.activeEntry.item)!" :alt="column.activeEntry.item.title">
                  </button>
                  <div v-else class="pack-preview-placeholder">
                    <template
                        v-if="imageBusy && (column.activeEntry.item.status === 'queued' || column.activeEntry.item.status === 'running')"
                    >
                      <span class="btn-spinner" aria-hidden="true"/>
                      <strong>生成中</strong>
                    </template>
                    <template v-else-if="column.activeEntry.item.status === 'failed'">
                      <Icon name="warning"/>
                      <strong>{{ column.activeEntry.item.error || "生成失败" }}</strong>
                    </template>
                    <template v-else>
                      <Icon name="image"/>
                      <strong>等待出图</strong>
                    </template>
                  </div>

                  <div class="pack-card-actions">
                    <button
                        type="button"
                        class="btn-ghost"
                        :disabled="!column.activeEntry.item.imageId"
                        @click="handleDownload(column.activeEntry!.index)"
                    >
                      <Icon name="download"/>
                      <span>下载</span>
                    </button>
                    <button
                        type="button"
                        class="btn-ghost"
                        :disabled="!column.activeEntry.item.imageId"
                        @click="handlePreviewPrompt(column.activeEntry!.index)"
                    >
                      <Icon name="zoom"/>
                      <span>预览</span>
                    </button>
                    <button
                        type="button"
                        class="btn-secondary"
                        :disabled="controlsDisabled || !column.activeEntry.item.promptId"
                        @click="handleRegeneratePromptAt(column.activeEntry!.index)"
                    >
                      重生成
                    </button>
                  </div>
                </article>
              </div>
            </article>
          </div>
        </section>
      </div>

      <HistoryDrawer title="生成历史" :count="history.length">
      <section class="history-dock">
        <HistoryGrid
            :history="history"
            :active-idx="activeHistoryIdx"
            @select="handleSelectHistory"
            @delete="handleDeleteHistory"
            @clear-all="handleClearHistory"
        />
      </section>
      </HistoryDrawer>
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

    <Lightbox :src="lightboxSrc" @close="lightboxSrc = null"/>
    <AdminPanel :open="adminOpen" @close="adminOpen = false"/>

    <!-- 查看所有图片弹窗 -->
    <Teleport to="body">
      <div
          v-if="galleryOpen"
          class="gallery-overlay"
          @click.self="galleryOpen = false"
          @keydown.escape="galleryOpen = false"
      >
        <div class="gallery-modal">
          <div class="gallery-head">
            <h2>全部图片 ({{ allGeneratedCount }})</h2>
            <div class="gallery-head-actions">
              <button
                  type="button"
                  class="gallery-download-btn"
                  :disabled="!allGeneratedCount"
                  @click="handleDownloadAll"
              >
                <Icon name="download"/>
                一键下载全部 ({{ allGeneratedCount }})
              </button>
              <button type="button" class="gallery-close" aria-label="关闭" @click="galleryOpen = false">
                <Icon name="close"/>
              </button>
            </div>
          </div>
          <div v-if="!allGeneratedCount" class="gallery-empty">
            <p>暂无已生成的图片</p>
          </div>
          <div v-else class="gallery-grid">
            <div
                v-for="image in allGeneratedImages"
                :key="image.id"
                class="gallery-card"
            >
              <button
                  type="button"
                  class="gallery-card-img"
                  @click="lightboxSrc = image.src"
              >
                <img :src="image.src" :alt="image.title" loading="lazy">
              </button>
              <div class="gallery-card-info">
                <span class="gallery-card-mode">{{ image.modeLabel }}</span>
                <span class="gallery-card-title">{{ image.title }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </main>
</template>
