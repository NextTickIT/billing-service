import type { RouteRecordRaw } from 'vue-router';
import { isAuthed } from './store.js';

const guard = (): string | true => {
  if (isAuthed()) return true;
  return '/operator/login';
};

export const operatorRoutes: RouteRecordRaw[] = [
  {
    path: '/operator/login',
    component: () => import('./LoginPage.vue'),
  },
  {
    path: '/operator',
    component: () => import('./OperatorLayout.vue'),
    redirect: '/operator/payments',
    beforeEnter: guard,
    children: [
      {
        path: 'payments',
        component: () => import('../payments/PaymentsPage.vue'),
        beforeEnter: guard,
      },
      {
        path: 'payments/:id',
        component: () => import('../payments/PaymentDetailPage.vue'),
        beforeEnter: guard,
      },
      {
        path: 'quarantine',
        component: () => import('../quarantine/QuarantinePage.vue'),
        beforeEnter: guard,
      },
    ],
  },
];
