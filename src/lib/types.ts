export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";
export type AspectRatio = "auto" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
export type ImageQuality = "1K" | "2K" | "4K";

export type AuthProvider = "github" | "google" | "access";
export type UserRole = "super_admin" | "admin" | "user";

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
}

export interface AuthSession {
  authenticated: boolean;
  user: AuthUser | null;
}

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
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number;
}

export interface AccessCodeRow {
  id: string;
  label: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastUsedAt?: number;
  useCount: number;
}

export interface RedeemCodeRow {
  id: string;
  label: string;
  credits: number;
  maxRedemptions: number;
  redeemCount: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastRedeemedAt?: number;
}

export interface ProductInput {
  name: string;
  sellingPoints: string;
  imageCount: number;
  productImages: string[];
  productImageIds?: string[];
}

export type DetailImageStatus =
  | "draft"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface DetailPromptItem {
  id: string;
  index: number;
  title: string;
  prompt: string;
  status: DetailImageStatus;
  taskId?: string;
  imageId?: string;
  base64?: string;
  model?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface HistoryItem {
  id?: number;
  product: ProductInput;
  prompts: DetailPromptItem[];
  timestamp: number;
  generation?: {
    aspectRatio?: AspectRatio;
    quality?: ImageQuality;
    size?: ImageSize;
  };
}

export type GeneratePromptOptions = ProductInput;

export interface GeneratePromptResult {
  prompts: Array<{
    title: string;
    prompt: string;
  }>;
  model: string;
}

export interface PromptTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed";
  prompts?: GeneratePromptResult["prompts"];
  model?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateImageTaskOptions {
  prompt: string;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  quality?: ImageQuality;
  inputImages: string[];
}

export interface ImageTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  base64?: string;
  model?: string;
  error?: string;
  usedReferenceImages?: boolean;
  usedCompactPrompt?: boolean;
  warning?: string | null;
  remainingCredits?: number;
  usedCredits?: number;
  unlimitedCredits?: boolean;
  billedAt?: number;
}

export type CutoutStatus =
  | "draft"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface CreateCutoutTaskOptions {
  sourceImage: string;
  maskImage: string;
}

export interface CutoutTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  base64?: string;
  model?: string;
  error?: string;
  remainingCredits?: number;
  usedCredits?: number;
  unlimitedCredits?: boolean;
  billedAt?: number;
}

export interface CutoutHistoryItem {
  id?: number;
  sourceImageId?: string;
  maskImageId?: string;
  resultImageId?: string;
  sourceImage?: string;
  maskImage?: string;
  resultBase64?: string;
  status: CutoutStatus;
  error?: string;
  taskId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CutoutDraft {
  id: "active";
  sourceImageId?: string;
  maskImageId?: string;
  resultImageId?: string;
  resultBase64?: string | null;
  brushSize?: number;
  mode?: "brush" | "eraser";
  canvasZoom?: number;
  updatedAt: number;
}
