"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createImageTask, generateDetailPrompts, pollImageTask } from "@/lib/api";
import { dbAdd, dbAll, dbClear, dbDel, dbPut } from "@/lib/db";
import { DETAIL_PROMPT_TEMPLATE } from "@/lib/promptTemplate";
import type {
  AuthSession,
  DetailPromptItem,
  HistoryItem,
  ImageSize,
  ProductInput,
} from "@/lib/types";
import AdminPanel from "./AdminPanel";
import HistoryGrid from "./HistoryGrid";
import Icon from "./Icon";
import Lightbox from "./Lightbox";
import SizeSelector from "./SizeSelector";
import Stage from "./Stage";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DRAFT_KEY = "ecomimggen_draft";
type WakeLockSentinelLike = { release: () => Promise<void> };
const STATUS_LABEL: Record<DetailPromptItem["status"], string> = {
  draft: "待生成",
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
};

interface DraftState {
  productName: string;
  sellingPoints: string;
  imageCount: number;
  productImages: string[];
  prompts: DetailPromptItem[];
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
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

function cloneProduct(input: ProductInput): ProductInput {
  return {
    name: input.name,
    sellingPoints: input.sellingPoints,
    imageCount: input.imageCount,
    productImages: [...input.productImages],
  };
}

function useTheme() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const savedDark = localStorage.getItem("ecomimggen_theme") === "dark";
    setDark(savedDark);
    document.documentElement.setAttribute("data-theme", savedDark ? "dark" : "light");
  }, []);

  const toggle = useCallback(() => {
    setDark((previous) => {
      const next = !previous;
      localStorage.setItem("ecomimggen_theme", next ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
      return next;
    });
  }, []);

  return { dark, toggle };
}

