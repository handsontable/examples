// @ts-nocheck
// The `handsontable/themes` imports below only resolve on Handsontable >= 17;
// on 15/16 the bundler redirects them to hotThemesCompat.ts (see
// next.config.ts), but the `next build` type check knows nothing about that
// alias, so type checking is disabled for this file to survive builds on
// those majors.
import { getTheme, hasTheme, registerTheme } from "handsontable/themes";
import tokensHorizon from "handsontable/themes/static/variables/tokens/horizon";

import { colorsShadcn } from "@/lib/theme/colorsShadcn";
import { iconsShadcn } from "@/lib/theme/iconsShadcn";

const THEME_NAME = "shadcn-data-grid";

export function buildShadcnTheme() {
  if (hasTheme(THEME_NAME)) {
    return getTheme(THEME_NAME);
  }

  return registerTheme(THEME_NAME, {
    icons: iconsShadcn,
    colors: colorsShadcn,
    tokens: tokensHorizon,
  })
    .params({
      tokens: {
        borderRadius: "var(--radius)",
      },
    })
    .setColorScheme("light");
}
