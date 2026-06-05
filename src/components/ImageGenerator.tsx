"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import HistoryGrid from "./HistoryGrid";
import Lightbox from "./Lightbox";
import SizeSelector from "./SizeSelector";
import Stage from "./Stage";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DRAFT_KEY = "ecomimggen_draft";
type WakeLockSentinelLike = { release: () => Promise<void> };

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
  const [promptBusy, setPromptBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
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
      setError("请先生成商品详情图 Prompt。");
      return;
    }
    if (prompts.some((item) => !item.prompt.trim())) {
      setError("Prompt 不能为空，请检查后再生成。");
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
  const controlsDisabled = sessionLoading || promptBusy || imageBusy || !authenticated;

  return (
    <main className="app-shell">
      <header className="studio-topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">E</span>
          <div>
            <h1>EcomImgGen</h1>
            <p className="tagline">电商详情图生成工作台</p>
          </div>
        </div>

        <div className="run-status" aria-label="当前任务状态">
          <span>{prompts.length ? `${prompts.length} 条 Prompt` : "Prompt 未生成"}</span>
          <span>{productImages.length ? `${productImages.length} 张参考图` : "未上传参考图"}</span>
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
                <span className="auth-toggle-icon" aria-hidden="true">U</span>
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
                          {session.user.provider === "github" ? "GitHub" : "Google"}
                          {session.user.email ? ` · ${session.user.email}` : ""}
                        </p>
                      </div>
                    </div>
                    <p className="auth-popover-note">已登录，可使用内置生成配置。</p>
                    <a className="btn-ghost auth-link auth-popover-link" href="/api/auth/logout?redirectTo=/">
                      退出登录
                    </a>
                  </>
                ) : (
                  <>
                    <p className="auth-popover-note">登录后才能生成 Prompt 和商品详情图。</p>
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
            {dark ? "L" : "D"}
          </button>
        </div>
      </header>

      {!sessionLoading && !authenticated && (
        <section className="access-banner">
          <div>
            <h2>登录后使用生成能力</h2>
            <p>当前可预览工作台结构；Prompt 生成和图片生成需要登录后调用服务端配置。</p>
          </div>
          <div className="login-actions">
            <a className="btn-primary auth-link" href="/api/auth/login/github?redirectTo=/">GitHub 登录</a>
            <a className="btn-ghost auth-link" href="/api/auth/login/google?redirectTo=/">Google 登录</a>
          </div>
        </section>
      )}

      <div className="studio-grid">
        <aside className="studio-panel input-rail">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Input</span>
              <h2>产品资料</h2>
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
            placeholder="主要卖点、功效、适用人群、规格信息、购买理由..."
            onChange={(event) => setSellingPoints(event.target.value)}
          />

          <div className="field-row-head">
            <label>产品参考图</label>
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
                  x
                </button>
              </div>
            ))}
            <button
              type="button"
              className="prompt-upload-tile"
              disabled={controlsDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              上传
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
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
              {promptBusy ? "正在生成 Prompt..." : "生成 Prompt"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={controlsDisabled || !prompts.length}
              onClick={handleGenerateImages}
            >
              {imageBusy ? "正在逐张生成..." : "生成详情图"}
            </button>
          </div>

          {error && <div className="alert">{error}</div>}
        </aside>

        <section className="studio-panel canvas-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Canvas</span>
              <h2>详情图预览</h2>
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

        <aside className="studio-panel prompt-rail">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Queue</span>
              <h2>Prompt 队列</h2>
            </div>
            <span className="panel-count">{prompts.length} 条</span>
          </div>
          <div className="prompt-editor-list">
            {prompts.length === 0 ? (
              <div className="empty">生成 Prompt 后可在这里逐条修改。</div>
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
                      type="text"
                      value={item.title}
                      disabled={imageBusy}
                      onChange={(event) => handleTitleChange(item.id, event.target.value)}
                    />
                    <span className={`status-pill is-${item.status}`}>{item.status}</span>
                  </div>
                  <textarea
                    value={item.prompt}
                    disabled={imageBusy}
                    onFocus={() => setActivePromptIdx(index)}
                    onChange={(event) => handlePromptChange(item.id, event.target.value)}
                  />
                </div>
              ))
            )}
          </div>
        </aside>
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
    </main>
  );
}
