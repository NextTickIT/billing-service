import type { RouteRecordRaw } from 'vue-router';

export const paymentsRoutes: RouteRecordRaw[] = [
  {
    path: 'payments',
    component: () => import('./PaymentsPage.vue'),
  },
  {
    path: 'payments/:id',
    component: () => import('./PaymentDetailPage.vue'),
  },
];
