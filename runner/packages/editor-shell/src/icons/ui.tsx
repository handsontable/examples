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
//                                 (DEV-2167 / T10, ADR-0025 §1)
//   `IconCopy`                  — the copy affordance inside each field of the
//                                 share dialog (`114:23289`). Read off the
//                                 rendered glyph, not a layer name: the dialog's
//                                 button is an unnamed frame.
//
// And one that appears in no frame at all, added when master's `/admin` panel
// (DEV-2030) merged into the redesigned chrome:
//   `IconChartBar`              — the account menu's `Usage` row. The panel is an
//                                 internal tool the design never covered; the row
//                                 exists because the pre-redesign bar had a loose
//                                 `Usage` link that would otherwise have no home.
//
// And four that appear in no frame either, added by DEV-2209 when the Ask AI and
// Style drawers were brought onto the design system:
//   `IconSparkles`     — the `Ask AI` trigger, replacing a `✨`
//   `IconPalette`      — the `Style` trigger, replacing a `🎨`
//   `IconChevronLeft`  — the style panel's "back to all components" row
//   `IconChevronUp`    — the collapsed counterpart of an open inline popover
// Both features postdate the frames, so there is nothing to read them off. The
// emoji they replace could not follow the theme: a glyph renders in the OS's own
// colour and weight, which no token reaches — it was the one thing on the top bar
// that stayed light while the bar went dark.
//
// And one from the same section, added by DEV-2169 / T12:
//   `IconCircleFilled`          — the unsaved-changes dot on a tab (`114:26604`,
//                                 ADR-0025 §3). The layer is named
//                                 `tabler-icon-circle`, but it *renders* filled,
//                                 and an outline ring reads as a radio button
//                                 rather than a modified marker. Filled is the
//                                 truthful import; the layer name is the slip.
//
// The wrapper exists to pin the design's 16px/2px rendering (tabler defaults to
// 24px) and to mark icons `aria-hidden` — labels live on the enclosing button.
// Both are overridable via props.

import {
  IconBook as TablerBook,
  IconBrandGithub as TablerBrandGithub,
  IconBrandReactNative as TablerBrandReactNative,
  IconArrowUp as TablerArrowUp,
  IconChartBar as TablerChartBar,
  IconChevronDown as TablerChevronDown,
  IconChevronLeft as TablerChevronLeft,
  IconChevronRight as TablerChevronRight,
  IconChevronUp as TablerChevronUp,
  IconCircleFilled as TablerCircleFilled,
  IconCopy as TablerCopy,
  IconDotsVertical as TablerDotsVertical,
  IconDownload as TablerDownload,
  IconExternalLink as TablerExternalLink,
  IconFolderPlus as TablerFolderPlus,
  IconInfoCircle as TablerInfoCircle,
  IconLayoutSidebarLeftCollapse as TablerLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand as TablerLayoutSidebarLeftExpand,
  IconListDetails as TablerListDetails,
  IconLogin2 as TablerLogin2,
  IconMoon as TablerMoon,
  IconPalette as TablerPalette,
  IconPencil as TablerPencil,
  IconPlus as TablerPlus,
  IconRefresh as TablerRefresh,
  IconSearch as TablerSearch,
  IconSettings2 as TablerSettings2,
  IconShare as TablerShare,
  IconSparkles as TablerSparkles,
  IconSun as TablerSun,
  IconTrashX as TablerTrashX,
  IconUsers as TablerUsers,
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
// The chat composer's send glyph (DEV-2047 restyle) — the docs assistant sends
// with ↑, and the two assistants should read as one product.
export const IconArrowUp = ui("IconArrowUp", TablerArrowUp);
export const IconChartBar = ui("IconChartBar", TablerChartBar);
export const IconChevronDown = ui("IconChevronDown", TablerChevronDown);
export const IconChevronLeft = ui("IconChevronLeft", TablerChevronLeft);
export const IconChevronRight = ui("IconChevronRight", TablerChevronRight);
export const IconChevronUp = ui("IconChevronUp", TablerChevronUp);
export const IconCircleFilled = ui("IconCircleFilled", TablerCircleFilled);
export const IconCopy = ui("IconCopy", TablerCopy);
export const IconDotsVertical = ui("IconDotsVertical", TablerDotsVertical);
export const IconDownload = ui("IconDownload", TablerDownload);
export const IconExternalLink = ui("IconExternalLink", TablerExternalLink);
export const IconFolderPlus = ui("IconFolderPlus", TablerFolderPlus);
// The Style panel's per-token info mark (Theme Builder's row treatment): the
// token description moved off the row into a tooltip behind this.
export const IconInfoCircle = ui("IconInfoCircle", TablerInfoCircle);
export const IconLayoutSidebarLeftCollapse = ui(
  "IconLayoutSidebarLeftCollapse",
  TablerLayoutSidebarLeftCollapse,
);
export const IconLayoutSidebarLeftExpand = ui(
  "IconLayoutSidebarLeftExpand",
  TablerLayoutSidebarLeftExpand,
);
export const IconListDetails = ui("IconListDetails", TablerListDetails);
// `tabler-icon-users` — the All demos nav row (DEV-2506). In no frame: the team
// listing postdates the After Login section, and this row is its only surface.
export const IconUsers = ui("IconUsers", TablerUsers);
export const IconLogin2 = ui("IconLogin2", TablerLogin2);
export const IconMoon = ui("IconMoon", TablerMoon);
export const IconPalette = ui("IconPalette", TablerPalette);
export const IconPencil = ui("IconPencil", TablerPencil);
export const IconPlus = ui("IconPlus", TablerPlus);
export const IconRefresh = ui("IconRefresh", TablerRefresh);
export const IconSearch = ui("IconSearch", TablerSearch);
export const IconSettings2 = ui("IconSettings2", TablerSettings2);
export const IconShare = ui("IconShare", TablerShare);
export const IconSparkles = ui("IconSparkles", TablerSparkles);
export const IconSun = ui("IconSun", TablerSun);
export const IconTrashX = ui("IconTrashX", TablerTrashX);
export const IconWindowMaximize = ui("IconWindowMaximize", TablerWindowMaximize);
export const IconWindowMinimize = ui("IconWindowMinimize", TablerWindowMinimize);
export const IconX = ui("IconX", TablerX);

export type { IconProps };
