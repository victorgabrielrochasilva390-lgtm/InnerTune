import React, { useEffect, useRef, useState } from "react";

const P: Record<string, string> = {
  play: "M7 4v16l13-8z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  prev: "M6 5h2v14H6zM20 5v14L9 12z",
  next: "M16 5h2v14h-2zM4 5v14l11-7z",
  stepBack: "M11 6v12l-8-6zM20 6v12l-8-6z",
  stepFwd: "M13 6v12l8-6zM4 6v12l8-6z",
  undo: "M9 7H5V3M5.5 7.5A8 8 0 1 1 4 14",
  redo: "M15 7h4V3M18.5 7.5A8 8 0 1 0 20 14",
  scissors: "M6 6a2.5 2.5 0 1 0 0 .01M6 18a2.5 2.5 0 1 0 0 .01M8 7.5 20 18M8 16.5 20 6",
  cursor: "M5 3l14 8-6 2-2 6z",
  magnet: "M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2",
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  text: "M5 5h14M12 5v14M9 19h6",
  wand: "M4 20 16 8M14 4v2M18 6h2M18 10v2M10 4h2",
  layers: "M12 3 2 8l10 5 10-5zM2 12l10 5 10-5M2 16l10 5 10-5",
  captions: "M3 5h18v14H3zM7 11h4M13 11h4M7 15h10",
  image: "M3 5h18v14H3zM8 10a1.5 1.5 0 1 0 0 .01M21 16l-5-5-8 8",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  palette: "M12 3a9 9 0 0 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 2-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5zM7.5 11.5a1 1 0 1 0 0 .01M10 7.5a1 1 0 1 0 0 .01M15 7.5a1 1 0 1 0 0 .01",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  export: "M12 3v12M7 8l5-5 5 5M5 14v6h14v-6",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h0",
  keyboard: "M3 7h18v10H3zM7 11h0M11 11h0M15 11h0M7 14h10",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 13l4 4L19 7",
  x: "M6 6l12 12M18 6 6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM5 11a7 7 0 0 0 14 0M12 18v3",
  split: "M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4",
  duplicate: "M8 8h12v12H8zM4 16V4h12",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  folder: "M3 6h6l2 2h10v11H3z",
  save: "M5 3h11l3 3v15H5zM8 3v5h8V3M8 21v-7h8v7",
  marker: "M6 3h12v13l-6 5-6-5z",
  zoomIn: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M8 11h6M11 8v6",
  zoomOut: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M8 11h6",
  grid: "M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof P | string; size?: number; className?: string }) {
  const filled = ["play", "pause", "prev", "next", "stepBack", "stepFwd", "cursor"].includes(name);
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={P[name] ?? P.help} />
    </svg>
  );
}

export function IconButton({ icon, label, onClick, active, disabled, kbd, size, className = "", tour }: { icon: string; label: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; disabled?: boolean; kbd?: string; size?: number; className?: string; tour?: string }) {
  return (
    <button className={`icon-btn ${active ? "active" : ""} ${className}`} onClick={onClick} disabled={disabled} data-tip={kbd ? `${label} (${kbd})` : label} aria-label={label} data-tour={tour}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Slider({ label, value, min, max, step = 0.01, onChange, format, help, disabled, reset }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; help?: string; disabled?: boolean; reset?: number }) {
  return (
    <label className={`slider ${disabled ? "disabled" : ""}`} data-tip={help}>
      <span className="slider-label" onDoubleClick={() => reset !== undefined && onChange(reset)}>
        {label}
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => reset !== undefined && onChange(reset)} />
      <NumberInput value={value} step={step} min={min} max={max} onChange={onChange} format={format} disabled={disabled} />
    </label>
  );
}

export function NumberInput({ value, onChange, step = 0.1, min, max, format, disabled, width }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; format?: (v: number) => string; disabled?: boolean; width?: number }) {
  const [txt, setTxt] = useState<string | null>(null);
  const shown = txt ?? (format ? format(value) : String(Math.round(value * 1000) / 1000));
  return (
    <input
      className="num"
      style={width ? { width } : undefined}
      value={shown}
      disabled={disabled}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        // lenient parse: accepts "1.5", "+0.25 EV", "-3 dB", "2x"
        const v = txt === null ? NaN : parseFloat(txt.replace(/[^0-9eE+\-.]/g, ""));
        if (txt !== null && isFinite(v)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v)));
        setTxt(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const v = value + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1);
          onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v)));
          setTxt(null);
        }
        e.stopPropagation();
      }}
    />
  );
}

export function Toggle({ label, checked, onChange, help, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: string; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? "disabled" : ""}`} data-tip={help}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track">
        <span className="knob" />
      </span>
      <span>{label}</span>
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange, help }: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; help?: string }) {
  return (
    <label className="select" data-tip={help}>
      {label && <span className="slider-label">{label}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} onKeyDown={(e) => e.stopPropagation()}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Section({ title, children, defaultOpen = true, right, adv }: { title: string; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode; adv?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${open ? "open" : ""} ${adv ? "adv" : ""}`}>
      <div className="section-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="section-title">{title}</span>
        <span className="section-right" onClick={(e) => e.stopPropagation()}>
          {right}
        </span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-input">
      <span className="slider-label">{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <code>{value}</code>
    </label>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress" title={label}>
      <div className="bar" style={{ width: `${Math.round(value * 100)}%` }} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Global tooltip that reads data-tip attributes. */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const timer = useRef<number>();
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null;
      window.clearTimeout(timer.current);
      if (!el || !el.dataset.tip) return setTip(null);
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        setTip({ text: el.dataset.tip!, x: r.left + r.width / 2, y: r.bottom + 6 });
      }, 450);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      setTip(null);
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mousedown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousedown", hide);
    };
  }, []);
  if (!tip) return null;
  const left = Math.min(window.innerWidth - 160, Math.max(8, tip.x));
  const top = tip.y > window.innerHeight - 40 ? tip.y - 50 : tip.y;
  return (
    <div className="tooltip" style={{ left, top }}>
      {tip.text}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
