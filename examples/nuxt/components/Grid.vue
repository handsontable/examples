<template>
  <main>
    <div class="ht-theme-main">
      <hot-table :settings="hotSettings"></hot-table>
    </div>
  </main>
</template>
<script setup lang="ts">
import { defineProps, defineComponent } from 'vue';
import { HotTable } from '@handsontable/vue3';
import {
  AutoColumnSize,
  Autofill,
  ContextMenu,
  CopyPaste,
  DropdownMenu,
  Filters,
  HiddenRows,
  registerPlugin,
} from 'handsontable/plugins';
import {
  CheckboxCellType,
  NumericCellType,
  registerCellType,
} from 'handsontable/cellTypes';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';

registerCellType(CheckboxCellType);
registerCellType(NumericCellType);
registerPlugin(AutoColumnSize);
registerPlugin(Autofill);
registerPlugin(ContextMenu);
registerPlugin(CopyPaste);
registerPlugin(DropdownMenu);
registerPlugin(Filters);
registerPlugin(HiddenRows);

const props = defineProps(['tableData']);

const hotSettings = computed(() => {
  return {
    data: props.tableData,
    colWidths: [140, 126, 192, 100, 100, 90, 90, 110, 97],
    colHeaders: [
      'Company name',
      'Country',
      'Name',
      'Sell date',
      'Order ID',
      'In stock',
      'Qty',
      'Progress',
      'Rating',
    ],
    columns: [
      { type: 'text', data: 1 },
      { type: 'text', data: 2 },
      { type: 'text', data: 3 },
      { type: 'text', data: 4 },
      { type: 'text', data: 5 },
      { type: 'checkbox', data: 6, className: 'htCenter' },
      { type: 'numeric', data: 7 },
      { type: 'text', data: 8, readOnly: true, className: 'htMiddle' },
      { type: 'text', data: 9, readOnly: true, className: 'htCenter' },
    ],
    dropdownMenu: true,
    contextMenu: true,
    filters: true,
    rowHeaders: true,
    manualRowMove: true,
    navigableHeaders: true,
    autoWrapRow: true,
    autoWrapCol: true,
    height: 363,
    imeFastEdit: true,
    licenseKey: 'non-commercial-and-evaluation',
  };
});
</script>

<style>
main {
  padding: 16px;
  max-width: 1110px;
}
</style>
