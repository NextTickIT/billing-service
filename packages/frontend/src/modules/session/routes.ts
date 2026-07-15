import type { RouteRecordRaw } from 'vue-router';

function hasCookie(): boolean {
  return document.cookie.includes('bss=');
}

const guard = async (): Promise<string | true> => {
  if (hasCookie()) return true;
  return '/operator/login';
};

export const operatorRoutes: RouteRecordRaw[] = [
  {
    path: '/operator/login',
    component: () => import('./LoginPage.vue'),
  },
  {
    path: '/operator',
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
