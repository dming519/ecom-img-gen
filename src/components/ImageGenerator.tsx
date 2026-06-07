"use client";

import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  cancelImageTask,
  createImageTask,
  generateDetailPrompts,
  pollImageTask,
  redeemCredits,
} from "@/lib/api";
import {
  dbAdd,
  dbAll,
  dbClear,
  dbDel,
  dbImageFileUrl,
  dbGetProductImages,
  dbPut,
} from "@/lib/db";
import { resolveImageSize } from "@/lib/imageOptions";
import type {
  AspectRatio,
  AuthSession,
  DetailPromptItem,
  HistoryItem,
  ImageQuality,
  ProductInput,
} from "@/lib/types";
import AdminPanel from "./AdminPanel";
import AspectRatioSelector from "./AspectRatioSelector";
import CutoutStudio from "./CutoutStudio";
import HistoryGrid from "./HistoryGrid";
import Icon from "./Icon";
import ImageCountSelector from "./ImageCountSelector";
import Lightbox from "./Lightbox";
import QualitySelector from "./QualitySelector";
import Stage from "./Stage";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_EDGE = 1280;
const PRODUCT_IMAGE_QUALITY = 0.82;
const MAX_PROMPT_IMAGE_CHARS = 1_500_000;
const MAX_PROMPT_IMAGE_TOTAL_CHARS = 6_000_000;
const MAX_DETAIL_IMAGES = 8;
const LEGACY_DRAFT_KEY = "ecomimggen_draft";
const DRAFT_KEY = "ecomimggen_draft_v2";
type WakeLockSentinelLike = { release: () => Promise<void> };
type StudioMode = "image" | "cutout";
const ASPECT_RATIO_VALUES: AspectRatio[] = ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"];
const IMAGE_QUALITY_VALUES: ImageQuality[] = ["1K", "2K", "4K"];
const STATUS_LABEL: Record<DetailPromptItem["status"], string> = {
  draft: "待生成",
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
};

class ImageGenerationCancelledError extends Error {
  constructor() {
    super("已中断生成详情图");
    this.name = "ImageGenerationCancelledError";
  }
}

interface DraftState {
  productName: string;
  sellingPoints: string;
  imageCount: number;
  prompts: DetailPromptItem[];
  aspectRatio?: AspectRatio;
  quality?: ImageQuality;
  productImageIds?: string[];
}

function fileToCompressedDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(
          1,
          MAX_PRODUCT_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
        );
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", {
          alpha: false,
          desynchronized: true,
        });
        if (!ctx) {
          reject(new Error("浏览器不支持图片压缩，请更换图片后重试"));
          return;
        }
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", PRODUCT_IMAGE_QUALITY));
      };
      image.onerror = () => reject(new Error("图片读取失败，请更换图片后重试"));
      image.src = String(reader.result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function createPromptItem(index: number, title: string, prompt: string): DetailPromptItem {
  return {
    id: crypto.randomUUID(),
    index,
    title,
    prompt,
    status: "draft",
  };
}

function resetInterruptedPrompt(item: DetailPromptItem): DetailPromptItem {
  if (item.status !== "queued" && item.status !== "running") return item;
  return {
    ...item,
    status: item.base64 ? "succeeded" : "draft",
    taskId: item.base64 ? item.taskId : undefined,
    error: undefined,
    updatedAt: Date.now(),
  };
}

function resetActiveGenerationPrompts(items: DetailPromptItem[]): DetailPromptItem[] {
  return items.map((item) =>
    item.status === "queued" || item.status === "running"
      ? {
          ...item,
          status: item.base64 ? "succeeded" : "draft",
          taskId: item.base64 ? item.taskId : undefined,
          error: undefined,
          updatedAt: Date.now(),
        }
      : item,
  );
}

function cloneProduct(input: ProductInput): ProductInput {
  return {
    name: input.name,
    sellingPoints: input.sellingPoints,
    imageCount: input.imageCount,
    productImages: [...input.productImages],
    productImageIds: input.productImageIds ? [...input.productImageIds] : [],
  };
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("图片读取失败"));
      }
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function imageSrcToDataUrl(src: string) {
  const value = src.trim();
  if (value.startsWith("data:image/")) return value;

  const response = await fetch(value, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("产品参考图读取失败，请重新上传图片。");
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("产品参考图格式无效，请重新上传图片。");
  }
  return blobToDataUrl(blob);
}

async function getPromptReadyImages(images: string[]) {
  const dataUrls = await Promise.all(images.slice(0, 8).map(imageSrcToDataUrl));
  const next = dataUrls
    .filter((image) => image.startsWith("data:image/"))
    .filter((image) => image.length <= MAX_PROMPT_IMAGE_CHARS)
    .slice(0, 8);
  const total = next.reduce((sum, image) => sum + image.length, 0);
  if (!next.length) {
    throw new Error("产品参考图过大或格式无效，请重新上传图片。");
  }
  if (total > MAX_PROMPT_IMAGE_TOTAL_CHARS) {
    throw new Error("产品参考图总大小过大，请减少图片数量或重新上传后再生成。");
  }
  return next;
}

function getPromptImageSrc(item: DetailPromptItem | undefined) {
  if (!item) return null;
  if (item.base64) return "data:image/png;base64," + item.base64;
  if (item.imageId) return dbImageFileUrl(item.imageId);
  return null;
}

