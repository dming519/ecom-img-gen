"use client";

import {
  type Dispatch,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  cancelCutoutTask,
  createCutoutTask,
  pollCutoutTask,
} from "@/lib/api";
import {
  dbAddCutout,
  dbAllCutouts,
  dbClearCutouts,
  dbDelCutout,
  dbGetCutoutDraft,
  dbGetProductImages,
  dbPutCutout,
  dbPutCutoutDraft,
  dbPutProductImage,
} from "@/lib/db";
import type { AuthSession, CutoutDraft, CutoutHistoryItem } from "@/lib/types";
import Icon from "./Icon";

const MAX_CUTOUT_IMAGE_BYTES = 10 * 1024 * 1024;
const CANVAS_EDGE = 960;
const MASK_HISTORY_LIMIT = 18;

type PaintMode = "brush" | "eraser";

declare global {
  interface Window {
    ecomImgGenFlushCutoutDraft?: () => Promise<void>;
  }
}

interface CutoutStudioProps {
  authenticated: boolean;
  sessionLoading: boolean;
  session: AuthSession | null;
  setSession: Dispatch<SetStateAction<AuthSession | null>>;
  onZoom: (src: string) => void;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getPointerPoint(
  event: ReactPointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function getCursorPreviewPoint(
  event: ReactPointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
) {
  const stage = canvas.parentElement;
  const rect = stage?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function drawMaskCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  mode: PaintMode,
) {
  ctx.save();
  ctx.globalCompositeOperation = mode === "eraser" ? "destination-out" : "source-over";
  ctx.fillStyle = "rgba(23,105,255,0.72)";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function hasMaskPixels(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 8) return true;
  }
  return false;
}

export default function CutoutStudio({
  authenticated,
  sessionLoading,
  session,
  setSession,
  onZoom,
}: CutoutStudioProps) {
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [sourceImageId, setSourceImageId] = useState<string | undefined>();
  const [resultImageId, setResultImageId] = useState<string | undefined>();
  const [resultBase64, setResultBase64] = useState<string | null>(null);
  const [history, setHistory] = useState<CutoutHistoryItem[]>([]);
  const [activeHistoryIdx, setActiveHistoryIdx] = useState(-1);
  const [brushSize, setBrushSize] = useState(34);
  const [mode, setMode] = useState<PaintMode>("brush");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [maskDirty, setMaskDirty] = useState(false);
  const [historyStack, setHistoryStack] = useState<string[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [cursorPreview, setCursorPreview] = useState({
    visible: false,
    x: 0,
    y: 0,
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const pendingMaskRef = useRef<string | null>(null);
  const pendingCanvasZoomRef = useRef<number | null>(null);

  const remainingCredits = session?.user?.remainingCredits ?? 0;
  const isSuperAdmin = session?.user?.role === "super_admin";
  const controlsDisabled = sessionLoading || busy || !authenticated;

  const redrawSource = useCallback((dataUrl: string) => {
    const imageCanvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!imageCanvas || !maskCanvas) return;

    const image = new Image();
    image.onload = () => {
      const scale = Math.min(
        1,
        CANVAS_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      imageCanvas.width = width;
      imageCanvas.height = height;
      maskCanvas.width = width;
      maskCanvas.height = height;
      setCanvasSize({ width, height });
      setCanvasZoom(pendingCanvasZoomRef.current ?? 1);
      pendingCanvasZoomRef.current = null;
      const ctx = imageCanvas.getContext("2d");
      const maskCtx = maskCanvas.getContext("2d");
      if (!ctx || !maskCtx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      maskCtx.clearRect(0, 0, width, height);
      const pendingMask = pendingMaskRef.current;
      if (pendingMask) {
        const maskImage = new Image();
        maskImage.onload = () => {
          maskCtx.clearRect(0, 0, width, height);
          maskCtx.drawImage(maskImage, 0, 0, width, height);
          setMaskDirty(hasMaskPixels(maskCanvas));
          pendingMaskRef.current = null;
        };
        maskImage.src = pendingMask;
      } else {
        setMaskDirty(false);
      }
      setCanvasReady(true);
      setHistoryStack([]);
    };
    image.onerror = () => setError("图片读取失败，请重新上传。");
    image.src = dataUrl;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await dbAllCutouts();
        if (cancelled) return;
        setHistory(items);
        if (items.length) setActiveHistoryIdx(items.length - 1);
      } catch (event) {
        console.warn("抠图历史读取失败:", event);
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
        const draft = await dbGetCutoutDraft();
        if (cancelled || !draft) return;
        setBrushSize(clamp(Number(draft.brushSize ?? 34), 12, 96));
        setMode(draft.mode === "eraser" ? "eraser" : "brush");
        setResultImageId(draft.resultImageId);
        setResultBase64(draft.resultBase64 ?? null);
        const [sourceImages, maskImages] = await Promise.all([
          draft.sourceImageId ? dbGetProductImages([draft.sourceImageId]) : Promise.resolve([]),
          draft.maskImageId ? dbGetProductImages([draft.maskImageId]) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        pendingMaskRef.current = maskImages[0] ?? null;
        pendingCanvasZoomRef.current = clamp(Number(draft.canvasZoom ?? 1), 0.45, 2.2);
        if (sourceImages[0]) {
          setSourceImageId(draft.sourceImageId);
          setSourceImage(sourceImages[0]);
        }
      } catch (event) {
        console.warn("抠图草稿恢复失败:", event);
      } finally {
        if (!cancelled) setDraftLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (sourceImage) redrawSource(sourceImage);
  }, [redrawSource, sourceImage]);

  const persistCurrentDraft = useCallback(
    async (
      overrides: Partial<Omit<CutoutDraft, "id" | "updatedAt">> = {},
    ) => {
      if (!draftLoaded) return;
      const hasMaskOverride = Object.prototype.hasOwnProperty.call(overrides, "maskImageId");
      let maskImageId = overrides.maskImageId;
      const maskCanvas = maskCanvasRef.current;
      if (!hasMaskOverride && maskCanvas && hasMaskPixels(maskCanvas)) {
        maskImageId = await dbPutProductImage(maskCanvas.toDataURL("image/png"));
      }
      const hasResultOverride = Object.prototype.hasOwnProperty.call(overrides, "resultBase64");
      const hasResultImageOverride = Object.prototype.hasOwnProperty.call(overrides, "resultImageId");
      const nextSourceImageId = overrides.sourceImageId ?? sourceImageId;
      const nextResultBase64 = hasResultOverride ? overrides.resultBase64 : resultBase64;
      const nextResultImageId = hasResultImageOverride ? overrides.resultImageId : resultImageId;
      if (!nextSourceImageId && !maskImageId && !nextResultBase64) return;
      try {
        const draft = {
          sourceImageId: nextSourceImageId,
          maskImageId,
          resultImageId: nextResultBase64 ? nextResultImageId : undefined,
          resultBase64: nextResultBase64,
          brushSize: overrides.brushSize ?? brushSize,
          mode: overrides.mode ?? mode,
          canvasZoom: overrides.canvasZoom ?? canvasZoom,
          updatedAt: Date.now(),
        };
        await dbPutCutoutDraft(draft);
        setResultImageId(draft.resultImageId);
      } catch (event) {
        console.warn("抠图草稿保存失败:", event);
      }
    },
    [brushSize, canvasZoom, draftLoaded, mode, resultBase64, resultImageId, sourceImageId],
  );

  useEffect(() => {
    window.ecomImgGenFlushCutoutDraft = persistCurrentDraft;
    return () => {
      if (window.ecomImgGenFlushCutoutDraft === persistCurrentDraft) {
        delete window.ecomImgGenFlushCutoutDraft;
      }
    };
  }, [persistCurrentDraft]);

  const persistCutout = useCallback(async (item: CutoutHistoryItem) => {
    try {
      if (item.id == null) {
        const id = await dbAddCutout(item);
        item.id = id as number;
      } else {
        await dbPutCutout(item);
      }
    } catch (event) {
      console.warn("抠图历史写入失败:", event);
    }
  }, []);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("请上传图片文件。");
      return;
    }
    if (file.size > MAX_CUTOUT_IMAGE_BYTES) {
      setError("图片过大，请上传 10MB 以内的图片。");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      const id = await dbPutProductImage(dataUrl);
      pendingMaskRef.current = null;
      pendingCanvasZoomRef.current = null;
      setSourceImage(dataUrl);
      setSourceImageId(id);
      setResultImageId(undefined);
      setResultBase64(null);
      setCanvasZoom(1);
      setActiveHistoryIdx(-1);
      await dbPutCutoutDraft({
        sourceImageId: id,
        maskImageId: undefined,
        resultImageId: undefined,
        resultBase64: null,
        brushSize,
        mode,
        canvasZoom: 1,
        updatedAt: Date.now(),
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [brushSize, mode]);

  const pushMaskHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    setHistoryStack((previous) =>
      [...previous, maskCanvas.toDataURL("image/png")].slice(-MASK_HISTORY_LIMIT),
    );
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = maskCanvasRef.current;
      if (!canvas || controlsDisabled || !sourceImage) return;
      event.preventDefault();
      pushMaskHistory();
      drawingRef.current = true;
      canvas.setPointerCapture(event.pointerId);
      const point = getPointerPoint(event, canvas);
      lastPointRef.current = point;
      setCursorPreview({
        visible: true,
        ...getCursorPreviewPoint(event, canvas),
      });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawMaskCircle(ctx, point.x, point.y, brushSize / 2, mode);
      setMaskDirty(hasMaskPixels(canvas));
    },
    [brushSize, controlsDisabled, mode, pushMaskHistory, sourceImage],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = maskCanvasRef.current;
      if (!canvas || controlsDisabled || !sourceImage) return;
      event.preventDefault();
      setCursorPreview({
        visible: true,
        ...getCursorPreviewPoint(event, canvas),
      });
      if (!drawingRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const next = getPointerPoint(event, canvas);
      const last = lastPointRef.current ?? next;
      const distance = Math.hypot(next.x - last.x, next.y - last.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(4, brushSize / 4)));
      for (let index = 0; index <= steps; index += 1) {
        const progress = index / steps;
        drawMaskCircle(
          ctx,
          last.x + (next.x - last.x) * progress,
          last.y + (next.y - last.y) * progress,
          brushSize / 2,
          mode,
        );
      }
      lastPointRef.current = next;
      setMaskDirty(hasMaskPixels(canvas));
    },
    [brushSize, controlsDisabled, mode, sourceImage],
  );

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = maskCanvasRef.current;
      if (!canvas || controlsDisabled || !sourceImage) return;
      setCursorPreview({
        visible: true,
        ...getCursorPreviewPoint(event, canvas),
      });
    },
    [controlsDisabled, sourceImage],
  );

  const finishDrawing = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const wasDrawing = drawingRef.current;
      const canvas = maskCanvasRef.current;
      if (canvas && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      drawingRef.current = false;
      lastPointRef.current = null;
      if (wasDrawing) {
        persistCurrentDraft().catch((draftError) =>
          console.warn("抠图草稿保存失败:", draftError),
        );
      }
    },
    [persistCurrentDraft],
  );

  const hideCursorPreview = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    finishDrawing(event);
    setCursorPreview((previous) => ({ ...previous, visible: false }));
  }, [finishDrawing]);

