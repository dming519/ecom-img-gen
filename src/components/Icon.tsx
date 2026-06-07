"use client";

type IconName =
  | "brand"
  | "user"
  | "upload"
  | "image"
  | "download"
  | "zoom"
  | "close"
  | "trash"
  | "spark"
  | "queue"
  | "warning"
  | "text"
  | "video"
  | "cutout"
  | "brush"
  | "eraser"
  | "undo";

interface IconProps {
  name: IconName;
  className?: string;
}

const paths: Record<IconName, string[]> = {
  brand: [
    "M6 5.5h12v4H10v3h7v4h-7v3h8v4H6z",
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
  ],
  user: [
    "M20 21a8 8 0 0 0-16 0",
    "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  ],
  upload: [
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "M17 8l-5-5-5 5",
    "M12 3v12",
  ],
  image: [
    "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    "M21 16l-5-5L5 22",
  ],
  download: [
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "M7 10l5 5 5-5",
    "M12 15V3",
  ],
  zoom: [
    "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    "M21 21l-4.35-4.35",
    "M11 8v6M8 11h6",
  ],
  close: ["M18 6L6 18", "M6 6l12 12"],
  trash: [
    "M3 6h18",
    "M8 6V4h8v2",
    "M19 6l-1 15H6L5 6",
    "M10 11v6M14 11v6",
  ],
  spark: [
    "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z",
    "M19 15l.8 2.7L22 18.5l-2.2.8L19 22l-.8-2.7-2.2-.8 2.2-.8z",
  ],
  queue: ["M7 7h14", "M7 12h14", "M7 17h14", "M3 7h.01", "M3 12h.01", "M3 17h.01"],
  warning: [
    "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    "M12 9v4",
    "M12 17h.01",
  ],
  text: ["M4 6h16", "M8 6v12", "M16 6v12", "M7 18h4", "M13 18h4"],
  cutout: [
    "M7 4h10",
    "M7 20h10",
    "M4 7v10",
    "M20 7v10",
    "M9 9h6v6H9z",
    "M5 5l4 4",
    "M15 15l4 4",
  ],
  brush: [
    "M18.5 3.5l2 2L9 17l-4 1 1-4z",
    "M14 8l2 2",
    "M5 21c3 0 5-1.5 5-4",
  ],
  eraser: [
    "M20 20H9",
    "M3.5 14.5l8-8a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3L10 20H7.5l-4-4z",
    "M8 10l6 6",
  ],
  undo: [
    "M9 7H4v5",
    "M4 7l5 5",
    "M5 17a8 8 0 1 0 2-8",
  ],
  video: [
    "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
    "M16 10l6-3v10l-6-3",
  ],
};

export default function Icon({ name, className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {paths[name].map((d, index) => (
        <path d={d} key={`${name}-${index}`} />
      ))}
    </svg>
  );
}
