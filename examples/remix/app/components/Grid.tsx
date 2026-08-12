import {
  AutoColumnSize,
  Autofill,
  ContextMenu,
  CopyPaste,
  DropdownMenu,
  Filters,
  HiddenRows,
  registerPlugin,
} from "handsontable/plugins";

import {
  CheckboxCellType,
  NumericCellType,
  registerCellType,
} from "handsontable/cellTypes";
import { HotTable, HotColumn } from "@handsontable/react-wrapper";
import { getTheme, hasTheme, registerTheme, mainTheme } from "handsontable/themes";

import { Data } from "../../app/data";

// Handsontable 17.0.0 passes a plain theme-config object straight to
// ThemeManager.update on the updateSettings path (normalization was added in
// 17.1.0), so this branch hands over a registered ThemeBuilder instead.
const dataGridTheme = hasTheme("main") ? getTheme("main") : registerTheme(mainTheme);

registerCellType(CheckboxCellType);
registerCellType(NumericCellType);

registerPlugin(AutoColumnSize);
registerPlugin(Autofill);
registerPlugin(ContextMenu);
registerPlugin(CopyPaste);
registerPlugin(DropdownMenu);
registerPlugin(Filters);
registerPlugin(HiddenRows);

type GridProps = {
  data: Data;
};

export default function Grid(props: GridProps) {
  return (
    <div>
      <HotTable
        theme={dataGridTheme}
        data={props.data}
        colWidths={[140, 126, 192, 100, 100, 90, 90, 110, 97]}
        colHeaders={[
          "Company name1",
          "Country",
          "Name",
          "Sell date",
          "Order ID",
          "In stock",
          "Qty",
          "Progress",
          "Rating",
        ]}
        dropdownMenu={true}
        contextMenu={true}
        filters={true}
        rowHeaders={true}
        manualRowMove={true}
        navigableHeaders={true}
        autoWrapRow={true}
        autoWrapCol={true}
        height={363}
        imeFastEdit={true}
        licenseKey="non-commercial-and-evaluation"
      >
        <HotColumn data={1} />
        <HotColumn data={2} />
        <HotColumn data={3} />
        <HotColumn data={4} />
        <HotColumn data={5} />
        <HotColumn data={6} type="checkbox" className="htCenter" />
        <HotColumn data={7} type="numeric" />
        <HotColumn data={8} readOnly={true} className="htMiddle" />
        <HotColumn data={9} readOnly={true} className="htCenter" />
      </HotTable>
    </div>
  );
}
