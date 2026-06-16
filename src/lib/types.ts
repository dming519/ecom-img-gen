// 这里集中放前端和服务端都会用到的 TypeScript 类型。
// TypeScript 小提示：`type A = "x" | "y"` 表示 A 只能是这几个字符串之一。
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";
export type AspectRatio = "auto" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
export type LayerAspectRatio = "1:1" | "4:3" | "3:4";
export type ImageQuality = "1K" | "2K" | "4K";
export type DetailImageMode = "main" | "detail" | "sku";
export type ProductMaterialKind =
  | "pdf"
  | "word"
  | "powerpoint"
  | "excel"
  | "html"
  | "csv"
  | "json"
  | "xml";
export type MultiViewAngleId =
  | "front"
  | "left-side"
  | "right-side"
  | "back"
  | "oblique-45"
  | "top"
  | "bottom-up"
  | "detail";

type AuthProvider = "github" | "google" | "access";
export type UserRole = "super_admin" | "admin" | "user";

// 当前登录用户。带 `?` 的字段表示可选字段，接口可能返回也可能不返回。
export interface AuthUser {
  provider: AuthProvider;
  id: string;
  userKey?: string;
  name: string;
  email: string | null;
  image: string | null;
  role?: UserRole;
  remainingCredits?: number;
  usedCredits?: number;
  grantedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
}

// 登录态接口 `/api/auth/session` 的返回结构。
export interface AuthSession {
  authenticated: boolean;
  user: AuthUser | null;
}

// 管理后台用户列表的一行数据。
export interface AdminUserRow {
  userKey: string;
  provider: AuthProvider;
  providerId: string;
  name: string;
  email: string | null;
  image: string | null;
  role: UserRole;
  remainingCredits: number;
  usedCredits: number;
  grantedCredits: number;
  dailyRemainingCredits: number;
  dailyUsedCredits: number;
  dailyGrantedCredits: number;
  permanentRemainingCredits: number;
  permanentGrantedCredits: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number;
}

// 访问码：用于登录系统。
export interface AccessCodeRow {
  id: string;
  label: string;
  code: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastUsedAt?: number;
  useCount: number;
}

// 兑换码：给已登录用户增加永久生图额度。
export interface RedeemCodeRow {
  id: string;
  label: string;
  code: string;
  credits: number;
  maxRedemptions: number;
  redeemCount: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastRedeemedAt?: number;
}

// 图包生成前，用户在左侧表单里填写的商品资料。
export interface ProductInput {
  name: string;
  sellingPoints: string;
  skuInfo?: string;
  imageModes: DetailImageMode[];
  imageCount: number;
  targetPlatform?: string;
  audience?: string;
  priceBand?: string;
  proofMaterials?: string;
  offer?: string;
  extraRequirements?: string;
  productImages: string[];
  productImageIds?: string[];
  styleReferenceImages?: string[];
  styleReferenceImageIds?: string[];
  modelReferenceImages?: string[];
  modelReferenceImageIds?: string[];
  productMaterials?: ProductMaterialFile[];
  skuMaterials?: ProductMaterialFile[];
}

// 非图片商品资料在浏览器端转换为 Markdown 后进入辅助生图上下文。
export interface ProductMaterialFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ProductMaterialKind;
  markdown: string;
}

// 素材特征类别，用于智能素材路由。
type MaterialFeatureCategory =
  | "appearance"       // 外观：瓶型、颜色、包装、Logo、标签版式
  | "texture"          // 材质/质感
  | "ingredient"       // 成分/配方
  | "certification"    // 认证/资质/检测
  | "dimension"        // 尺寸/规格/容量/重量
  | "usage"            // 使用方法/步骤
  | "scenario"         // 使用场景/人群
  | "sku_spec"         // SKU区分维度（颜色/尺码/口味/版本）
  | "evidence"         // 证明素材（评价/实验/对比）
  | "offer"            // 活动/售后/服务承诺
  | "production"       // 工艺/产地/供应链
  | "comparison"       // 与竞品/旧款对比优势
  | "other";           // 其他

