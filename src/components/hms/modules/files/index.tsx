"use client";

// MOHD.HMS ENTERPRISE — Files module router (§3/§48).
//
// NAVIGATION ARCHITECTURE: the Files module is a main navigation destination
// routed by the existing hash router (ui-store pages["files"]):
//   []                       → Files dashboard (§5)
//   ["my"], ["my", folderId] → My Files browser (§6/§7)
//   ["file", fileId]         → File detail (§20)
//   ["upload"]               → dedicated Upload page (§19)
//   ["shared"]               → Shared With Me (§14)
//   ["shared-folders"]       → Shared Folders (§15)
//   ["sf", folderId]         → browse a shared folder tree
//   ["starred"]              → Starred (§23)
//   ["recent"]               → Recent (§24)
//   ["trash"]                → Trash (§17)
//   ["activity"]             → Activity (§25)
//   ["admin"]                → File Administration (§30/§35/§49) — RBAC-gated

import { useUi } from "@/lib/hms/ui-store";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS } from "@/lib/hms/constants";
import { FilesDashboard } from "./dashboard";
import { FilesBrowser } from "./browser";
import { FileDetailPage } from "./file-detail";
import { UploadPage } from "./upload-page";
import { SharedWithMe, SharedFolders, SharedFolderBrowser, StarredList, TrashList, RecentList, ActivityList } from "./lists";
import { FilesAdmin } from "./admin";

export function FilesModule() {
  const seg = useUi((s) => s.pages["files"]) ?? [];
  const { user } = useSession();
  const canAdmin = hasPerm(user, PERMISSIONS.files_manage_storage);

  const [head, second] = seg;
  if (head === "my") return <FilesBrowser folderId={second ?? null} />;
  if (head === "file" && second) return <FileDetailPage fileId={second} />;
  if (head === "upload") return <UploadPage initialFolderId={null} />;
  if (head === "shared") return <SharedWithMe />;
  if (head === "shared-folders") return <SharedFolders />;
  if (head === "sf" && second) return <SharedFolderBrowser folderId={second} />;
  if (head === "starred") return <StarredList />;
  if (head === "recent") return <RecentList />;
  if (head === "trash") return <TrashList />;
  if (head === "activity") return <ActivityList />;
  if (head === "admin") return canAdmin ? <FilesAdmin /> : <FilesDashboard />;
  return <FilesDashboard />;
}
