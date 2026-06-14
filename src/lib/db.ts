import type {
  CutoutDraft,
  CutoutHistoryItem,
  EditHistoryItem,
  HistoryItem,
  LayerHistoryItem,
  MultiViewHistoryItem,
} from "./types";

interface ErrorPayload {
  error?: string | { message?: string };
}

// 这个文件名字叫 db，是为了保留前端调用习惯；实际数据已经存到服务端 D1/R2。
// 前端只负责把历史记录整理成适合接口保存的结构。

function extractError(text: string) {
  let detail = text.slice(0, 300);
  try {
    const payload = JSON.parse(text) as ErrorPayload;
    if (typeof payload.error === "string") {
      detail = payload.error;
    } else if (payload.error?.message) {
      detail = payload.error.message;
    }
  } catch {
    // Keep raw text.
  }
  return detail;
}

// 带泛型的请求函数：调用方通过 `requestJson<{ item: HistoryItem }>()`
// 告诉 TypeScript“我期望接口返回什么形状的数据”。
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function dataUrlToBlob(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (!match?.[2]) {
    throw new Error("图片数据必须是 data:image base64 格式");
  }
  const mimeType = match[1] || "image/png";
  if (!mimeType.startsWith("image/")) {
    throw new Error("图片数据必须是 image/* 格式");
  }
  const binary = atob(match[2].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

// 服务端保存后会返回规范化后的对象，这里把返回值合并回原对象，保持 Vue 页面引用不丢。
function assignSaved<T extends object>(target: T, saved: T) {
  Object.assign(target, saved);
  return saved;
}

// 商品图历史保存后，把服务端返回的规范化字段合并回页面状态。
function mergeSavedDetail(target: HistoryItem, saved: HistoryItem) {
  const savedPromptById = new Map(saved.prompts.map((prompt) => [prompt.id, prompt]));
  target.id = saved.id;
  target.product = {
    ...target.product,
    productImages: target.product.productImages,
    productImageIds: saved.product.productImageIds ?? target.product.productImageIds,
    styleReferenceImages: target.product.styleReferenceImages ?? [],
    styleReferenceImageIds: saved.product.styleReferenceImageIds ?? target.product.styleReferenceImageIds,
  };
  target.prompts = target.prompts.map((prompt) => {
    const savedPrompt = savedPromptById.get(prompt.id);
    return savedPrompt
      ? {
          ...prompt,
          promptId: savedPrompt.promptId ?? prompt.promptId,
          imageId: savedPrompt.imageId ?? prompt.imageId,
        }
      : prompt;
  });
  target.timestamp = saved.timestamp;
  target.generation = saved.generation;
  return target;
}

// 提交商品图历史前做瘦身：历史 JSON 只保留图片 ID 和 prompt ID。
function toDetailRequestItem(item: HistoryItem): HistoryItem {
  return {
    ...item,
    product: {
      ...item.product,
      productImages: [],
      productImageIds: item.product.productImageIds ?? [],
      styleReferenceImages: [],
      styleReferenceImageIds: item.product.styleReferenceImageIds ?? [],
    },
    prompts: item.prompts,
  };
}

// 抠图历史只保存图片 ID。
function toCutoutRequestItem(item: CutoutHistoryItem): CutoutHistoryItem {
  return item;
}

// 改图历史只保存图片 ID。
function toEditRequestItem(item: EditHistoryItem): EditHistoryItem {
  return item;
}

function toMultiViewRequestItem(item: MultiViewHistoryItem): MultiViewHistoryItem {
  return {
    ...item,
    sourceImageIds: item.sourceImageIds ?? [],
  };
}

function toLayerRequestItem(item: LayerHistoryItem): LayerHistoryItem {
  return item;
}

// 新增一组商品图历史。
export async function dbAdd(item: HistoryItem) {
  const payload = await requestJson<{ item: HistoryItem }>("/api/history/detail", {
    method: "POST",
    body: JSON.stringify({ item: toDetailRequestItem(item) }),
  });
  const saved = mergeSavedDetail(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回历史记录 ID");
  }
  return saved.id;
}

// 更新已有商品图历史，例如某一张图生成完成后写回结果。
export async function dbPut(item: HistoryItem) {
  const payload = await requestJson<{ item: HistoryItem }>("/api/history/detail", {
    method: "PUT",
    body: JSON.stringify({ item: toDetailRequestItem(item) }),
  });
  const saved = mergeSavedDetail(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回历史记录 ID");
  }
  return saved.id;
}

// 读取当前用户的全部商品图历史。
export async function dbAll() {
  const payload = await requestJson<{ items: HistoryItem[] }>("/api/history/detail");
  return payload.items;
}

export async function dbDel(id: number) {
  await requestJson<{ ok: boolean }>(
    `/api/history/detail?id=${encodeURIComponent(String(id))}`,
    { method: "DELETE" },
  );
}

export async function dbClear() {
  await requestJson<{ ok: boolean }>("/api/history/detail", { method: "DELETE" });
}

// 新增一条抠图历史。
export async function dbAddCutout(item: CutoutHistoryItem) {
  const payload = await requestJson<{ item: CutoutHistoryItem }>("/api/history/cutout", {
    method: "POST",
    body: JSON.stringify({ item: toCutoutRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回抠图历史 ID");
  }
  return saved.id;
}

// 更新抠图历史。
export async function dbPutCutout(item: CutoutHistoryItem) {
  const payload = await requestJson<{ item: CutoutHistoryItem }>("/api/history/cutout", {
    method: "PUT",
    body: JSON.stringify({ item: toCutoutRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回抠图历史 ID");
  }
  return saved.id;
}

export async function dbAllCutouts() {
  const payload = await requestJson<{ items: CutoutHistoryItem[] }>("/api/history/cutout");
  return payload.items;
}

export async function dbDelCutout(id: number) {
  await requestJson<{ ok: boolean }>(
    `/api/history/cutout?id=${encodeURIComponent(String(id))}`,
    { method: "DELETE" },
  );
}

export async function dbClearCutouts() {
  await requestJson<{ ok: boolean }>("/api/history/cutout", { method: "DELETE" });
}

export async function dbAddEdit(item: EditHistoryItem) {
  const payload = await requestJson<{ item: EditHistoryItem }>("/api/history/edit", {
    method: "POST",
    body: JSON.stringify({ item: toEditRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回改图历史 ID");
  }
  return saved.id;
}

export async function dbPutEdit(item: EditHistoryItem) {
  const payload = await requestJson<{ item: EditHistoryItem }>("/api/history/edit", {
    method: "PUT",
    body: JSON.stringify({ item: toEditRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回改图历史 ID");
  }
  return saved.id;
}

export async function dbAllEdits() {
  const payload = await requestJson<{ items: EditHistoryItem[] }>("/api/history/edit");
  return payload.items;
}

export async function dbDelEdit(id: number) {
  await requestJson<{ ok: boolean }>(
    `/api/history/edit?id=${encodeURIComponent(String(id))}`,
    { method: "DELETE" },
  );
}

export async function dbClearEdits() {
  await requestJson<{ ok: boolean }>("/api/history/edit", { method: "DELETE" });
}

export async function dbAddMultiView(item: MultiViewHistoryItem) {
  const payload = await requestJson<{ item: MultiViewHistoryItem }>("/api/history/multi-view", {
    method: "POST",
    body: JSON.stringify({ item: toMultiViewRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回多视角历史 ID");
  }
  return saved.id;
}

export async function dbPutMultiView(item: MultiViewHistoryItem) {
  const payload = await requestJson<{ item: MultiViewHistoryItem }>("/api/history/multi-view", {
    method: "PUT",
    body: JSON.stringify({ item: toMultiViewRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回多视角历史 ID");
  }
  return saved.id;
}

export async function dbAllMultiViews() {
  const payload = await requestJson<{ items: MultiViewHistoryItem[] }>("/api/history/multi-view");
  return payload.items;
}

export async function dbDelMultiView(id: number) {
  await requestJson<{ ok: boolean }>(
    `/api/history/multi-view?id=${encodeURIComponent(String(id))}`,
    { method: "DELETE" },
  );
}

export async function dbClearMultiViews() {
  await requestJson<{ ok: boolean }>("/api/history/multi-view", { method: "DELETE" });
}

export async function dbAddLayer(item: LayerHistoryItem) {
  const payload = await requestJson<{ item: LayerHistoryItem }>("/api/history/layer", {
    method: "POST",
    body: JSON.stringify({ item: toLayerRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回分层历史 ID");
  }
  return saved.id;
}

export async function dbPutLayer(item: LayerHistoryItem) {
  const payload = await requestJson<{ item: LayerHistoryItem }>("/api/history/layer", {
    method: "PUT",
    body: JSON.stringify({ item: toLayerRequestItem(item) }),
  });
  const saved = assignSaved(item, payload.item);
  if (saved.id == null) {
    throw new Error("服务端未返回分层历史 ID");
  }
  return saved.id;
}

export async function dbAllLayers() {
  const payload = await requestJson<{ items: LayerHistoryItem[] }>("/api/history/layer");
  return payload.items;
}

export async function dbDelLayer(id: number) {
  await requestJson<{ ok: boolean }>(
    `/api/history/layer?id=${encodeURIComponent(String(id))}`,
    { method: "DELETE" },
  );
}

export async function dbClearLayers() {
  await requestJson<{ ok: boolean }>("/api/history/layer", { method: "DELETE" });
}

export async function dbGetCutoutDraft() {
  const payload = await requestJson<{ draft: CutoutDraft | null }>(
    "/api/history/cutout-draft",
  );
  return payload.draft ?? undefined;
}

// 保存抠图页面的“未完成草稿”，刷新页面后还能恢复原图、mask 和结果。
export async function dbPutCutoutDraft(
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
) {
  const payload = await requestJson<{ draft: CutoutDraft }>(
    "/api/history/cutout-draft",
    {
      method: "PUT",
      body: JSON.stringify({ draft }),
    },
  );
  assignSaved(draft, payload.draft);
  return "active";
}

// 把一张 Blob 图片用文件流存到服务端，返回 imageId。
export async function dbPutProductImageBlob(
  blob: Blob,
  filename = blob.type === "image/jpeg" ? "image.jpg" : "image.png",
): Promise<string> {
  const formData = new FormData();
  formData.append("image", blob, filename);
  const payload = await requestJson<{ id: string }>("/api/history/image", {
    method: "POST",
    body: formData,
  });
  return payload.id;
}

// 把一张 data URL 图片存到服务端，返回 imageId。之后历史记录只保存 imageId。
export async function dbPutProductImage(dataUrl: string): Promise<string> {
  return dbPutProductImageBlob(dataUrlToBlob(dataUrl));
}

// 根据多个 imageId 批量取回可直接放进 <img> 的图片文件 URL。
export async function dbGetProductImages(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const payload = await requestJson<{ images: Array<string | null> }>(
    "/api/history/images",
    {
      method: "POST",
      body: JSON.stringify({ ids }),
    },
  );
  return payload.images.filter((item): item is string => !!item);
}

// 页面 `<img>` 可以直接使用这个 URL，让浏览器自己加载历史图片文件。
export function dbImageFileUrl(id: string) {
  return `/api/history/image-file?id=${encodeURIComponent(id)}`;
}
