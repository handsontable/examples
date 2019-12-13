<template>
  <div>
    <hot-table :data="data" :settings="settings"/>
    <div>{{debugInfo}}</div>
  </div>
</template>

<script>
import "handsontable/dist/handsontable.full.css";
import { HotTable } from "@handsontable/vue";
import Handsontable from "handsontable";
import Vue from "vue";

function getDebugInfo() {
  let debug = "Handsontable:";
  debug += ` v${Handsontable.version}`;
  debug += ` (${Handsontable.buildDate})`;
  debug += " Wrapper:";
  debug += ` v${HotTable.version}`;
  debug += " Vue:";
  debug += ` v${Vue.version}`;
  return debug;
}

export default {
  name: "App",
  data: function() {
    return {
      data: Handsontable.helper.createSpreadsheetData(50, 25),
      settings: {
        colHeaders: true,
        rowHeaders: true,
        width: 600,
        height: 500,
        licenseKey: "non-commercial-and-evaluation"
      },
      debugInfo: getDebugInfo()
    };
  },
  components: {
    HotTable
  }
};
</script>

