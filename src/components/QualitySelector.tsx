"use client";

import { IMAGE_QUALITY_OPTIONS } from "@/lib/imageOptions";
import type { ImageQuality } from "@/lib/types";
import SegmentedControl from "./SegmentedControl";

export default function QualitySelector({
  value,
  onChange,
  disabled,
}: {
  value: ImageQuality;
  onChange: (value: ImageQuality) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      ariaLabel="清晰度"
      value={value}
      options={IMAGE_QUALITY_OPTIONS}
      onChange={onChange}
      disabled={disabled}
      className="quality-segments"
    />
  );
}
