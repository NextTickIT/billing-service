<script setup lang="ts">
interface Column {
  key: string;
  label: string;
}

interface Props {
  columns: Column[];
  rows: Record<string, unknown>[];
}

defineProps<Props>();
</script>

<template>
  <div class="table-wrap">
    <table class="base-table">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col.key">{{ col.label }}</th>
        </tr>
      </thead>
      <tbody>
        <slot name="rows" :rows="rows">
          <tr v-for="(row, i) in rows" :key="i">
            <td v-for="col in columns" :key="col.key">
              {{ row[col.key] }}
            </td>
          </tr>
        </slot>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
}

.base-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.base-table th {
  padding: 6px 10px;
  text-align: left;
  color: var(--dim);
  border-bottom: 1px solid var(--line);
  font-weight: 500;
  white-space: nowrap;
}

.base-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--txt);
}

.base-table tbody tr:hover {
  background: var(--panel-2);
}
</style>
