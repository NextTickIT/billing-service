import type { RouteRecordRaw } from 'vue-router';

export const checkoutRoutes: RouteRecordRaw[] = [
  {
    path: '/checkout/:id',
    component: () => import('./CheckoutPage.vue'),
  },
  {
    path: '/checkout/:id/return',
    component: () => import('./CheckoutReturnPage.vue'),
  },
];
