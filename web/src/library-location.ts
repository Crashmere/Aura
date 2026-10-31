export type LibraryLocation = {
  view: string;
  album: string;
  query: string;
  from: string;
  to: string;
  asset: string;
  hideAlbums?: boolean;
};

const views = new Set(["all", "albums", "live", "videos", "grouped", "similar", "trash", "jobs"]);
const date = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";

export function readLocation(): LibraryLocation {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") || "all";
  return {
    view: views.has(view) ? view : "all",
    album: view === "albums" ? params.get("album") || "" : "",
    query: params.get("q") || "",
    from: date(params.get("from")),
    to: date(params.get("to")),
    asset: params.get("asset") || "",
    hideAlbums: params.has("unfiled") ? params.get("unfiled") === "1" : undefined,
  };
}

export function writeLocation(state: LibraryLocation, mode: "push" | "replace") {
  const params = new URLSearchParams();
  if (state.view !== "all") params.set("view", state.view);
  if (state.view === "albums" && state.album) params.set("album", state.album);
  if (state.query) params.set("q", state.query);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  if (state.asset) params.set("asset", state.asset);
  params.set("unfiled", state.hideAlbums ? "1" : "0");
  const search = params.toString();
  const url = `/aura/${search ? "?" + search : ""}`;
  if (location.pathname + location.search !== url) {
    if (mode === "push") history.pushState(state.asset ? { auraViewer: true } : null, "", url);
    else history.replaceState(state.asset ? history.state : null, "", url);
  }
}

export function monthRange(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) return { from: "", to: "" };
  const [year, value] = month.split("-").map(Number);
  const last = new Date(year, value, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${last}` };
}
