import type { AspectRatio, ImageQuality, ImageSize } from "./types";

export const IMAGE_QUALITY_OPTIONS: Array<{ label: string; value: ImageQuality }> = [
  { label: "1K", value: "1K" },
  { label: "2K", value: "2K" },
  { label: "4K", value: "4K" },
];

export function resolveImageSize(aspectRatio: AspectRatio): ImageSize {
  if (aspectRatio === "auto") return "auto";
  if (aspectRatio === "1:1") return "1024x1024";
  if (aspectRatio === "4:3" || aspectRatio === "16:9") return "1536x1024";
  return "1024x1536";
}
