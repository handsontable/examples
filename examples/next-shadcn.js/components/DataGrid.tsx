"use client";
import { useRef, useEffect, memo } from "react";
import { useSearchParams } from "next/navigation";
import { HotTable, HotColumn, HotTableRef } from "@handsontable/react-wrapper";
import { registerTheme } from "handsontable/themes";
import { registerAllModules } from "handsontable/registry";

import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';

import { colorsShadcn } from "@/lib/theme/colorsShadcn";
import { iconsShadcn } from "@/lib/theme/iconsShadcn";
import { data, config } from "@/lib/helpers";

registerAllModules();

const shadcnDataGridTheme = registerTheme('shadcn-data-grid', {
  icons: iconsShadcn,
  colors: colorsShadcn,
  tokens: tokensHorizon,
}).params({
  tokens: {
    wrapperBorderRadius: "var(--radius)",
  },
})

function DataGrid({ ref }: { ref: React.RefObject<HotTableRef | null> }) {
  return (<HotTable
    ref={ref}
    theme={shadcnDataGridTheme}
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
      correctFormat={true}
      dateFormat="MMM DD, YYYY"
      width={180}
    />
    <HotColumn
      data="lastLoginTime"
      type="time"
      className="htRight"
      correctFormat={true}
      timeFormat="HH:mm"
      width={180}
    />
  </HotTable>);
}

const MemoizedDataGrid = memo(DataGrid);

function DataGridWrapper() {
  const hotTableRef = useRef<HotTableRef>(null);
  const searchParams = useSearchParams();

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

  return (
    <MemoizedDataGrid ref={hotTableRef} />
  );
}

export default DataGridWrapper;
