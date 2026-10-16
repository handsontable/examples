/**
 * Handsontable theme icons using Lucide (shadcn) icon set.
 * SVGs use currentColor so they follow shadcn theme. Keys must match VALID_ICON_KEYS.
 */
const lucideAttrs =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function icon(svgContent: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg ${lucideAttrs}>${svgContent}</svg>`)}`;
}

// Lucide: ChevronRight, ChevronLeft, ChevronDown, ChevronUp, ChevronsRight, ChevronsLeft, Check, Menu, Plus, Minus, Circle (filled for radio), X, Search
export const iconsShadcn = {
  arrowRight: icon('<path d="m9 18 6-6-6-6"/>'),
  arrowRightWithBar: icon('<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>'),
  arrowLeft: icon('<path d="m15 18-6-6 6-6"/>'),
  arrowLeftWithBar: icon('<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>'),
  arrowDown: icon('<path d="m6 9 6 6 6-6"/>'),
  menu: icon('<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>'),
  selectArrow: icon('<path d="m6 9 6 6 6-6"/>'),
  arrowNarrowUp: icon('<path d="m18 15-6-6-6 6"/>'),
  arrowNarrowDown: icon('<path d="m6 9 6 6 6-6"/>'),
  check: icon('<g transform="translate(3,3) scale(0.75)"><path d="M20 6 9 17l-5-5"/></g>'),
  checkbox: icon('<g transform="translate(3,3) scale(0.75)"><path d="M20 6 9 17l-5-5"/></g>'),
  caretHiddenLeft: icon('<path d="m15 18-6-6 6-6"/>'),
  caretHiddenRight: icon('<path d="m9 18 6-6-6-6"/>'),
  caretHiddenUp: icon('<path d="m18 15-6-6-6 6"/>'),
  caretHiddenDown: icon('<path d="m6 9 6 6 6-6"/>'),
  collapseOff: icon('<path d="M5 12h14"/>'),
  collapseOn: icon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  radio: icon('<circle cx="12" cy="12" r="6" fill="currentColor"/>'),
  chipClose: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  search: icon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
} as const;