  const handleUndo = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    const last = historyStack.at(-1);
    if (!maskCanvas || !last) return;
    const image = new Image();
    image.onload = () => {
      const ctx = maskCanvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      ctx.drawImage(image, 0, 0, maskCanvas.width, maskCanvas.height);
      setMaskDirty(hasMaskPixels(maskCanvas));
      persistCurrentDraft().catch((draftError) =>
        console.warn("抠图草稿保存失败:", draftError),
      );
    };
    image.src = last;
    setHistoryStack((previous) => previous.slice(0, -1));
  }, [historyStack, persistCurrentDraft]);

  const handleClearMask = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;
    pushMaskHistory();
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    setMaskDirty(false);
    persistCurrentDraft({ maskImageId: undefined }).catch((draftError) =>
      console.warn("抠图草稿保存失败:", draftError),
    );
  }, [persistCurrentDraft, pushMaskHistory]);

  const exportMaskImage = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas || !hasMaskPixels(maskCanvas)) {
      throw new Error("请先涂抹需要抠出的产品区域。");
    }
    const output = document.createElement("canvas");
    output.width = maskCanvas.width;
    output.height = maskCanvas.height;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持生成 mask 图片。");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, output.width, output.height);
    const sourceCtx = maskCanvas.getContext("2d");
    if (!sourceCtx) throw new Error("浏览器不支持读取涂抹区域。");
    const sourcePixels = sourceCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const outputPixels = ctx.getImageData(0, 0, output.width, output.height);
    for (let index = 0; index < sourcePixels.data.length; index += 4) {
      if (sourcePixels.data[index + 3] > 8) {
        outputPixels.data[index] = 255;
        outputPixels.data[index + 1] = 255;
        outputPixels.data[index + 2] = 255;
        outputPixels.data[index + 3] = 255;
      }
    }
    ctx.putImageData(outputPixels, 0, 0);
    return output.toDataURL("image/png");
  }, []);

  const updateSessionCredits = useCallback(
    (result: { remainingCredits?: number; usedCredits?: number; unlimitedCredits?: boolean }) => {
      if (result.unlimitedCredits || !Number.isFinite(result.remainingCredits)) return;
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
    },
    [setSession],
  );

  const handleGenerate = useCallback(async () => {
    setError(null);
    if (!authenticated) {
      setError("请先登录后再使用抠图。");
      return;
    }
    if (!sourceImage) {
      setError("请先上传一张包含产品的图片。");
      return;
    }
    let apiMaskImage: string;
    try {
      apiMaskImage = exportMaskImage();
    } catch (maskError) {
      setError(maskError instanceof Error ? maskError.message : String(maskError));
      return;
    }

    setBusy(true);
    abortRef.current = new AbortController();
    let item: CutoutHistoryItem = {
      sourceImageId,
      sourceImage,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    try {
      const editorMaskImage = maskCanvasRef.current?.toDataURL("image/png");
      const maskImageId = editorMaskImage
        ? await dbPutProductImage(editorMaskImage)
        : undefined;
      item = { ...item, maskImageId, maskImage: editorMaskImage };
      await persistCurrentDraft({ maskImageId });
      await persistCutout(item);
      setHistory((previous) => {
        const next = [...previous, item];
        setActiveHistoryIdx(next.length - 1);
        return next;
      });

      const created = await createCutoutTask(
        { sourceImage, maskImage: apiMaskImage },
        abortRef.current.signal,
      );
      taskIdRef.current = created.taskId;
      updateSessionCredits(created);
      item = {
        ...item,
        taskId: created.taskId,
        status: "running",
        updatedAt: Date.now(),
      };
      await persistCutout(item);
      setHistory((previous) =>
        previous.map((historyItem) => (historyItem.id === item.id ? item : historyItem)),
      );

      const result = await pollCutoutTask(created.taskId, undefined, abortRef.current.signal);
      if (result.status === "canceled") {
        item = { ...item, status: "canceled", error: "抠图已中断", updatedAt: Date.now() };
        await persistCutout(item);
        setHistory((previous) =>
          previous.map((historyItem) => (historyItem.id === item.id ? item : historyItem)),
        );
        return;
      }
      if (result.status === "failed") {
        const message = result.error || "抠图失败";
        item = { ...item, status: "failed", error: message, updatedAt: Date.now() };
        await persistCutout(item);
        setHistory((previous) =>
          previous.map((historyItem) => (historyItem.id === item.id ? item : historyItem)),
        );
        setError(message);
        return;
      }
      updateSessionCredits(result);
      item = {
        ...item,
        status: "succeeded",
        taskId: undefined,
        error: undefined,
        model: result.model,
        resultImageId: undefined,
        resultBase64: result.base64,
        updatedAt: Date.now(),
      };
      setResultBase64(result.base64 ?? null);
      await persistCutout(item);
      setResultImageId(item.resultImageId);
      await persistCurrentDraft({
        resultImageId: item.resultImageId,
        resultBase64: result.base64 ?? null,
      });
      setHistory((previous) =>
        previous.map((historyItem) => (historyItem.id === item.id ? item : historyItem)),
      );
    } catch (generateError) {
      if (generateError instanceof DOMException && generateError.name === "AbortError") {
        item = { ...item, status: "canceled", error: "抠图已中断", updatedAt: Date.now() };
        await persistCutout(item);
      } else {
        const message =
          generateError instanceof Error ? generateError.message : String(generateError);
        item = { ...item, status: "failed", error: message, updatedAt: Date.now() };
        await persistCutout(item);
        setError(message);
      }
      setHistory((previous) =>
        previous.map((historyItem) => (historyItem.id === item.id ? item : historyItem)),
      );
    } finally {
      taskIdRef.current = null;
      abortRef.current = null;
      setBusy(false);
    }
  }, [
    authenticated,
    exportMaskImage,
    persistCurrentDraft,
    persistCutout,
    sourceImage,
    sourceImageId,
    updateSessionCredits,
  ]);

  const handleCancel = useCallback(() => {
    const taskId = taskIdRef.current;
    if (taskId) {
      cancelCutoutTask(taskId).catch((event) => console.warn("取消抠图任务失败:", event));
    }
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  const handleSelectHistory = useCallback(
    async (index: number) => {
      const item = history[index];
      if (!item) return;
      setActiveHistoryIdx(index);
      setResultImageId(item.resultImageId);
      setResultBase64(item.resultBase64 ?? null);
      setError(item.error ?? null);
      await dbPutCutoutDraft({
        sourceImageId: item.sourceImageId,
        maskImageId: item.maskImageId,
        resultImageId: item.resultImageId,
        resultBase64: item.resultBase64 ?? null,
        brushSize,
        mode,
        canvasZoom,
        updatedAt: Date.now(),
      });
      if (item.sourceImageId) {
        const [restored] = await dbGetProductImages([item.sourceImageId]);
        if (item.maskImageId) {
          const [restoredMask] = await dbGetProductImages([item.maskImageId]);
          pendingMaskRef.current = restoredMask ?? null;
        } else {
          pendingMaskRef.current = null;
        }
        if (restored) {
          setSourceImage(restored);
          setSourceImageId(item.sourceImageId);
        }
      }
    },
    [brushSize, canvasZoom, history, mode],
  );

  const handleDeleteHistory = useCallback((index: number) => {
    setHistory((previous) => {
      const item = previous[index];
      if (!item) return previous;
      if (item.id != null) {
        dbDelCutout(item.id).catch((event) => console.warn(event));
      }
      const next = previous.filter((_, itemIndex) => itemIndex !== index);
      setActiveHistoryIdx((current) => {
        if (current === index) return next.length ? Math.min(index, next.length - 1) : -1;
        if (current > index) return current - 1;
        return current;
      });
      return next;
    });
  }, []);

  const handleClearHistory = useCallback(async () => {
    if (!confirm("确定清空所有抠图历史？此操作不可撤销。")) return;
    await dbClearCutouts();
    setHistory([]);
    setActiveHistoryIdx(-1);
  }, []);

  const handleDownload = useCallback(() => {
    if (!resultBase64) return;
    const anchor = document.createElement("a");
    anchor.href = "data:image/png;base64," + resultBase64;
    anchor.download = `ecom-cutout-${Date.now()}.png`;
    anchor.click();
  }, [resultBase64]);

  const resultSrc = resultBase64 ? `data:image/png;base64,${resultBase64}` : null;
  const canvasStyle =
    canvasSize.width && canvasSize.height
      ? {
          width: `${Math.round(canvasSize.width * canvasZoom)}px`,
          height: `${Math.round(canvasSize.height * canvasZoom)}px`,
        }
      : undefined;

  return (
    <>
      <div className="run-status cutout-status" aria-label="抠图任务状态">
        <span>{sourceImage ? "原图已上传" : "等待上传"}</span>
        <span>{maskDirty ? "已涂抹区域" : "未涂抹"}</span>
        <span>{isSuperAdmin ? "不限次数" : `${remainingCredits} 张可用`}</span>
        <span>{busy ? "抠图中" : "待命"}</span>
      </div>

      <div className="cutout-grid">
        <aside className="studio-panel cutout-panel cutout-source-panel">
          <div className="panel-heading">
            <h2>产品原图</h2>
            <span className="panel-count">上传</span>
          </div>
          <div className="cutout-panel-body">
            <button
              type="button"
              className={`cutout-upload-zone${sourceImage ? " has-image" : ""}`}
              disabled={controlsDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              {sourceImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sourceImage} alt="待抠图产品原图" />
              ) : (
                <span>
                  <Icon name="upload" />
                  <strong>上传产品图片</strong>
                  <small>建议使用产品清晰、主体完整的图片</small>
                </span>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handleFileChange}
            />
            <div className="cutout-source-actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={controlsDisabled}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="upload" />
                更换图片
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={!sourceImage}
                onClick={() => sourceImage && onZoom(sourceImage)}
              >
                <Icon name="zoom" />
                查看原图
              </button>
            </div>
            <div className="cutout-help">
              <strong>操作逻辑</strong>
              <p>用画笔覆盖需要抠出的产品本体，系统会基于原图和涂抹区域生成白底产品图。</p>
            </div>
          </div>
          {error && <div className="alert cutout-alert">{error}</div>}
        </aside>

        <section className="studio-panel cutout-panel cutout-canvas-panel">
          <div className="panel-heading">
            <h2>涂抹区域</h2>
            <span className="panel-count">{brushSize}px</span>
          </div>
          <div className="cutout-toolbar">
            <div className="tool-segment">
              <button
                type="button"
                className={mode === "brush" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() => setMode("brush")}
              >
                <Icon name="brush" />
                画笔
              </button>
              <button
                type="button"
                className={mode === "eraser" ? "is-active" : ""}
                disabled={controlsDisabled}
                onClick={() => setMode("eraser")}
              >
                <Icon name="eraser" />
                橡皮
              </button>
            </div>
            <label className="brush-slider">
              <span>笔刷</span>
              <input
                type="range"
                min="12"
                max="96"
                value={brushSize}
                disabled={controlsDisabled}
                onChange={(event) => setBrushSize(clamp(Number(event.target.value), 12, 96))}
              />
            </label>
            <div className="cutout-toolbar-actions">
              <div className="cutout-zoom-actions" aria-label="画布缩放">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!sourceImage}
                  onClick={() => setCanvasZoom((value) => clamp(value - 0.15, 0.45, 2.2))}
                >
                  -
                </button>
                <span>{Math.round(canvasZoom * 100)}%</span>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!sourceImage}
                  onClick={() => setCanvasZoom((value) => clamp(value + 0.15, 0.45, 2.2))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!sourceImage || canvasZoom === 1}
                  onClick={() => setCanvasZoom(1)}
                >
                  复位
                </button>
              </div>
              <button
                type="button"
                className="btn-ghost"
                disabled={controlsDisabled || !historyStack.length}
                onClick={handleUndo}
              >
                <Icon name="undo" />
                撤销
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={controlsDisabled || !maskDirty}
                onClick={handleClearMask}
              >
                清空
              </button>
            </div>
          </div>
          <div className="cutout-canvas-wrap">
            <div
              className={`cutout-canvas-stage${sourceImage ? " has-image" : ""}${busy ? " is-busy" : ""}`}
            >
              <canvas ref={imageCanvasRef} aria-hidden="true" style={canvasStyle} />
              <canvas
                ref={maskCanvasRef}
                className="cutout-mask-canvas"
                style={canvasStyle}
                aria-label="涂抹需要抠出的产品区域"
                onPointerEnter={handlePointerEnter}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishDrawing}
                onPointerCancel={hideCursorPreview}
                onPointerLeave={hideCursorPreview}
              />
              {sourceImage && cursorPreview.visible && !busy && (
                <span
                  className={`cutout-brush-cursor is-${mode}`}
                  aria-hidden="true"
                  style={{
                    width: `${Math.max(10, brushSize * canvasZoom)}px`,
                    height: `${Math.max(10, brushSize * canvasZoom)}px`,
                    left: `${cursorPreview.x}px`,
                    top: `${cursorPreview.y}px`,
                  }}
                />
              )}
              {!sourceImage && (
                <div className="cutout-canvas-empty">
                  <Icon name="cutout" />
                  <span>上传图片后在这里涂抹产品</span>
                </div>
              )}
              {busy && (
                <div className="cutout-busy-layer">
                  <span className="busy-orbit" aria-hidden="true" />
                  <strong>正在抠图</strong>
                  <p>正在提取涂抹产品并补全遮挡部分。</p>
                </div>
              )}
            </div>
          </div>
          <div className="cutout-action-bar">
            {busy ? (
              <button type="button" className="btn-danger" onClick={handleCancel}>
                中断抠图
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={controlsDisabled || !sourceImage || !canvasReady || !maskDirty}
                onClick={handleGenerate}
              >
                <Icon name="cutout" />
                开始抠图
              </button>
            )}
          </div>
        </section>

        <section className="studio-panel cutout-panel cutout-result-panel">
          <div className="panel-heading">
            <h2>白底结果</h2>
            <span className="panel-count">{resultBase64 ? "已生成" : "预览"}</span>
          </div>
          <div className="cutout-result-stage">
            {resultSrc ? (
              <>
                <button
                  type="button"
                  className="cutout-result-image"
                  onClick={() => onZoom(resultSrc)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={resultSrc} alt="白底产品抠图结果" />
                </button>
                <div className="stage-actions">
                  <button type="button" className="btn-ghost" onClick={handleDownload}>
                    <Icon name="download" />
                    下载
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => onZoom(resultSrc)}>
                    <Icon name="zoom" />
                    放大
                  </button>
                </div>
              </>
            ) : (
              <div className="stage-placeholder cutout-result-empty">
                <Icon name="image" className="icon-large" />
                <div className="icon-hint">抠图结果会生成白底产品图</div>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="studio-panel history-dock cutout-history-dock">
        <div className="history-bar">
          <h2>抠图历史</h2>
          <button
            type="button"
            className="inline-action"
            disabled={!history.length}
            onClick={handleClearHistory}
          >
            清空历史
          </button>
        </div>
        {history.length ? (
          <div className="cutout-history-grid">
            {history.map((item, index) => {
              const result = item.resultBase64
                ? `data:image/png;base64,${item.resultBase64}`
                : null;
              return (
                <article
                  key={item.id ?? `${item.createdAt}-${index}`}
                  className={`cutout-history-card${index === activeHistoryIdx ? " is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="cutout-history-main"
                    onClick={() => handleSelectHistory(index)}
                  >
                    <div className="cutout-history-image">
                      {result ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={result} alt="抠图历史结果" />
                      ) : (
                        <span>{item.status === "failed" ? "失败" : "处理中"}</span>
                      )}
                    </div>
                    <div>
                      <strong>
                        {item.status === "succeeded"
                          ? "白底产品图"
                          : item.status === "failed"
                            ? "抠图失败"
                            : item.status === "canceled"
                              ? "已中断"
                              : "处理中"}
                      </strong>
                      <p>{item.error || "包含原图、涂抹区域和抠图结果。"}</p>
                      <small>{new Date(item.createdAt).toLocaleString()}</small>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="tile-del"
                    onClick={() => handleDeleteHistory(index)}
                    aria-label="删除抠图历史"
                  >
                    <Icon name="trash" />
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty">暂无抠图历史。</div>
        )}
      </section>
    </>
  );
}
