"use client";

import { useEffect } from "react";
interface LightboxProps {
  src?: string | null;
  alt?: string;
  onClose: () => void;
}

export default function Lightbox({ src, alt = "Preview", onClose }: LightboxProps) {
  const imageSrc = src ?? null;

  useEffect(() => {
    if (!imageSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [imageSrc, onClose]);

  if (!imageSrc) return null;

  return (
    <div
      className="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        className="lightbox-x"
        type="button"
        aria-label="关闭"
        onClick={onClose}
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageSrc} alt={alt} />
    </div>
  );
}
