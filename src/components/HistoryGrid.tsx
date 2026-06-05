"use client";

import type { HistoryItem } from "@/lib/types";
import Icon from "./Icon";

interface HistoryGridProps {
  history: HistoryItem[];
  activeIdx: number;
  onSelect: (idx: number) => void;
  onDelete: (idx: number) => void;
  onClearAll: () => void;
}

const TIME_FMT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export default function HistoryGrid({
  history,
  activeIdx,
  onSelect,
  onDelete,
  onClearAll,
}: HistoryGridProps) {
  return (
    <>
      <div className="history-bar">
        <h2>
          生成历史
          <span className="history-badge">{history.length} 组</span>
        </h2>
        <button className="btn-danger" type="button" onClick={onClearAll}>
          <Icon name="trash" />
          <span>清空</span>
        </button>
      </div>
      <div className="history-grid">
        {history.length === 0 ? (
          <div className="empty">还没有商品详情图历史</div>
        ) : (
          history
            .map((item, idx) => ({ item, idx }))
            .reverse()
            .map(({ item, idx }) => {
              const cover = item.prompts.find((prompt) => prompt.base64);
              const done = item.prompts.filter((prompt) => prompt.base64).length;
              const time = new Date(item.timestamp).toLocaleString("zh-CN", TIME_FMT);
              return (
                <div
                  key={item.id ?? `history-${idx}-${item.timestamp}`}
                  className={"tile" + (idx === activeIdx ? " is-active" : "")}
                  onClick={() => onSelect(idx)}
                >
                  <span className="tile-no">{done}/{item.prompts.length}</span>
                  {cover?.base64 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={"data:image/png;base64," + cover.base64} alt={item.product.name} />
                  ) : (
                    <div className="tile-empty">{item.product.name.slice(0, 8)}</div>
                  )}
                  <div className="tile-foot">
                    <span title={item.product.name}>{time}</span>
                    <button
                      className="tile-del"
                      type="button"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(idx);
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              );
            })
        )}
      </div>
    </>
  );
}
