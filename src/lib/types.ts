export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";

export type AuthProvider = "github" | "google";

export interface AuthUser {
  provider: AuthProvider;
  id: string;
  name: string;
  email: string | null;
  image: string | null;
}

export interface AuthSession {
  authenticated: boolean;
  user: AuthUser | null;
}

export interface ProductInput {
  name: string;
  sellingPoints: string;
  imageCount: number;
  productImages: string[];
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
}

export interface GeneratePromptOptions extends ProductInput {
  template: string;
}

export interface GeneratePromptResult {
  prompts: Array<{
    title: string;
    prompt: string;
  }>;
  model: string;
}

export interface CreateImageTaskOptions {
  prompt: string;
  size: ImageSize;
  inputImages: string[];
}

export interface ImageTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed";
  base64?: string;
  model?: string;
  error?: string;
}
