export interface UpdateState {
  state: "off" | "none" | "available" | "downloading" | "ready" | "error";
  current: string;
  version?: string;
  reason?: string;
}

export type UpdateAction = "download" | "apply";

export interface Banner {
  text: string;
  action: UpdateAction | null;
  label: string | null;
}

export function bannerFor(update: UpdateState | null): Banner | null {
  const version = update?.version ?? "";
  switch (update?.state) {
    case "available":
      return { text: `Update ${version} available`, action: "download", label: "Download" };
    case "downloading":
      return { text: `Downloading update ${version}`, action: null, label: null };
    case "ready":
      return { text: `Update ${version} is ready`, action: "apply", label: "Restart to update" };
    case "error":
      return { text: `Update failed: ${update.reason ?? "unknown"}`, action: null, label: null };
    default:
      return null;
  }
}