// 从上传资料中提取的结构化特征。
export interface MaterialFeature {
  id: string;                     // e.g., "f1"
  category: MaterialFeatureCategory;
  label: string;                  // 短标签，不超过12个汉字
  description: string;            // 完整描述，1-3句话
  sourceFile: string;             // 来源于哪个资料文件
  relevance: "main" | "detail" | "sku" | "all"; // 适合哪些图包类型
}

// 每张图与特征的路由分配关系。
export interface PromptFeatureAssignment {
  promptIndex: number;            // 第几张图（0-based）
  promptId: string;               // prompt 的 ID
  imageMode: DetailImageMode;
  title: string;
  assignedFeatureIds: string[];   // 分配给该图使用的特征 ID 列表
}

// 单张商品图在前端生命周期里的状态。
type DetailImageStatus =
  | "draft"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

// 一条图包方案，以及它对应的生成状态和结果图。
export interface DetailPromptItem {
  id: string;
  index: number;
  title: string;
  imageMode: DetailImageMode;
  prompt?: string;
  promptId?: string;
  status: DetailImageStatus;
  taskId?: string;
  imageId?: string;
  model?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

// 一组商品图历史记录：商品资料 + 多张文案/图片 + 生成参数。
export interface HistoryItem {
  id?: number;
  product: ProductInput;
  prompts: DetailPromptItem[];
  timestamp: number;
  generation?: {
    quality?: ImageQuality;
    size?: ImageSize;
  };
  // 智能素材路由结果（可选，随历史记录保存）
  materialFeatures?: MaterialFeature[];
  featureAssignments?: PromptFeatureAssignment[];
}

// 生成图包方案时，前端提交给 `/api/prompt` 的参数。
// 本地预览用的 productImages 不允许进入请求体，公开接口只接收 imageId。
export interface GeneratePromptOptions {
  name: string;
  sellingPoints: string;
  skuInfo?: string;
  imageModes: DetailImageMode[];
  targetPlatform?: string;
  audience?: string;
  priceBand?: string;
  proofMaterials?: string;
  offer?: string;
  extraRequirements?: string;
  productImageIds: string[];
  styleReferenceImageIds?: string[];
  modelReferenceImageIds?: string[];
  productMaterialsMarkdown?: string;
  skuMaterialsMarkdown?: string;
}

// `/api/prompt/status` 成功后返回的文案列表。
export interface GeneratePromptResult {
  prompts: Array<{
    promptId: string;
    title: string;
    imageMode: DetailImageMode;
    prompt?: string;
    index: number;
  }>;
  model: string;
  // 智能素材路由结果
  materialFeatures?: MaterialFeature[];
  featureAssignments?: PromptFeatureAssignment[];
}

// 文案任务状态。任务是异步的，所以会经历 pending/running/succeeded/failed。
export interface PromptTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed";
  prompts?: GeneratePromptResult["prompts"];
  model?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  // 智能素材路由：特征提取阶段
  phase?: "extracting_features";
  materialFeatures?: MaterialFeature[];
  featureAssignments?: PromptFeatureAssignment[];
}

interface CreateDetailImageTaskOptions {
  promptId: string;
  prompt?: string;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  quality?: ImageQuality;
  inputImageIds: string[];
}

interface CreateMultiViewTaskOptions {
  mode: "multi-view";
  angleId: MultiViewAngleId;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  quality?: ImageQuality;
  inputImageIds: string[];
}

// 创建图片生成任务时提交给 `/api/generate` 的参数。
export type CreateImageTaskOptions = CreateDetailImageTaskOptions | CreateMultiViewTaskOptions;

// 图片生成任务状态。成功时优先返回 `imageId`，前端通过图片文件接口加载。
export interface ImageTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  imageId?: string;
  model?: string;
  error?: string;
  usedReferenceImages?: boolean;
  usedCompactPrompt?: boolean;
  warning?: string | null;
  remainingCredits?: number;
  usedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
  unlimitedCredits?: boolean;
  billedAt?: number;
}

