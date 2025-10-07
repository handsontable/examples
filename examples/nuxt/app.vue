<template>
  <div>
    <ClientOnly fallback-tag="span" fallback="Loading...">
      <Grid :tableData="tableData" />
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { Grid } from '#components';
import { data } from './data';
import { computed } from 'vue';

const tableData = computed(() => {
  return data;
});
</script>

<style>
html,
body {
  padding: 0;
  margin: 0;
}
</style>
