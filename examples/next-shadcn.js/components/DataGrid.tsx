"use client";
import { useRef, useEffect, useState, memo, forwardRef } from "react";
import { useSearchParams } from "next/navigation";
import { HotTable, HotColumn, HotTableRef } from "@handsontable/react-wrapper";
import Handsontable from "handsontable";
import { registerAllModules } from "handsontable/registry";

import { data, config } from "@/lib/helpers";

registerAllModules();

// Handsontable's JS themes API (`handsontable/themes`) exists only from major 17
// (on 15/16 the subpath is missing from the package `exports` map, so importing
// it is a compile-time module-not-found). Gate on the runtime version and only
// load the module that touches the themes API when it exists; on 15/16 fall
// back to the CSS-based horizon theme, which every supported major ships.
type HotThemeProps = { theme: unknown } | { themeName: string };

const HOT_MAJOR = Number(String(Handsontable.version).split(".")[0]);

async function buildHotThemeProps(): Promise<HotThemeProps> {
  if (HOT_MAJOR >= 17) {
    const { buildShadcnTheme } = await import("@/lib/theme/hotThemeModern");
    return { theme: buildShadcnTheme() };
  }

  await Promise.all([
    import("handsontable/styles/handsontable.min.css"),
    import("handsontable/styles/ht-theme-horizon.min.css"),
  ]);
  return { themeName: "ht-theme-horizon" };
}

const DataGrid = forwardRef<HotTableRef, { themeProps: HotThemeProps }>(function DataGrid({ themeProps }, ref) {
  return (<HotTable
    ref={ref}
    {...themeProps}
    data={data}
    {...config}
  >
    <HotColumn data="name" width={160} />
    <HotColumn data="age" type="numeric" width={100} />
    <HotColumn
      data="country"
      type="autocomplete"
      source={[
        "Germany",
        "China",
        "France",
        "Netherlands",
        "Switzerland",
        "USA",
        "Canada",
        "UK",
        "Australia",
        "Spain",
        "Japan",
        "Brazil",
        "South Korea",
        "Mexico",
      ]}
      strict={true}
      allowInvalid={true}
      width={160}
    />
    <HotColumn
      data="city"
      type="dropdown"
      source={[
        "Walldorf",
        "Shenzhen",
        "Lyon",
        "Amsterdam",
        "Zurich",
        "New York",
        "Toronto",
        "London",
        "Sydney",
        "Los Angeles",
        "Barcelona",
        "Tokyo",
        "Manchester",
        "Sao Paulo",
        "Miami",
        "Madrid",
        "Seoul",
        "Vancouver",
        "Valencia",
        "Chicago",
        "Mexico City",
        "Houston",
      ]}
      width={160}
    />
    <HotColumn
      data="isActive"
      type="checkbox"
      className="htCenter"
      width={120}
    />
    <HotColumn
      data="interest"
      type="dropdown"
      source={[
        "Electronics",
        "Fashion",
        "Tech Gadgets",
        "Home Decor",
        "Sports & Fitness",
        "Books & Literature",
        "Beauty & Personal Care",
        "Food & Cooking",
        "Travel & Adventure",
        "Art & Collectibles",
      ]}
      width={220}
    />
    <HotColumn data="favoriteProduct" width={220} />
    <HotColumn
      data="lastLoginDate"
      type="date"
      className="htRight"
      dateFormat={{ year: "numeric", month: "short", day: "2-digit" }}
      width={180}
    />
    <HotColumn
      data="lastLoginTime"
      type="time"
      className="htRight"
      timeFormat={{ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }}
      width={180}
    />
  </HotTable>);
});

const MemoizedDataGrid = memo(DataGrid);

function DataGridWrapper() {
  const hotTableRef = useRef<HotTableRef>(null);
  const searchParams = useSearchParams();
  const [themeProps, setThemeProps] = useState<HotThemeProps | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildHotThemeProps().then((props) => {
      if (!cancelled) setThemeProps(props);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const hot = hotTableRef.current?.hotInstance;
    const params = Object.fromEntries(searchParams.entries());

    if (hot) {
      const filtersPlugin = hot.getPlugin('filters');

      if (filtersPlugin) {
        filtersPlugin.clearConditions();

        if (params.q) filtersPlugin.addCondition(0, 'begins_with', [params.q]); // Name
        if (params.country) filtersPlugin.addCondition(2, 'contains', [params.country]); // Country
        if (params.status) filtersPlugin.addCondition(4, 'contains', [params.status === 'active' ? true : false]);  // Active
        
        filtersPlugin.filter();
        hot?.render();
      }
    }
  }, [searchParams]);

  if (!themeProps) {
    return null;
  }

  return (
    <MemoizedDataGrid ref={hotTableRef} themeProps={themeProps} />
  );
}

export default DataGridWrapper;