// 抠图历史里使用的状态，比接口多了 draft，因为前端会保存草稿。
type CutoutStatus =
  | "draft"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type MultiViewHistoryStatus =
  | "draft"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

// 创建抠图任务需要原图和 mask 图。mask 图白色区域表示要保留的主体。
export interface CreateCutoutTaskOptions {
  sourceImageId: string;
  maskImageId: string;
  target?: string;
}

// 创建局部改图任务需要原图、涂抹区域和用户输入的修改内容。
export interface CreateEditTaskOptions {
  sourceImageId: string;
  maskImageId: string;
  instruction: string;
}

export interface CreateLayerTaskOptions {
  sourceImageId: string;
  sourceDimensions?: {
    width: number;
    height: number;
  };
  layerAspectRatio?: LayerAspectRatio;
}

export interface LayerResultItem {
  id: string;
  name: string;
  role: "background" | "subject" | "person" | "text" | "decoration" | "shadow" | "preview" | "other";
  index: number;
  imageId?: string;
}

// 抠图任务状态。成功时优先返回 `imageId`，前端通过图片文件接口加载白底结果图。
export interface CutoutTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  imageId?: string;
  layers?: LayerResultItem[];
  manifest?: {
    width?: number;
    height?: number;
    aspectRatio?: LayerAspectRatio;
    renderSize?: ImageSize;
    sourceImageId?: string;
    createdAt?: number;
    layerPlan?: Array<{
      id: string;
      name: string;
      role: LayerResultItem["role"];
      index: number;
    }>;
  };
  progress?: {
    done?: number;
    total?: number;
    current?: string;
  };
  model?: string;
  error?: string;
  remainingCredits?: number;
  usedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
  unlimitedCredits?: boolean;
  billedAt?: number;
}

export type EditTaskStatus = CutoutTaskStatus;
export type LayerTaskStatus = CutoutTaskStatus;

// 一条抠图历史记录。
export interface CutoutHistoryItem {
  id?: number;
  sourceImageId?: string;
  maskImageId?: string;
  resultImageId?: string;
  target?: string;
  status: CutoutStatus;
  error?: string;
  taskId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

// 一条局部改图历史记录。
export interface EditHistoryItem {
  id?: number;
  sourceImageId?: string;
  maskImageId?: string;
  resultImageId?: string;
  instruction: string;
  status: CutoutStatus;
  error?: string;
  taskId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

interface MultiViewHistoryResultItem {
  id: MultiViewAngleId;
  title: string;
  status: MultiViewHistoryStatus;
  taskId?: string;
  imageId?: string;
  model?: string;
  error?: string;
  updatedAt?: number;
}

export interface MultiViewHistoryItem {
  id?: number;
  sourceImageIds?: string[];
  aspectRatio: AspectRatio;
  quality: ImageQuality;
  results: MultiViewHistoryResultItem[];
  status: MultiViewHistoryStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LayerHistoryItem {
  id?: number;
  sourceImageId?: string;
  sourceDimensions?: {
    width: number;
    height: number;
  };
  normalizedToSourceSize?: boolean;
  layerBackground?: string;
  layers: LayerResultItem[];
  status: "running" | "succeeded" | "failed" | "canceled";
  taskId?: string;
  error?: string;
  model?: string;
  progress?: {
    done?: number;
    total?: number;
    current?: string;
  };
  createdAt: number;
  updatedAt: number;
}

// 抠图页面的自动草稿，保存当前原图、mask、结果和画笔设置。
export interface CutoutDraft {
  id: "active";
  sourceImageId?: string;
  maskImageId?: string;
  resultImageId?: string;
  target?: string;
  brushSize?: number;
  mode?: "brush" | "eraser";
  canvasZoom?: number;
  updatedAt: number;
}
