// UI icons: tabler-icons, per sticky `11:2545` (DEV-2155 / ADR-0024).
//
// Every icon here was read off a Figma layer name in section `18.1` or in the
// later "After Login" section (`114:23287`) — the layers are literally called
// `tabler-icon-<name>` — except:
//   * `IconLayoutSidebarLeftCollapse` / `IconChevronRight`, the toggled
//     counterparts of designed icons (no frame shows a collapsed state)
//   * `IconSun` / `IconMoon`, which appear in no Figma layer at all. They come
//     from T0, which inlined them by hand and handed them here by name.
//     Don't "correct" them against a frame — no frame specifies them.
//
// The last five come from the After Login frames (DEV-2163 / T9):
//   `tabler-icon-list-details`  — account menu + My Demos nav (`114:21794`)
//   `tabler-icon-settings-2`    — same, Settings row (`114:21799`)
//   `tabler-icon-login-2`       — same, Log out row (`114:21804`). The design
//                                 really does use `login-2`, not `logout`.
//   `tabler-icon-dots-vertical` — the demo card's kebab (`114:26977`)
//   `tabler-icon-share`         — heads the preview bar's right icon group in
//                                 `114:21146` / `114:23289` / `114:24410`
//                                 (DEV-2167 / T10, audit finding A3)
//   `IconCopy`                  — the copy affordance inside each field of the
//                                 share dialog (`114:23289`). Read off the
//                                 rendered glyph, not a layer name: the dialog's
//                                 button is an unnamed frame.
//
// The wrapper exists to pin the design's 16px/2px rendering (tabler defaults to
// 24px) and to mark icons `aria-hidden` — labels live on the enclosing button.
// Both are overridable via props.

import {
  IconBook as TablerBook,
  IconBrandGithub as TablerBrandGithub,
  IconBrandReactNative as TablerBrandReactNative,
  IconChevronDown as TablerChevronDown,
  IconChevronRight as TablerChevronRight,
  IconCopy as TablerCopy,
  IconDotsVertical as TablerDotsVertical,
  IconDownload as TablerDownload,
  IconExternalLink as TablerExternalLink,
  IconFolderPlus as TablerFolderPlus,
  IconLayoutSidebarLeftCollapse as TablerLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand as TablerLayoutSidebarLeftExpand,
  IconListDetails as TablerListDetails,
  IconLogin2 as TablerLogin2,
  IconMoon as TablerMoon,
  IconPencil as TablerPencil,
  IconPlus as TablerPlus,
  IconRefresh as TablerRefresh,
  IconSearch as TablerSearch,
  IconSettings2 as TablerSettings2,
  IconShare as TablerShare,
  IconSun as TablerSun,
  IconTrashX as TablerTrashX,
  IconWindowMaximize as TablerWindowMaximize,
  IconWindowMinimize as TablerWindowMinimize,
  IconX as TablerX,
  type IconProps,
  type TablerIcon,
} from "@tabler/icons-react";

/** Every frame in `18.1` draws UI icons at 16px. */
export const UI_ICON_SIZE = 16;

/** Tabler's own default, restated so a future upstream change can't shift the design. */
export const UI_ICON_STROKE = 2;

function ui(displayName: string, Base: TablerIcon) {
  function Wrapped(props: IconProps) {
    return <Base size={UI_ICON_SIZE} stroke={UI_ICON_STROKE} aria-hidden="true" {...props} />;
  }
  Wrapped.displayName = displayName;
  return Wrapped;
}

export const IconBook = ui("IconBook", TablerBook);
export const IconBrandGithub = ui("IconBrandGithub", TablerBrandGithub);
export const IconBrandReactNative = ui("IconBrandReactNative", TablerBrandReactNative);
export const IconChevronDown = ui("IconChevronDown", TablerChevronDown);
export const IconChevronRight = ui("IconChevronRight", TablerChevronRight);
export const IconCopy = ui("IconCopy", TablerCopy);
export const IconDotsVertical = ui("IconDotsVertical", TablerDotsVertical);
export const IconDownload = ui("IconDownload", TablerDownload);
export const IconExternalLink = ui("IconExternalLink", TablerExternalLink);
export const IconFolderPlus = ui("IconFolderPlus", TablerFolderPlus);
export const IconLayoutSidebarLeftCollapse = ui(
  "IconLayoutSidebarLeftCollapse",
  TablerLayoutSidebarLeftCollapse,
);
export const IconLayoutSidebarLeftExpand = ui(
  "IconLayoutSidebarLeftExpand",
  TablerLayoutSidebarLeftExpand,
);
export const IconListDetails = ui("IconListDetails", TablerListDetails);
export const IconLogin2 = ui("IconLogin2", TablerLogin2);
export const IconMoon = ui("IconMoon", TablerMoon);
export const IconPencil = ui("IconPencil", TablerPencil);
export const IconPlus = ui("IconPlus", TablerPlus);
export const IconRefresh = ui("IconRefresh", TablerRefresh);
export const IconSearch = ui("IconSearch", TablerSearch);
export const IconSettings2 = ui("IconSettings2", TablerSettings2);
export const IconShare = ui("IconShare", TablerShare);
export const IconSun = ui("IconSun", TablerSun);
export const IconTrashX = ui("IconTrashX", TablerTrashX);
export const IconWindowMaximize = ui("IconWindowMaximize", TablerWindowMaximize);
export const IconWindowMinimize = ui("IconWindowMinimize", TablerWindowMinimize);
export const IconX = ui("IconX", TablerX);

export type { IconProps };