function readStudioModeFromUrl(): StudioMode {
  if (typeof window === "undefined") return "image";
  const pathname = window.location.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/cutout")) return "cutout";
  if (pathname.endsWith("/image")) return "image";
  const hashMode = window.location.hash.replace(/^#/, "");
  if (hashMode === "cutout") return "cutout";
  if (hashMode === "image") return "image";
  const module = new URL(window.location.href).searchParams.get("module");
  return module === "cutout" ? "cutout" : "image";
}

interface ImageGeneratorProps {
  initialMode?: StudioMode;
}

export default function ImageGenerator({ initialMode }: ImageGeneratorProps = {}) {
  const [studioMode, setStudioMode] = useState<StudioMode>(() => initialMode ?? readStudioModeFromUrl());
  const [productName, setProductName] = useState("");
  const [sellingPoints, setSellingPoints] = useState("");
  const [imageCount, setImageCount] = useState(5);
  const [productImages, setProductImages] = useState<string[]>([]);
  const [productImageIds, setProductImageIds] = useState<string[]>([]);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("3:4");
  const [quality, setQuality] = useState<ImageQuality>("1K");
  const [prompts, setPrompts] = useState<DetailPromptItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeHistoryIdx, setActiveHistoryIdx] = useState(-1);
  const [activePromptIdx, setActivePromptIdx] = useState(0);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [authPopoverOpen, setAuthPopoverOpen] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemMessage, setRedeemMessage] = useState<string | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const authPopoverRef = useRef<HTMLDivElement | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const imageAbortRef = useRef<AbortController | null>(null);
  const imageCancelRequestedRef = useRef(false);
  const currentImageTaskIdRef = useRef<string | null>(null);

  const currentProduct: ProductInput = {
    name: productName.trim(),
    sellingPoints: sellingPoints.trim(),
    imageCount,
    productImages,
    productImageIds,
  };
  const resolvedSize = resolveImageSize(aspectRatio);
  const generationLabel = `${aspectRatio === "auto" ? "Auto" : aspectRatio} · ${quality}`;

  useEffect(() => {
    setAvatarFailed(false);
  }, [session?.user?.image]);

  useEffect(() => {
    const handleLocationChange = () => setStudioMode(readStudioModeFromUrl());
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  const handleModuleLinkClick = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>, mode: StudioMode) => {
      if (mode === studioMode) return;
      const flushCutoutDraft = window.ecomImgGenFlushCutoutDraft;
      if (!flushCutoutDraft) return;
      event.preventDefault();
      try {
        await flushCutoutDraft();
      } catch (draftError) {
        console.warn("抠图草稿保存失败:", draftError);
      }
      window.location.assign(mode === "cutout" ? "/cutout/" : "/image/");
    },
    [studioMode],
  );

  const handleHomeLinkClick = useCallback(async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const flushCutoutDraft = window.ecomImgGenFlushCutoutDraft;
    if (!flushCutoutDraft) return;
    event.preventDefault();
    try {
      await flushCutoutDraft();
    } catch (draftError) {
      console.warn("抠图草稿保存失败:", draftError);
    }
    window.location.assign("/");
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_DRAFT_KEY);
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) {
        setDraftLoaded(true);
        return;
      }
      const draft = JSON.parse(raw) as DraftState;
      setProductName(draft.productName || "");
      setSellingPoints(draft.sellingPoints || "");
      setImageCount(
        Number.isFinite(draft.imageCount)
          ? Math.min(MAX_DETAIL_IMAGES, Math.max(1, Math.round(draft.imageCount)))
          : 5,
      );
      setPrompts(Array.isArray(draft.prompts) ? draft.prompts.map(resetInterruptedPrompt) : []);
      if (draft.aspectRatio && ASPECT_RATIO_VALUES.includes(draft.aspectRatio)) {
        setAspectRatio(draft.aspectRatio);
      }
      if (draft.quality && IMAGE_QUALITY_VALUES.includes(draft.quality)) {
        setQuality(draft.quality);
      }
      if (Array.isArray(draft.productImageIds) && draft.productImageIds.length) {
        setProductImageIds(draft.productImageIds);
        dbGetProductImages(draft.productImageIds)
          .then((images) => setProductImages(images.slice(0, 8)))
          .catch((event) => console.warn("产品参考图恢复失败:", event));
      }
    } catch {
      // Ignore invalid local draft.
    } finally {
      setDraftLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    try {
      const draft: DraftState = {
        productName,
        sellingPoints,
        imageCount,
        prompts,
        aspectRatio,
        quality,
        productImageIds,
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Ignore storage failures.
    }
  }, [
    draftLoaded,
    productName,
    sellingPoints,
    imageCount,
    prompts,
    aspectRatio,
    quality,
    productImageIds,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = (await dbAll()) ?? [];
        if (cancelled) return;
        setHistory(items);
        if (items.length) setActiveHistoryIdx(items.length - 1);
      } catch (event) {
        console.warn("历史记录读取失败:", event);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as AuthSession;
        if (!cancelled) setSession(payload);
      } catch {
        if (!cancelled) setSession({ authenticated: false, user: null });
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authPopoverOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!authPopoverRef.current?.contains(target)) {
        setAuthPopoverOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAuthPopoverOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [authPopoverOpen]);

  const persistHistory = useCallback(async (item: HistoryItem) => {
    try {
      if (item.id == null) {
        const id = await dbAdd(item);
        item.id = id as number;
      } else {
        await dbPut(item);
      }
      if (item.product.productImageIds?.length) {
        setProductImageIds(item.product.productImageIds);
      }
    } catch (event) {
      console.warn("历史记录写入失败:", event);
    }
  }, []);

  const handleSelectFiles = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return;
    setError(null);
    const accepted: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        setError(`已忽略非图片文件：${file.name}`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`图片过大（>8MB）已忽略：${file.name}`);
        continue;
      }
      try {
        const dataUrl = await fileToCompressedDataURL(file);
        accepted.push(dataUrl);
      } catch (event) {
        console.warn("读取图片失败:", event);
      }
    }
    if (accepted.length) {
      setProductImages((previous) => [...previous, ...accepted].slice(0, 8));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleResetProductInput = useCallback(() => {
    if (promptBusy || imageBusy) return;
    setError(null);
    setProductName("");
    setSellingPoints("");
    setImageCount(5);
    setProductImages([]);
    setProductImageIds([]);
    setAspectRatio("3:4");
    setQuality("1K");
    setPrompts([]);
    setActivePromptIdx(0);
    setActiveHistoryIdx(-1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [imageBusy, promptBusy]);

  const validateProduct = useCallback(() => {
    if (!session?.authenticated) {
      setError("请先登录后再使用 EcomImgGen。");
      return false;
    }
    if (!productName.trim()) {
      setError("请输入产品名称。");
      return false;
    }
    if (!sellingPoints.trim()) {
      setError("请输入产品核心卖点和功效。");
      return false;
    }
    if (!productImages.length) {
      setError("请至少上传一张产品参考图。系统已禁止纯文案生成，以保证产品外观一致。");
      return false;
    }
    return true;
  }, [productImages.length, productName, sellingPoints, session]);

  const handleGeneratePrompts = useCallback(async () => {
    setError(null);
    if (!validateProduct()) return;
    setPromptBusy(true);
    try {
      const result = await generateDetailPrompts({
        ...currentProduct,
        productImages: await getPromptReadyImages(productImages),
      });
      const next = result.prompts.map((item, index) =>
        createPromptItem(index, item.title, item.prompt),
      );
      setPrompts(next);
      setActivePromptIdx(0);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setPromptBusy(false);
    }
  }, [currentProduct, productImages, validateProduct]);

  const handlePromptChange = useCallback((id: string, value: string) => {
    setPrompts((previous) =>
      previous.map((item) =>
        item.id === id
          ? { ...item, prompt: value, status: item.base64 ? item.status : "draft" }
          : item,
      ),
    );
  }, []);

  const handleTitleChange = useCallback((id: string, value: string) => {
    setPrompts((previous) =>
      previous.map((item) => (item.id === id ? { ...item, title: value } : item)),
    );
  }, []);

  const handleGenerateImages = useCallback(async () => {
    setError(null);
    if (!validateProduct()) return;
    if (!prompts.length) {
      setError("请先生成详情图文案。");
      return;
    }
    if (prompts.some((item) => !item.prompt.trim())) {
      setError("详情图文案不能为空，请检查后再生成。");
      return;
    }

    setImageBusy(true);
    imageCancelRequestedRef.current = false;
    imageAbortRef.current = new AbortController();
    let historyItem: HistoryItem = {
      product: cloneProduct(currentProduct),
      prompts: prompts.map((item) => ({
        ...item,
        status: "draft",
        imageId: undefined,
        base64: undefined,
      })),
      timestamp: Date.now(),
      generation: {
        aspectRatio,
        quality,
        size: resolvedSize,
      },
    };

    try {
      const generationImages = await getPromptReadyImages(productImages);
      try {
        const maybeWakeLock = (
          navigator as Navigator & {
            wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
          }
        ).wakeLock;
        if (maybeWakeLock) {
          wakeLockRef.current = await maybeWakeLock.request("screen");
        }
      } catch {
        // Wake Lock is optional.
      }

      await persistHistory(historyItem);
      setHistory((previous) => {
        const next = [...previous, historyItem];
        setActiveHistoryIdx(next.length - 1);
        return next;
      });

      let working = historyItem.prompts;
      for (let index = 0; index < working.length; index += 1) {
        if (imageCancelRequestedRef.current) {
          throw new ImageGenerationCancelledError();
        }
        setActivePromptIdx(index);
        working = working.map((item, itemIndex) =>
          itemIndex === index
            ? { ...item, status: "queued", error: undefined, updatedAt: Date.now() }
            : item,
        );
        historyItem = { ...historyItem, prompts: working };
        setPrompts(working);
        await persistHistory(historyItem);
        if (imageCancelRequestedRef.current) {
          throw new ImageGenerationCancelledError();
        }

        const task = await createImageTask(
          {
            prompt: working[index].prompt,
            size: resolvedSize,
            aspectRatio,
            quality,
            inputImages: generationImages,
          },
          imageAbortRef.current?.signal,
        );
        currentImageTaskIdRef.current = task.taskId;
        if (!task.unlimitedCredits && Number.isFinite(task.remainingCredits)) {
          setSession((previous) =>
            previous?.user
              ? {
                  ...previous,
                  user: {
                    ...previous.user,
                    remainingCredits: task.remainingCredits,
                    usedCredits: task.usedCredits,
                  },
                }
              : previous,
          );
        }

        working = working.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                status: "running",
                taskId: task.taskId,
                updatedAt: Date.now(),
              }
            : item,
        );
        historyItem = { ...historyItem, prompts: working };
        setPrompts(working);
        await persistHistory(historyItem);

        const result = await pollImageTask(task.taskId, undefined, imageAbortRef.current?.signal);
        if (imageCancelRequestedRef.current) {
          throw new ImageGenerationCancelledError();
        }
        if (result.status === "canceled") {
          throw new ImageGenerationCancelledError();
        }
        if (result.status === "failed") {
          const message = result.error || "任务执行失败";
          working = working.map((item, itemIndex) =>
            itemIndex === index
              ? { ...item, status: "failed", error: message, updatedAt: Date.now() }
              : item,
          );
          historyItem = { ...historyItem, prompts: working };
          setPrompts(working);
          await persistHistory(historyItem);
          throw new Error(message);
        }
        if (!result.unlimitedCredits && Number.isFinite(result.remainingCredits)) {
          setSession((previous) =>
            previous?.user
              ? {
                  ...previous,
                  user: {
                    ...previous.user,
                    remainingCredits: result.remainingCredits,
                    usedCredits: result.usedCredits,
                  },
                }
              : previous,
          );
        }

        working = working.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                status: "succeeded",
                imageId: undefined,
                base64: result.base64,
                model: result.model,
                updatedAt: Date.now(),
              }
            : item,
        );
        historyItem = { ...historyItem, prompts: working };
        setPrompts(working);
        currentImageTaskIdRef.current = null;
        setHistory((previous) =>
          previous.map((item) => (item.id === historyItem.id ? historyItem : item)),
        );
        await persistHistory(historyItem);
      }
    } catch (event) {
      if (
        event instanceof ImageGenerationCancelledError ||
        (event instanceof DOMException && event.name === "AbortError")
      ) {
        historyItem = { ...historyItem, prompts: resetActiveGenerationPrompts(historyItem.prompts) };
        setPrompts(historyItem.prompts);
        setHistory((previous) =>
          previous.map((item) => (item.id === historyItem.id ? historyItem : item)),
        );
        await persistHistory(historyItem);
      } else {
        setError(event instanceof Error ? event.message : String(event));
      }
    } finally {
      imageAbortRef.current = null;
      imageCancelRequestedRef.current = false;
      currentImageTaskIdRef.current = null;
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => undefined);
        wakeLockRef.current = null;
      }
      setImageBusy(false);
    }
  }, [
    aspectRatio,
    currentProduct,
    persistHistory,
    productImages,
    prompts,
    quality,
    resolvedSize,
    validateProduct,
  ]);

  const handleRegenerateActiveImage = useCallback(async () => {
    setError(null);
    if (!validateProduct()) return;
    if (!prompts.length) {
      setError("请先生成详情图文案。");
      return;
    }
    const targetIndex = Math.min(Math.max(activePromptIdx, 0), prompts.length - 1);
    const target = prompts[targetIndex];
    if (!target?.prompt.trim()) {
      setError("当前详情图文案不能为空，请检查后再重新生成。");
      return;
    }

    setImageBusy(true);
    imageCancelRequestedRef.current = false;
    imageAbortRef.current = new AbortController();

    let historyItem: HistoryItem = history[activeHistoryIdx]
      ? {
          ...history[activeHistoryIdx],
          product: cloneProduct(currentProduct),
          prompts: prompts.map(resetInterruptedPrompt),
          timestamp: Date.now(),
          generation: {
            aspectRatio,
            quality,
            size: resolvedSize,
          },
        }
      : {
          product: cloneProduct(currentProduct),
          prompts: prompts.map(resetInterruptedPrompt),
          timestamp: Date.now(),
          generation: {
            aspectRatio,
            quality,
            size: resolvedSize,
          },
    };

    try {
      const generationImages = await getPromptReadyImages(productImages);
      try {
        const maybeWakeLock = (
          navigator as Navigator & {
            wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
          }
        ).wakeLock;
        if (maybeWakeLock) {
          wakeLockRef.current = await maybeWakeLock.request("screen");
        }
      } catch {
        // Wake Lock is optional.
      }

      await persistHistory(historyItem);
      setHistory((previous) => {
        if (historyItem.id == null) return previous;
        const existingIndex = previous.findIndex((item) => item.id === historyItem.id);
        if (existingIndex >= 0) {
          const next = [...previous];
          next[existingIndex] = historyItem;
          setActiveHistoryIdx(existingIndex);
          return next;
        }
        const next = [...previous, historyItem];
        setActiveHistoryIdx(next.length - 1);
        return next;
      });

      let working = historyItem.prompts;
      if (imageCancelRequestedRef.current) {
        throw new ImageGenerationCancelledError();
      }

      setActivePromptIdx(targetIndex);
      working = working.map((item, itemIndex) =>
        itemIndex === targetIndex
          ? {
              ...item,
              status: "queued",
              imageId: undefined,
              base64: undefined,
              model: undefined,
              taskId: undefined,
              error: undefined,
              updatedAt: Date.now(),
            }
          : item,
      );
      historyItem = { ...historyItem, prompts: working };
      setPrompts(working);
      await persistHistory(historyItem);

      if (imageCancelRequestedRef.current) {
        throw new ImageGenerationCancelledError();
      }

      const task = await createImageTask(
        {
          prompt: working[targetIndex].prompt,
          size: resolvedSize,
          aspectRatio,
          quality,
          inputImages: generationImages,
        },
        imageAbortRef.current?.signal,
      );
      currentImageTaskIdRef.current = task.taskId;
      if (!task.unlimitedCredits && Number.isFinite(task.remainingCredits)) {
        setSession((previous) =>
          previous?.user
            ? {
                ...previous,
                user: {
                  ...previous.user,
                  remainingCredits: task.remainingCredits,
                  usedCredits: task.usedCredits,
                },
              }
            : previous,
        );
      }

      working = working.map((item, itemIndex) =>
        itemIndex === targetIndex
          ? {
              ...item,
              status: "running",
              taskId: task.taskId,
              updatedAt: Date.now(),
            }
          : item,
      );
      historyItem = { ...historyItem, prompts: working };
      setPrompts(working);
      await persistHistory(historyItem);

      const result = await pollImageTask(task.taskId, undefined, imageAbortRef.current?.signal);
      if (imageCancelRequestedRef.current || result.status === "canceled") {
        throw new ImageGenerationCancelledError();
      }
      if (result.status === "failed") {
        const message = result.error || "任务执行失败";
        working = working.map((item, itemIndex) =>
          itemIndex === targetIndex
            ? { ...item, status: "failed", error: message, updatedAt: Date.now() }
            : item,
        );
        historyItem = { ...historyItem, prompts: working };
        setPrompts(working);
        setHistory((previous) =>
          previous.map((item) => (item.id === historyItem.id ? historyItem : item)),
        );
        await persistHistory(historyItem);
        throw new Error(message);
      }
      if (!result.unlimitedCredits && Number.isFinite(result.remainingCredits)) {
        setSession((previous) =>
          previous?.user
            ? {
                ...previous,
                user: {
                  ...previous.user,
                  remainingCredits: result.remainingCredits,
                  usedCredits: result.usedCredits,
                },
              }
            : previous,
        );
      }

      working = working.map((item, itemIndex) =>
        itemIndex === targetIndex
          ? {
              ...item,
              status: "succeeded",
              imageId: undefined,
              base64: result.base64,
              model: result.model,
              taskId: undefined,
              error: undefined,
              updatedAt: Date.now(),
            }
          : item,
      );
      historyItem = { ...historyItem, prompts: working };
      setPrompts(working);
      currentImageTaskIdRef.current = null;
      setHistory((previous) =>
        previous.map((item) => (item.id === historyItem.id ? historyItem : item)),
      );
      await persistHistory(historyItem);
    } catch (event) {
      if (
        event instanceof ImageGenerationCancelledError ||
        (event instanceof DOMException && event.name === "AbortError")
      ) {
        historyItem = { ...historyItem, prompts: resetActiveGenerationPrompts(historyItem.prompts) };
        setPrompts(historyItem.prompts);
        setHistory((previous) =>
          previous.map((item) => (item.id === historyItem.id ? historyItem : item)),
        );
        await persistHistory(historyItem);
      } else {
        setError(event instanceof Error ? event.message : String(event));
      }
    } finally {
      imageAbortRef.current = null;
      imageCancelRequestedRef.current = false;
      currentImageTaskIdRef.current = null;
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => undefined);
        wakeLockRef.current = null;
      }
      setImageBusy(false);
    }
  }, [
    activeHistoryIdx,
    activePromptIdx,
    aspectRatio,
    currentProduct,
    history,
    persistHistory,
    productImages,
    prompts,
    quality,
    resolvedSize,
    validateProduct,
  ]);

  const handleCancelImageGeneration = useCallback(() => {
    if (!imageBusy) return;
    imageCancelRequestedRef.current = true;
    const taskId = currentImageTaskIdRef.current;
    if (taskId) {
      cancelImageTask(taskId).catch((event) => console.warn("取消图片任务失败:", event));
    }
    imageAbortRef.current?.abort();
  }, [imageBusy]);

  const handleSelectHistory = useCallback(
    (idx: number) => {
      const item = history[idx];
      if (!item) return;
      setActiveHistoryIdx(idx);
      setProductName(item.product.name);
      setSellingPoints(item.product.sellingPoints);
      setImageCount(Math.min(MAX_DETAIL_IMAGES, Math.max(1, item.product.imageCount)));
      setProductImageIds(item.product.productImageIds ?? []);
      setProductImages(item.product.productImages);
      if (item.product.productImageIds?.length) {
        dbGetProductImages(item.product.productImageIds)
          .then((images) => setProductImages(images.slice(0, 8)))
          .catch((event) => console.warn("产品参考图恢复失败:", event));
      }
      const nextPrompts = item.prompts.map(resetInterruptedPrompt);
      setPrompts(nextPrompts);
      if (item.generation?.aspectRatio && ASPECT_RATIO_VALUES.includes(item.generation.aspectRatio)) {
        setAspectRatio(item.generation.aspectRatio);
      }
      if (item.generation?.quality && IMAGE_QUALITY_VALUES.includes(item.generation.quality)) {
        setQuality(item.generation.quality);
      }
      setActivePromptIdx(0);
    },
    [history],
  );

  const handleDeleteHistory = useCallback((idx: number) => {
    setHistory((previous) => {
      const item = previous[idx];
      if (!item) return previous;
      if (item.id != null) {
        dbDel(item.id).catch((event) => console.warn(event));
      }
      const next = previous.filter((_, index) => index !== idx);
      setActiveHistoryIdx((current) => {
        if (current === idx) return next.length ? Math.min(idx, next.length - 1) : -1;
        if (current > idx) return current - 1;
        return current;
      });
      return next;
    });
  }, []);

  const handleClearHistory = useCallback(async () => {
    if (!confirm("确定清空所有商品详情图历史？此操作不可撤销。")) return;
    try {
      await dbClear();
    } catch (event) {
      console.warn(event);
    }
    setHistory([]);
    setActiveHistoryIdx(-1);
  }, []);

  const handleAccessLogin = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = accessCode.trim();
    if (!code) {
      setError("请输入访问码。");
      return;
    }

    setError(null);
    setAccessBusy(true);
    try {
      const response = await fetch("/api/auth/login/access", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });
      const payload = (await response.json().catch(() => null)) as
        | AuthSession
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : `HTTP ${response.status}`,
        );
      }
      setSession(payload as AuthSession);
      setAccessCode("");
      setAuthPopoverOpen(false);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setAccessBusy(false);
    }
  }, [accessCode]);

  const handleRedeemCode = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = redeemCode.trim();
    if (!code) {
      setRedeemMessage("请输入兑换码。");
      return;
    }

    setError(null);
    setRedeemMessage(null);
    setRedeemBusy(true);
    try {
      const payload = await redeemCredits(code);
      setSession((previous) =>
        previous
          ? {
              ...previous,
              authenticated: true,
              user: payload.user,
            }
          : { authenticated: true, user: payload.user },
      );
      setRedeemCode("");
      setRedeemMessage(`已增加 ${payload.grantedCredits} 张图片生成机会。`);
    } catch (event) {
      setRedeemMessage(event instanceof Error ? event.message : String(event));
    } finally {
      setRedeemBusy(false);
    }
  }, [redeemCode]);

  const handleDownload = useCallback(
    (index: number) => {
      const imageSrc = getPromptImageSrc(prompts[index]);
      if (!imageSrc) return;
      const anchor = document.createElement("a");
      anchor.href = imageSrc;
      anchor.download = `ecom-detail-${productName || "product"}-${index + 1}.png`;
      anchor.click();
    },
    [productName, prompts],
  );

  const authenticated = !!session?.authenticated;
  const authLabel = authenticated
    ? `${session?.user?.name || "已登录用户"} 账户菜单`
    : "打开登录菜单";
  const controlsDisabled =
    sessionLoading || accessBusy || redeemBusy || promptBusy || imageBusy || !authenticated;
  const providerLabel =
    session?.user?.provider === "github"
      ? "GitHub"
      : session?.user?.provider === "google"
        ? "Google"
        : "访问码";
  const authRedirectPath = studioMode === "cutout" ? "/cutout/" : "/image/";
  const isAdmin =
    session?.user?.role === "admin" || session?.user?.role === "super_admin";
  const isSuperAdmin = session?.user?.role === "super_admin";
  const creditLabel = authenticated
    ? isSuperAdmin
      ? "不限次数"
      : `${session?.user?.remainingCredits ?? 0} 张可用`
    : "未登录";
  const showUserImage = !!(
    authenticated &&
    session?.user?.image &&
    !avatarFailed
  );
  const activePromptIndex = prompts.length
    ? Math.min(Math.max(activePromptIdx, 0), prompts.length - 1)
    : 0;
  const activePrompt = prompts[activePromptIndex] ?? null;

  return (
    <main className="app-shell">
      <header className="studio-topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="brand" />
          </span>
          <div>
            <h1>EcomImgGen</h1>
            <p className="tagline">Image Studio</p>
          </div>
        </div>

        <nav className="creative-tabs" aria-label="创作类型">
          <a href="/" className="creative-tab" onClick={handleHomeLinkClick}>
            <Icon name="brand" />
            <span>首页</span>
          </a>
          <button type="button" className="creative-tab" disabled>
            <Icon name="image" />
            <span>主图</span>
          </button>
          <a
            href="/image/"
            className={`creative-tab${studioMode === "image" ? " is-active" : ""}`}
            aria-current={studioMode === "image" ? "page" : undefined}
            onClick={(event) => handleModuleLinkClick(event, "image")}
          >
            <Icon name="spark" />
            <span>详情图</span>
          </a>
          <a
            href="/cutout/"
            className={`creative-tab${studioMode === "cutout" ? " is-active" : ""}`}
            aria-current={studioMode === "cutout" ? "page" : undefined}
            onClick={(event) => handleModuleLinkClick(event, "cutout")}
          >
            <Icon name="cutout" />
            <span>抠图</span>
          </a>
          <button type="button" className="creative-tab" disabled>
            <Icon name="queue" />
            <span>多视角</span>
          </button>
          <button type="button" className="creative-tab" disabled>
            <Icon name="text" />
            <span>分层</span>
          </button>
          <button type="button" className="creative-tab" disabled>
            <Icon name="video" />
            <span>视频</span>
          </button>
        </nav>

        <div className="top-actions">
          <div className="auth-popover-wrap" ref={authPopoverRef}>
            <button
              type="button"
              className={`auth-toggle${authPopoverOpen ? " is-open" : ""}${authenticated ? " is-authenticated" : " is-guest"}`}
              onClick={() => setAuthPopoverOpen((value) => !value)}
              aria-label={authLabel}
              aria-expanded={authPopoverOpen}
              aria-haspopup="dialog"
              title={authenticated ? session?.user?.name || "账户" : "登录"}
            >
              {showUserImage && session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt={session.user.name}
                  className="auth-toggle-avatar"
                  onError={() => setAvatarFailed(true)}
                />
              ) : (
                <Icon name="user" className="auth-toggle-icon" />
              )}
            </button>

            {authPopoverOpen && (
              <div className="auth-popover" role="dialog" aria-label="登录菜单">
                {sessionLoading ? (
                  <p className="auth-popover-note">正在检查登录状态...</p>
                ) : authenticated && session?.user ? (
                  <>
                    <div className="auth-popover-user">
                      {showUserImage && session.user.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={session.user.image}
                          alt={session.user.name}
                          className="auth-avatar"
                          onError={() => setAvatarFailed(true)}
                        />
                      ) : (
                        <div className="auth-avatar auth-avatar-fallback">
                          {session.user.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div>
                      <p className="auth-name">{session.user.name}</p>
                      <p className="auth-meta">
                          {providerLabel}
                          {session.user.email ? ` · ${session.user.email}` : ""}
                      </p>
                      </div>
                    </div>
                    <div className="account-stats">
                      <span>{isSuperAdmin ? "不限次数" : `剩余 ${session.user.remainingCredits ?? 0} 张`}</span>
                      <span>已用 {session.user.usedCredits ?? 0} 张</span>
                    </div>
                    {!isSuperAdmin && (
                      <form className="redeem-form" onSubmit={handleRedeemCode}>
                        <label htmlFor="redeem-code-popover">兑换码</label>
                        <div className="redeem-form-row">
                          <input
                            id="redeem-code-popover"
                            name="redeemCode"
                            type="text"
                            value={redeemCode}
                            onChange={(event) => setRedeemCode(event.target.value)}
                            placeholder="输入兑换码增加图片张数"
                            aria-label="兑换码"
                            autoComplete="one-time-code"
                            disabled={redeemBusy}
                          />
                          <button className="btn-ghost" type="submit" disabled={redeemBusy}>
                            {redeemBusy && <span className="btn-spinner" aria-hidden="true" />}
                            {redeemBusy ? "兑换中" : "兑换"}
                          </button>
                        </div>
                        {redeemMessage && <p className="redeem-message">{redeemMessage}</p>}
                      </form>
                    )}
                    {isAdmin && (
                      <button
                        className="btn-secondary auth-popover-link"
                        type="button"
                        onClick={() => {
                          setAdminOpen(true);
                          setAuthPopoverOpen(false);
                        }}
                      >
                        后台管理
                      </button>
                    )}
                    <a
                      className="btn-ghost auth-link auth-popover-link"
                      href={`/api/auth/logout?redirectTo=${encodeURIComponent(authRedirectPath)}`}
                    >
                      退出登录
                    </a>
                  </>
                ) : (
                  <>
                    <p className="auth-popover-note">登录后才能生成详情图文案和商品详情图。</p>
                    <form className="access-form access-form-compact" onSubmit={handleAccessLogin}>
                      <label className="sr-only" htmlFor="access-code-popover-username">用户名</label>
                      <input
                        id="access-code-popover-username"
                        className="sr-only"
                        name="username"
                        type="text"
                        aria-label="用户名"
                        value="access-code"
                        readOnly
                        tabIndex={-1}
                        autoComplete="username"
                      />
                      <label className="sr-only" htmlFor="access-code-popover">访问码</label>
                      <input
                        id="access-code-popover"
                        name="accessCode"
                        type="password"
                        value={accessCode}
                        onChange={(event) => setAccessCode(event.target.value)}
                        placeholder="访问码"
                        aria-label="访问码"
                        autoComplete="current-password"
                      />
                      <button className="btn-primary" type="submit" disabled={accessBusy}>
                        {accessBusy ? "登录中..." : "访问码登录"}
                      </button>
                    </form>
                    <a
                      className="btn-ghost auth-link auth-popover-link"
                      href={`/api/auth/login/github?redirectTo=${encodeURIComponent(authRedirectPath)}`}
                    >
                      使用 GitHub 登录
                    </a>
                    <a
                      className="btn-ghost auth-link auth-popover-link"
                      href={`/api/auth/login/google?redirectTo=${encodeURIComponent(authRedirectPath)}`}
                    >
                      使用 Google 登录
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {studioMode === "image" ? (
        <>
      <div className="run-status" aria-label="当前任务状态">
        <span>{prompts.length ? `${prompts.length} 条文案` : "文案未生成"}</span>
        <span>{productImages.length ? `${productImages.length} 张参考图` : "未上传参考图"}</span>
        <span>{creditLabel}</span>
        <span>{generationLabel}</span>
        <span>{imageBusy ? "生成中" : "待命"}</span>
      </div>

      <div className="studio-grid">
        <aside className="studio-panel input-rail">
          <div className="panel-heading">
            <h2>产品资料</h2>
            <button
              type="button"
              className="inline-action panel-reset-action"
              disabled={promptBusy || imageBusy}
              onClick={handleResetProductInput}
            >
              重置
            </button>
          </div>

          <div className="input-rail-body">
            <div className="form-grid">
              <div>
                <label htmlFor="product-name">产品名称</label>
                <input
                  id="product-name"
                  type="text"
                  value={productName}
                  disabled={controlsDisabled}
                  placeholder="例如：玻尿酸修护精华"
                  onChange={(event) => setProductName(event.target.value)}
                />
              </div>
            </div>

            <label htmlFor="selling-points">核心卖点/功效</label>
            <textarea
              id="selling-points"
              className="selling-points"
              value={sellingPoints}
              disabled={controlsDisabled}
              placeholder="输入核心卖点、适用人群、规格信息、购买理由"
              onChange={(event) => setSellingPoints(event.target.value)}
            />

            <div className="field-row-head">
              <label htmlFor="product-images">产品参考图</label>
              {productImages.length > 0 && (
                <button
                  type="button"
                  className="inline-action"
                  disabled={controlsDisabled}
                  onClick={() => {
                    setProductImages([]);
                    setProductImageIds([]);
                  }}
                >
                  清空
                </button>
              )}
            </div>
            <div className="product-media">
              {productImages.map((src, index) => (
                <div className="prompt-thumb" key={`${src.slice(0, 32)}-${index}`}>
                  <button
                    type="button"
                    className="prompt-thumb-preview"
                    onClick={() => setLightboxSrc(src)}
                    aria-label={`查看产品图 ${index + 1}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`产品图 ${index + 1}`} />
                  </button>
                  <button
                    type="button"
                    className="prompt-thumb-del"
                    disabled={controlsDisabled}
                    onClick={() => {
                      setProductImages((previous) => previous.filter((_, i) => i !== index));
                      setProductImageIds((previous) => previous.filter((_, i) => i !== index));
                    }}
                    aria-label={`移除产品图 ${index + 1}`}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="prompt-upload-tile"
                disabled={controlsDisabled}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="upload" />
                <span>上传</span>
              </button>
            </div>
            <input
              id="product-images"
              name="productImages"
              ref={fileInputRef}
              type="file"
              aria-label="上传产品参考图"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => handleSelectFiles(event.target.files)}
            />

            <div className="settings-row">
              <div className="setting-block">
                <div className="setting-head">
                  <label>张数</label>
                  <span>{imageCount} 张</span>
                </div>
                <div className="param-controls" aria-label="详情图张数">
                  <ImageCountSelector
                    value={imageCount}
                    onChange={setImageCount}
                    disabled={controlsDisabled}
                  />
                </div>
              </div>
              <div className="setting-block">
                <div className="setting-head">
                  <label>画面比例</label>
                  <span>{aspectRatio === "auto" ? "Auto" : aspectRatio}</span>
                </div>
                <div className="param-controls" aria-label="画面比例">
                  <AspectRatioSelector
                    value={aspectRatio}
                    onChange={setAspectRatio}
                    disabled={controlsDisabled}
                  />
                </div>
              </div>
              <div className="setting-block">
                <div className="setting-head">
                  <label>清晰度</label>
                  <span>{quality}</span>
                </div>
                <div className="param-controls" aria-label="清晰度">
                  <QualitySelector
                    value={quality}
                    onChange={setQuality}
                    disabled={controlsDisabled}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="input-action-bar">
            <button
              type="button"
              className="btn-primary"
              disabled={controlsDisabled}
              onClick={handleGeneratePrompts}
            >
              {promptBusy && <span className="btn-spinner" aria-hidden="true" />}
              {promptBusy ? "正在生成文案..." : "生成详情图文案"}
            </button>
            {error && <div className="alert">{error}</div>}
          </div>
        </aside>

        <aside className="studio-panel prompt-rail">
          <div className="panel-heading">
            <h2>详情图文案</h2>
            <span className="panel-count">
              {activePrompt ? `${activePromptIndex + 1} / ${prompts.length}` : `${prompts.length} 条`}
            </span>
          </div>
          <div className="prompt-editor-list">
            {promptBusy ? (
              <div className="busy-card">
                <span className="busy-orbit" aria-hidden="true" />
                <strong>正在生成详情图文案</strong>
                <p>系统正在分析产品资料和参考图。</p>
              </div>
            ) : !activePrompt ? (
              <div className="empty">生成详情图文案后可在这里逐条修改。</div>
            ) : (
              <>
                <div className="prompt-switcher" aria-label="详情图文案切换">
                  <button
                    type="button"
                    className="prompt-nav-btn"
                    disabled={activePromptIndex === 0}
                    onClick={() => setActivePromptIdx(Math.max(0, activePromptIndex - 1))}
                  >
                    上一张
                  </button>
                  <div className="prompt-step-list" role="tablist" aria-label="切换详情图文案">
                    {prompts.map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={index === activePromptIndex}
                        className={`prompt-step${index === activePromptIndex ? " is-active" : ""}`}
                        onClick={() => setActivePromptIdx(index)}
                      >
                        <span>{index + 1}</span>
                        <span className={`prompt-step-status is-${item.status}`} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="prompt-nav-btn"
                    disabled={activePromptIndex >= prompts.length - 1}
                    onClick={() =>
                      setActivePromptIdx(Math.min(prompts.length - 1, activePromptIndex + 1))
                    }
                  >
                    下一张
                  </button>
                </div>

                <div
                  key={activePrompt.id}
                  className="prompt-editor prompt-editor-single is-active"
                >
                  <div className="prompt-editor-head">
                    <span className="prompt-index">{activePromptIndex + 1}</span>
                    <input
                      aria-label={`详情图 ${activePromptIndex + 1} 标题`}
                      type="text"
                      value={activePrompt.title}
                      disabled={imageBusy}
                      onChange={(event) => handleTitleChange(activePrompt.id, event.target.value)}
                    />
                    <span className={`status-pill is-${activePrompt.status}`}>
                      {STATUS_LABEL[activePrompt.status]}
                    </span>
                  </div>
                  <textarea
                    aria-label={`详情图 ${activePromptIndex + 1} 文案`}
                    value={activePrompt.prompt}
                    disabled={imageBusy}
                    onChange={(event) => handlePromptChange(activePrompt.id, event.target.value)}
                  />
                </div>
              </>
            )}
          </div>
          <div className="prompt-action-bar">
            <div className="generation-action-row">
              <button
                type="button"
                className="btn-secondary"
                disabled={controlsDisabled || !prompts.length}
                onClick={handleGenerateImages}
              >
                {imageBusy && <span className="btn-spinner" aria-hidden="true" />}
                {imageBusy ? "正在逐张生成..." : "批量生成详情图"}
              </button>
              {!imageBusy && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={controlsDisabled || !activePrompt?.prompt.trim()}
                  onClick={handleRegenerateActiveImage}
                >
                  重新生成当前图
                </button>
              )}
              {imageBusy && (
                <button
                  type="button"
                  className="btn-danger cancel-generation-btn"
                  onClick={handleCancelImageGeneration}
                >
                  中断生成
                </button>
              )}
            </div>
          </div>
        </aside>

        <section className="studio-panel canvas-panel">
          <div className="panel-heading">
            <h2>详情图预览</h2>
            <span className="panel-count">{generationLabel}</span>
          </div>
          <Stage
            prompts={prompts}
            activeIndex={activePromptIndex}
            busy={imageBusy}
            error={null}
            onSelect={(index) => {
              setActivePromptIdx(index);
            }}
            onDownload={handleDownload}
            onZoom={(index) => {
              const imageSrc = getPromptImageSrc(prompts[index]);
              if (imageSrc) setLightboxSrc(imageSrc);
            }}
          />
        </section>
      </div>

      <section className="studio-panel history-dock">
        <HistoryGrid
          history={history}
          activeIdx={activeHistoryIdx}
          onSelect={handleSelectHistory}
          onDelete={handleDeleteHistory}
          onClearAll={handleClearHistory}
        />
      </section>
        </>
      ) : (
        <CutoutStudio
          authenticated={authenticated}
          sessionLoading={sessionLoading}
          session={session}
          setSession={setSession}
          onZoom={setLightboxSrc}
        />
      )}

      <footer>
        EcomImgGen · 历史记录云端同步 · GitHub
        <a
          className="github-link"
          href="https://github.com/dming519/ecom-img-gen"
          target="_blank"
          rel="noreferrer"
          aria-label="查看 GitHub 仓库"
          title="查看 GitHub 仓库"
        >
          GH
        </a>
      </footer>

      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      <AdminPanel open={adminOpen} onClose={() => setAdminOpen(false)} />
    </main>
  );
}
