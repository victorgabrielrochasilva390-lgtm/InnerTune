// Licensed stock media search. Every result carries source + licence information that is
// stored on the imported MediaItem and shown in the UI.
//  - Openverse: free, no key. Creative Commons images and audio (licence varies per item!)
//  - Pexels:    free API key (PEXELS_API_KEY). Videos + photos under the Pexels licence.
//  - Pixabay:   free API key (PIXABAY_API_KEY). Videos + images under the Pixabay content licence.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DIRS } from "./config";
import { uid } from "../shared/defaults";
import type { MediaSourceInfo } from "../shared/types";

export interface StockResult {
  id: string;
  provider: "openverse" | "pexels" | "pixabay";
  type: "video" | "photo" | "audio";
  title: string;
  thumb: string;
  downloadUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  author?: string;
  license: string;
  licenseUrl?: string;
  pageUrl?: string;
}

export function stockProviders() {
  return [
    { id: "openverse", label: "Openverse (CC images & audio)", available: true, note: "Free, no key. Each item has its own Creative Commons licence. Check attribution and NC/ND terms." },
    { id: "pexels", label: "Pexels (video + photo)", available: !!process.env.PEXELS_API_KEY, note: "Free API key: set PEXELS_API_KEY. Pexels licence: free to use, attribution appreciated." },
    { id: "pixabay", label: "Pixabay (video + image)", available: !!process.env.PIXABAY_API_KEY, note: "Free API key: set PIXABAY_API_KEY. Pixabay content licence." },
  ];
}

export async function searchStock(provider: string, q: string, type: "video" | "photo" | "audio", orientation?: "landscape" | "portrait" | "square"): Promise<StockResult[]> {
  if (provider === "openverse") return openverse(q, type === "audio" ? "audio" : "images");
  if (provider === "pexels") return pexels(q, type, orientation);
  if (provider === "pixabay") return pixabay(q, type, orientation);
  throw new Error(`Unknown stock provider ${provider}`);
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "CutwiseStudio/0.1", ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json() as Promise<any>;
}

async function openverse(q: string, kind: "images" | "audio"): Promise<StockResult[]> {
  const j = await getJson(`https://api.openverse.org/v1/${kind}/?q=${encodeURIComponent(q)}&page_size=24&mature=false`);
  return (j.results ?? []).map((r: any) => ({
    id: r.id,
    provider: "openverse",
    type: kind === "audio" ? "audio" : "photo",
    title: r.title ?? q,
    thumb: r.thumbnail ?? r.url,
    downloadUrl: r.url,
    width: r.width,
    height: r.height,
    duration: r.duration ? r.duration / 1000 : undefined,
    author: r.creator,
    license: `CC ${String(r.license ?? "").toUpperCase()} ${r.license_version ?? ""}`.trim(),
    licenseUrl: r.license_url,
    pageUrl: r.foreign_landing_url,
  }));
}

async function pexels(q: string, type: string, orientation?: string): Promise<StockResult[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("PEXELS_API_KEY is not set");
  const o = orientation ? `&orientation=${orientation}` : "";
  if (type === "video") {
    const j = await getJson(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=24${o}`, { Authorization: key });
    return (j.videos ?? []).map((v: any) => {
      const files = (v.video_files ?? []).filter((f: any) => f.file_type === "video/mp4").sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0));
      const best = files.find((f: any) => (f.height ?? 0) <= 1920 && (f.width ?? 0) <= 1920) ?? files[0];
      return { id: String(v.id), provider: "pexels", type: "video", title: v.url?.split("/").filter(Boolean).pop() ?? q, thumb: v.image, downloadUrl: best?.link, width: best?.width, height: best?.height, duration: v.duration, author: v.user?.name, license: "Pexels License", licenseUrl: "https://www.pexels.com/license/", pageUrl: v.url };
    });
  }
  const j = await getJson(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=24${o}`, { Authorization: key });
  return (j.photos ?? []).map((p: any) => ({ id: String(p.id), provider: "pexels", type: "photo", title: p.alt || q, thumb: p.src?.medium, downloadUrl: p.src?.large2x ?? p.src?.original, width: p.width, height: p.height, author: p.photographer, license: "Pexels License", licenseUrl: "https://www.pexels.com/license/", pageUrl: p.url }));
}

async function pixabay(q: string, type: string, orientation?: string): Promise<StockResult[]> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) throw new Error("PIXABAY_API_KEY is not set");
  const o = orientation === "portrait" ? "&orientation=vertical" : orientation === "landscape" ? "&orientation=horizontal" : "";
  if (type === "video") {
    const j = await getJson(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(q)}&per_page=24&safesearch=true`);
    return (j.hits ?? []).map((v: any) => {
      const f = v.videos?.large?.url ? v.videos.large : v.videos?.medium;
      return { id: String(v.id), provider: "pixabay", type: "video", title: v.tags ?? q, thumb: v.videos?.tiny?.thumbnail ?? f?.thumbnail ?? "", downloadUrl: f?.url, width: f?.width, height: f?.height, duration: v.duration, author: v.user, license: "Pixabay Content License", licenseUrl: "https://pixabay.com/service/license-summary/", pageUrl: v.pageURL };
    });
  }
  const j = await getJson(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(q)}&per_page=24&safesearch=true&image_type=photo${o}`);
  return (j.hits ?? []).map((p: any) => ({ id: String(p.id), provider: "pixabay", type: "photo", title: p.tags ?? q, thumb: p.webformatURL, downloadUrl: p.largeImageURL, width: p.imageWidth, height: p.imageHeight, author: p.user, license: "Pixabay Content License", licenseUrl: "https://pixabay.com/service/license-summary/", pageUrl: p.pageURL }));
}

/** Download a stock item to a temporary file and return path + licence metadata. */
export async function downloadStock(r: StockResult, signal?: AbortSignal): Promise<{ file: string; name: string; source: MediaSourceInfo }> {
  const url = new URL(r.downloadUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid download url");
  const res = await fetch(url, { signal, headers: { "User-Agent": "CutwiseStudio/0.1" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const ct = res.headers.get("content-type") ?? "";
  const ext = path.extname(url.pathname).slice(0, 6) || (ct.includes("mp4") ? ".mp4" : ct.includes("png") ? ".png" : ct.includes("mpeg") ? ".mp3" : ct.includes("jpeg") ? ".jpg" : ".bin");
  const file = path.join(DIRS.tmp, `${uid("stk")}${ext}`);
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(file));
  return {
    file,
    name: `${r.provider}-${r.title}`.replace(/[^\w.\- ]+/g, "").slice(0, 60) + ext,
    source: { provider: r.provider, url: r.pageUrl ?? r.downloadUrl, author: r.author, license: r.license, licenseUrl: r.licenseUrl, title: r.title },
  };
}
