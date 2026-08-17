import type { RouteRecordRaw } from 'vue-router';

export const quarantineRoutes: RouteRecordRaw[] = [
  {
    path: 'quarantine',
    component: () => import('./QuarantinePage.vue'),
  },
];
