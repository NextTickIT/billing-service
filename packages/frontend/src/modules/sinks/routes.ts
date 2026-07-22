import type { RouteRecordRaw } from 'vue-router';

export const sinksRoutes: RouteRecordRaw[] = [
  {
    path: 'sinks',
    component: () => import('./SinksPage.vue'),
  },
];
