"use client";

import { ASPECT_RATIO_OPTIONS } from "@/lib/imageOptions";
import type { AspectRatio } from "@/lib/types";
import SegmentedControl from "./SegmentedControl";

export default function AspectRatioSelector({
  value,
  onChange,
  disabled,
}: {
  value: AspectRatio;
  onChange: (value: AspectRatio) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      ariaLabel="画面比例"
      value={value}
      options={ASPECT_RATIO_OPTIONS}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
