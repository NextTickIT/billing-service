import { createRouter, createWebHistory } from 'vue-router';
import { checkoutRoutes } from '@/modules/checkout/routes.js';
import { operatorRoutes } from '@/modules/session/routes.js';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    ...checkoutRoutes,
    ...operatorRoutes,
    { path: '/', redirect: '/operator/login' },
  ],
});
