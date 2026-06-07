import type { CutoutDraft, CutoutHistoryItem, HistoryItem } from "./types";

interface ErrorPayload {
  error?: string | { message?: string };
}

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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function assignSaved<T extends object>(target: T, saved: T) {
  Object.assign(target, saved);
  return saved;
}

function mergeSavedDetail(target: HistoryItem, saved: HistoryItem) {
  const savedPromptById = new Map(saved.prompts.map((prompt) => [prompt.id, prompt]));
  target.id = saved.id;
  target.product = {
    ...target.product,
    productImages: target.product.productImages,
    productImageIds: saved.product.productImageIds ?? target.product.productImageIds,
  };
  target.prompts = target.prompts.map((prompt) => {
    const savedPrompt = savedPromptById.get(prompt.id);
    return savedPrompt
      ? {
          ...prompt,
          imageId: savedPrompt.imageId ?? prompt.imageId,
        }
      : prompt;
  });
  target.timestamp = saved.timestamp;
  target.generation = saved.generation;
  return target;
}

function toDetailRequestItem(item: HistoryItem): HistoryItem {
  const productImageIds = item.product.productImageIds ?? [];
  const productImages =
    productImageIds.length >= item.product.productImages.length
      ? []
      : item.product.productImages;
  return {
    ...item,
    product: {
      ...item.product,
      productImages,
    },
    prompts: item.prompts.map((prompt) => {
      if (!prompt.imageId) return prompt;
      const { base64: _base64, ...rest } = prompt;
      return rest;
    }),
  };
}

function toCutoutRequestItem(item: CutoutHistoryItem): CutoutHistoryItem {
  const {
    sourceImage: _sourceImage,
    maskImage: _maskImage,
    resultBase64: _resultBase64,
    ...rest
  } = item;
  return item.resultImageId
    ? rest
    : {
        ...rest,
        resultBase64: item.resultBase64,
      };
}

function toCutoutDraftRequest(
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
): Omit<CutoutDraft, "id"> & { id?: "active" } {
  if (!draft.resultImageId) return draft;
  const { resultBase64: _resultBase64, ...rest } = draft;
  return rest;
}

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

export async function dbGetCutoutDraft() {
  const payload = await requestJson<{ draft: CutoutDraft | null }>(
    "/api/history/cutout-draft",
  );
  return payload.draft ?? undefined;
}

export async function dbPutCutoutDraft(
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
) {
  const payload = await requestJson<{ draft: CutoutDraft }>(
    "/api/history/cutout-draft",
    {
      method: "PUT",
      body: JSON.stringify({ draft: toCutoutDraftRequest(draft) }),
    },
  );
  assignSaved(draft, payload.draft);
  return "active";
}

export async function dbClearCutoutDraft() {
  await requestJson<{ ok: boolean }>("/api/history/cutout-draft", {
    method: "DELETE",
  });
}

export async function dbPutProductImage(dataUrl: string): Promise<string> {
  const payload = await requestJson<{ id: string }>("/api/history/image", {
    method: "POST",
    body: JSON.stringify({ dataUrl }),
  });
  return payload.id;
}

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

export function dbImageFileUrl(id: string) {
  return `/api/history/image-file?id=${encodeURIComponent(id)}`;
}
