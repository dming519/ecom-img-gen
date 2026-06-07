import type { AspectRatio, ImageQuality, ImageSize } from "./types";

export const ASPECT_RATIO_OPTIONS: Array<{ label: string; value: AspectRatio }> = [
  { label: "Auto", value: "auto" },
  { label: "1:1", value: "1:1" },
  { label: "4:3", value: "4:3" },
  { label: "3:4", value: "3:4" },
  { label: "16:9", value: "16:9" },
  { label: "9:16", value: "9:16" },
];

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