export default function ImageGenerator() {
  const { dark, toggle: toggleTheme } = useTheme();
  const [productName, setProductName] = useState("");
  const [sellingPoints, setSellingPoints] = useState("");
  const [imageCount, setImageCount] = useState(5);
  const [productImages, setProductImages] = useState<string[]>([]);
  const [size, setSize] = useState<ImageSize>("1024x1536");
  const [prompts, setPrompts] = useState<DetailPromptItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeHistoryIdx, setActiveHistoryIdx] = useState(-1);
  const [activePromptIdx, setActivePromptIdx] = useState(0);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [authPopoverOpen, setAuthPopoverOpen] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const authPopoverRef = useRef<HTMLDivElement | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  const currentProduct: ProductInput = {
    name: productName.trim(),
    sellingPoints: sellingPoints.trim(),
    imageCount,
    productImages,
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as DraftState;
      setProductName(draft.productName || "");
      setSellingPoints(draft.sellingPoints || "");
      setImageCount(Number.isFinite(draft.imageCount) ? draft.imageCount : 5);
      setProductImages(Array.isArray(draft.productImages) ? draft.productImages : []);
      setPrompts(Array.isArray(draft.prompts) ? draft.prompts : []);
    } catch {
      // Ignore invalid local draft.
    }
  }, []);

  useEffect(() => {
    try {
      const draft: DraftState = {
        productName,
        sellingPoints,
        imageCount,
        productImages,
        prompts,
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Ignore storage failures.
    }
  }, [productName, sellingPoints, imageCount, productImages, prompts]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = (await dbAll()) ?? [];
        if (cancelled) return;
        setHistory(items);
        if (items.length) setActiveHistoryIdx(items.length - 1);
      } catch (event) {
        console.warn("IndexedDB 读取失败:", event);
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
    } catch (event) {
      console.warn("IndexedDB 写入失败:", event);
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
        accepted.push(await fileToDataURL(file));
      } catch (event) {
        console.warn("读取图片失败:", event);
      }
    }
    if (accepted.length) {
      setProductImages((previous) => [...previous, ...accepted].slice(0, 8));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

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
      setError("请至少上传一张产品图片。");
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
        template: DETAIL_PROMPT_TEMPLATE,
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
  }, [currentProduct, validateProduct]);

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
    let historyItem: HistoryItem = {
      product: cloneProduct(currentProduct),
      prompts: prompts.map((item) => ({ ...item, status: "draft", base64: undefined })),
      timestamp: Date.now(),
    };

    try {
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
        setActivePromptIdx(index);
        working = working.map((item, itemIndex) =>
          itemIndex === index
            ? { ...item, status: "queued", error: undefined, updatedAt: Date.now() }
            : item,
        );
        historyItem = { ...historyItem, prompts: working };
        setPrompts(working);
        await persistHistory(historyItem);

        const task = await createImageTask({
          prompt: working[index].prompt,
          size,
          inputImages: productImages,
        });
        if (Number.isFinite(task.remainingCredits)) {
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

        const result = await pollImageTask(task.taskId);
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

        working = working.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                status: "succeeded",
                base64: result.base64,
                model: result.model,
                updatedAt: Date.now(),
              }
            : item,
        );
        historyItem = { ...historyItem, prompts: working };
        setPrompts(working);
        setHistory((previous) =>
          previous.map((item) => (item.id === historyItem.id ? historyItem : item)),
        );
        await persistHistory(historyItem);
      }
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => undefined);
        wakeLockRef.current = null;
      }
      setImageBusy(false);
    }
  }, [currentProduct, persistHistory, productImages, prompts, size, validateProduct]);

  const handleSelectHistory = useCallback(
    (idx: number) => {
      const item = history[idx];
      if (!item) return;
      setActiveHistoryIdx(idx);
      setProductName(item.product.name);
      setSellingPoints(item.product.sellingPoints);
      setImageCount(item.product.imageCount);
      setProductImages(item.product.productImages);
      setPrompts(item.prompts);
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

  const handleDownload = useCallback(
    (index: number) => {
      const item = prompts[index];
      if (!item?.base64) return;
      const anchor = document.createElement("a");
      anchor.href = "data:image/png;base64," + item.base64;
      anchor.download = `ecom-detail-${productName || "product"}-${index + 1}.png`;
      anchor.click();
    },
    [productName, prompts],
  );

  const authenticated = !!session?.authenticated;
  const authLabel = authenticated
    ? `${session?.user?.name || "已登录用户"} 账户菜单`
    : "打开登录菜单";
  const controlsDisabled = sessionLoading || accessBusy || promptBusy || imageBusy || !authenticated;
  const providerLabel =
    session?.user?.provider === "github"
      ? "GitHub"
      : session?.user?.provider === "google"
        ? "Google"
        : "访问码";
  const creditLabel = authenticated
    ? `${session?.user?.remainingCredits ?? 0} 次可用`
    : "未登录";
  const isAdmin =
    session?.user?.role === "admin" || session?.user?.role === "super_admin";

  return (
    <main className="app-shell">
      <header className="studio-topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="brand" />
          </span>
          <div>
            <h1>EcomImgGen</h1>
            <p className="tagline">商品详情图生产台</p>
          </div>
        </div>

        <div className="run-status" aria-label="当前任务状态">
          <span>{prompts.length ? `${prompts.length} 条文案` : "文案未生成"}</span>
          <span>{productImages.length ? `${productImages.length} 张参考图` : "未上传参考图"}</span>
          <span>{creditLabel}</span>
          <span>{imageBusy ? "生成中" : "待命"}</span>
        </div>

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
              {authenticated && session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={session.user.image} alt={session.user.name} className="auth-toggle-avatar" />
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
                      {session.user.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={session.user.image} alt={session.user.name} className="auth-avatar" />
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
                      <span>剩余 {session.user.remainingCredits ?? 0}</span>
                      <span>已用 {session.user.usedCredits ?? 0}</span>
                    </div>
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
                    <a className="btn-ghost auth-link auth-popover-link" href="/api/auth/logout?redirectTo=/">
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
                    <a className="btn-ghost auth-link auth-popover-link" href="/api/auth/login/github?redirectTo=/">
                      使用 GitHub 登录
                    </a>
                    <a className="btn-ghost auth-link auth-popover-link" href="/api/auth/login/google?redirectTo=/">
                      使用 Google 登录
                    </a>
                  </>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
            title={dark ? "切换到浅色模式" : "切换到深色模式"}
          >
            <Icon name={dark ? "sun" : "moon"} />
          </button>
        </div>
      </header>

      <div className="studio-grid">
        <aside className="studio-panel input-rail">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Input</span>
              <h2>用户输入</h2>
            </div>
            <span className="panel-count">{imageCount} 张</span>
          </div>

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

            <div>
              <label htmlFor="image-count">张数</label>
              <input
                id="image-count"
                type="number"
                min={1}
                max={10}
                value={imageCount}
                disabled={controlsDisabled}
                onChange={(event) =>
                  setImageCount(Math.min(10, Math.max(1, Number(event.target.value) || 1)))
                }
              />
            </div>
          </div>

          <label htmlFor="selling-points">卖点和功效</label>
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
                onClick={() => setProductImages([])}
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
                  onClick={() => setProductImages((previous) => previous.filter((_, i) => i !== index))}
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
            <div>
              <label>图片尺寸</label>
              <div className="param-controls" aria-label="图片尺寸">
                <SizeSelector value={size} onChange={setSize} />
              </div>
            </div>
          </div>

          <div className="action-stack">
            <button
              type="button"
              className="btn-primary"
              disabled={controlsDisabled}
              onClick={handleGeneratePrompts}
            >
              {promptBusy ? "正在生成文案..." : "生成详情图文案"}
            </button>
          </div>

          {error && <div className="alert">{error}</div>}
        </aside>

        <aside className="studio-panel prompt-rail">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Copy</span>
              <h2>详情图文案</h2>
            </div>
            <span className="panel-count">{prompts.length} 条</span>
          </div>
          <div className="prompt-editor-list">
            {prompts.length === 0 ? (
              <div className="empty">生成详情图文案后可在这里逐条修改。</div>
            ) : (
              prompts.map((item, index) => (
                <div
                  key={item.id}
                  className={`prompt-editor${index === activePromptIdx ? " is-active" : ""}`}
                >
                  <div className="prompt-editor-head">
                    <button type="button" className="prompt-index" onClick={() => setActivePromptIdx(index)}>
                      {index + 1}
                    </button>
                    <input
                      aria-label={`详情图 ${index + 1} 标题`}
                      type="text"
                      value={item.title}
                      disabled={imageBusy}
                      onChange={(event) => handleTitleChange(item.id, event.target.value)}
                    />
                    <span className={`status-pill is-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  </div>
                  <textarea
                    aria-label={`详情图 ${index + 1} 文案`}
                    value={item.prompt}
                    disabled={imageBusy}
                    onFocus={() => setActivePromptIdx(index)}
                    onChange={(event) => handlePromptChange(item.id, event.target.value)}
                  />
                </div>
              ))
            )}
          </div>
          <div className="prompt-action-bar">
            <button
              type="button"
              className="btn-secondary"
              disabled={controlsDisabled || !prompts.length}
              onClick={handleGenerateImages}
            >
              {imageBusy ? "正在逐张生成..." : "生成详情图"}
            </button>
          </div>
        </aside>

        <section className="studio-panel canvas-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Output</span>
              <h2>详情图展示</h2>
            </div>
            <span className="panel-count">{size.replace("x", "×")}</span>
          </div>
          <Stage
            prompts={prompts}
            activeIndex={activePromptIdx}
            busy={imageBusy}
            error={null}
            onSelect={setActivePromptIdx}
            onDownload={handleDownload}
            onZoom={(index) => {
              const item = prompts[index];
              if (item?.base64) setLightboxSrc("data:image/png;base64," + item.base64);
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

      <footer>
        EcomImgGen · 历史记录保存在当前浏览器 · GitHub
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
