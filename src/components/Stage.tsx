"use client";

import type { DetailPromptItem } from "@/lib/types";

interface StageProps {
  prompts: DetailPromptItem[];
  activeIndex: number;
  busy: boolean;
  error: string | null;
  onSelect: (index: number) => void;
  onDownload: (index: number) => void;
  onZoom: (index: number) => void;
}

export default function Stage({
  prompts,
  activeIndex,
  busy,
  error,
  onSelect,
  onDownload,
  onZoom,
}: StageProps) {
  const active = prompts[activeIndex] ?? null;

  if (!prompts.length) {
    return (
      <div className="stage">
        <div className="icon-large">▣</div>
        <div className="icon-hint">商品详情图将在这里逐张生成</div>
      </div>
    );
  }

  return (
    <div className="detail-stage">
      <div className="stage-main">
        {active?.base64 ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={"data:image/png;base64," + active.base64}
              alt={active.title}
              onClick={() => onZoom(activeIndex)}
            />
            <div className="stage-caption">{active.title}</div>
            <div className="stage-actions">
              <button className="btn-ghost" type="button" onClick={() => onDownload(activeIndex)}>
                下载
              </button>
              <button className="btn-ghost" type="button" onClick={() => onZoom(activeIndex)}>
                大图
              </button>
            </div>
          </>
        ) : (
          <div className="stage-placeholder">
            {busy || active?.status === "running" || active?.status === "queued" ? (
              <>
                <div className="spinner" />
                <div className="loading-hint">正在生成：{active?.title}</div>
              </>
            ) : active?.status === "failed" ? (
              <>
                <div className="icon-large">!</div>
                <div className="alert">{active.error || "生成失败"}</div>
              </>
            ) : (
              <>
                <div className="icon-large">▥</div>
                <div className="icon-hint">等待生成：{active?.title}</div>
              </>
            )}
          </div>
        )}
      </div>

      {error && <div className="alert stage-error">{error}</div>}

      <div className="result-strip" aria-label="详情图生成结果">
        {prompts.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={`result-thumb${index === activeIndex ? " is-active" : ""}`}
            onClick={() => onSelect(index)}
          >
            <span className={`status-dot is-${item.status}`} />
            {item.base64 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={"data:image/png;base64," + item.base64} alt={item.title} />
            ) : (
              <span className="result-thumb-empty">{index + 1}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
