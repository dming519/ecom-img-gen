"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export interface ParamOption {
  label: string;
  value: string;
}

interface ParamHoverSelectProps {
  title: string;
  value: string;
  options: ParamOption[];
  onChange: (value: string) => void;
  className?: string;
  children?: ReactNode;
  keepOpenOnSelect?: boolean;
}

export default function ParamHoverSelect({
  title,
  value,
  options,
  onChange,
  className,
  children,
  keepOpenOnSelect = false,
}: ParamHoverSelectProps) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && pickerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={pickerRef}
      className={`param-picker${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`param-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={titleId}
      >
        <span>{current.label}</span>
      </button>

      {open && (
        <div className="param-popover" id={titleId} role="group" aria-label={title}>
          <div className="param-popover-options" role="listbox" aria-label={title}>
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`param-popover-option${active ? " is-active" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    if (!keepOpenOnSelect) setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {active && (
                    <span className="param-option-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {children && <div className="param-popover-body">{children}</div>}
        </div>
      )}
    </div>
  );
}
