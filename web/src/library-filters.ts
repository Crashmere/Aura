export const filterKeys = [
  "kind", "format", "orientation", "status", "location", "versions", "albumState",
  "camera", "lens", "minSize", "maxSize", "minMP", "maxMP", "addedFrom", "addedTo",
] as const;

export type FilterKey = typeof filterKeys[number];
export type PhotoFilters = Record<FilterKey, string>;
export type FilterDraft = PhotoFilters & { from: string; to: string };
export const emptyFilters = (): PhotoFilters => Object.fromEntries(filterKeys.map(key => [key, ""])) as PhotoFilters;

export const filterOptions = {
  kind: [["photo", "照片"], ["live", "实况照片"], ["video", "视频"]],
  format: [["jpeg", "JPEG"], ["heic", "HEIC / HEIF"], ["png", "PNG"], ["gif", "GIF"], ["webp", "WebP"], ["tiff", "TIFF"], ["raw", "RAW"], ["avif", "AVIF"], ["mov", "MOV"], ["mp4", "MP4"]],
  orientation: [["landscape", "横向"], ["portrait", "纵向"], ["square", "正方形"], ["panorama", "宽幅（至少 2:1）"]],
  status: [["ready", "预览已就绪"], ["queued", "等待处理"], ["processing", "正在处理"], ["error", "处理失败"]],
  location: [["with", "有定位"], ["without", "无定位"]],
  versions: [["single", "单个照片版本"], ["multiple", "多个照片版本"]],
  albumState: [["in", "已加入相片集"], ["none", "未加入相片集"]],
} as const;

export function readFilters(params: URLSearchParams): PhotoFilters {
  const filters = emptyFilters();
  for (const key of filterKeys) filters[key] = params.get(key) || "";
  return filters;
}

export function filterParams(filters: PhotoFilters): Record<string, string> {
  return Object.fromEntries(filterKeys.filter(key => filters[key]).map(key => [key, filters[key]]));
}

export function filterChips(filters: PhotoFilters): { keys: FilterKey[]; text: string }[] {
  const result: { keys: FilterKey[]; text: string }[] = [];
  for (const key of Object.keys(filterOptions) as (keyof typeof filterOptions)[]) {
    const option = filterOptions[key].find(([value]) => value === filters[key]);
    if (filters[key]) result.push({ keys: [key], text: option?.[1] || filters[key] });
  }
  for (const [key, label] of [["camera", "相机"], ["lens", "镜头"]] as const) {
    if (filters[key]) result.push({ keys: [key], text: `${label} · ${filters[key]}` });
  }
  for (const [low, high, label, unit, divisor] of [
    ["minSize", "maxSize", "原件", "MB", 1048576],
    ["minMP", "maxMP", "像素", "MP", 1],
  ] as const) {
    const format = (value: string) => String(Number((Number(value) / divisor).toFixed(2)));
    if (filters[low] || filters[high]) {
      const range = filters[low] && filters[high] ? `${format(filters[low])}–${format(filters[high])}` : filters[low] ? `≥ ${format(filters[low])}` : `≤ ${format(filters[high])}`;
      result.push({ keys: [low, high], text: `${label} ${range} ${unit}` });
    }
  }
  if (filters.addedFrom || filters.addedTo) result.push({ keys: ["addedFrom", "addedTo"], text: `导入 ${filters.addedFrom || "不限"} — ${filters.addedTo || "不限"}` });
  return result;
}
