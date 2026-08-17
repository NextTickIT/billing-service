<script setup lang="ts" generic="T">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import FilterableTh from './FilterableTh.vue';
import BaseSelect from './BaseSelect.vue';

// The one table both operator pages render through: a funnel-filtered first
// column, client-side paging, and the count/rows-per-page footer. Pages supply
// only their columns (#head) and cells (#row); everything else is shared here.
const PAGE_SIZE_OPTIONS = [
  { value: 10, label: '10' }, { value: 25, label: '25' },
  { value: 50, label: '50' }, { value: 100, label: '100' },
];

const props = defineProps<{
  items: readonly T[];
  filterLabel: string;
  filterMatch: (item: T, query: string) => boolean;
  rowKey: (item: T) => string;
  colspan: number;
  emptyText: string;
  clickable?: boolean;
}>();

const emit = defineEmits<{ rowClick: [item: T] }>();

const { t } = useI18n();

const filterText = ref('');
const page = ref(1);
const pageSize = ref(10);

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  return q ? props.items.filter((it) => props.filterMatch(it, q)) : props.items;
});
const pageCount = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / pageSize.value)),
);
const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filtered.value.slice(start, start + pageSize.value);
});

// Filtering or resizing the page can leave the cursor past the last page.
watch([filterText, pageSize], () => { page.value = 1; });

function prevPage(): void {
  if (page.value > 1) page.value -= 1;
}
function nextPage(): void {
  if (page.value < pageCount.value) page.value += 1;
}
function onRow(item: T): void {
  if (props.clickable) emit('rowClick', item);
}
</script>

<template>
  <div class="data-table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <FilterableTh v-model="filterText" :label="filterLabel" />
          <slot name="head" />
        </tr>
      </thead>
      <tbody>
        <tr v-if="filtered.length === 0" class="data-row--empty">
          <td :colspan="colspan">{{ emptyText }} {{ filterText }}</td>
        </tr>
        <tr
          v-for="item in paged"
          :key="rowKey(item)"
          :class="{ 'is-clickable': clickable }"
          :tabindex="clickable ? 0 : undefined"
          @click="onRow(item)"
          @keyup.enter="onRow(item)"
        >
          <slot name="row" :item="item" />
        </tr>
      </tbody>
    </table>

    <div class="table-foot">
      <span class="table-foot__count">
        {{ filtered.length }} / {{ items.length }}
      </span>
      <div class="table-foot__pager">
        <label class="pager-size">
          {{ t('common.rowsPerPage') }}
          <BaseSelect v-model="pageSize" :options="PAGE_SIZE_OPTIONS" />
        </label>
        <div class="pager-nav">
          <button
            type="button"
            class="pager-btn"
            :disabled="page <= 1"
            aria-label="Previous page"
            @click="prevPage"
          >
            ‹
          </button>
          <span class="pager-pos">{{ page }} / {{ pageCount }}</span>
          <button
            type="button"
            class="pager-btn"
            :disabled="page >= pageCount"
            aria-label="Next page"
            @click="nextPage"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.table-foot__count {
  color: var(--dim);
  font-family: var(--mono);
  font-size: 12px;
}
.table-foot__pager {
  display: flex;
  align-items: center;
  gap: 16px;
}
.pager-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dim);
  font-size: 12px;
  white-space: nowrap;
}
.pager-nav {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pager-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  transition: color 0.15s, border-color 0.15s;
}
.pager-btn:hover:not(:disabled) { color: var(--green); border-color: var(--green); }
.pager-btn:disabled { opacity: 0.4; cursor: default; }
.pager-pos {
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  min-width: 46px;
  text-align: center;
}
</style>
