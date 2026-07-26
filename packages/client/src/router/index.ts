import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/pages/LoginPage.vue'),
    },
    {
      path: '/admin',
      name: 'WorkflowList',
      component: () => import('@/pages/WorkflowListPage.vue'),
    },
    {
      path: '/admin/workflow/new',
      name: 'WorkflowNew',
      component: () => import('@/pages/WorkflowEditPage.vue'),
    },
    {
      path: '/admin/workflow/:id',
      name: 'WorkflowDetail',
      component: () => import('@/pages/WorkflowDetailPage.vue'),
    },
    {
      path: '/admin/workflow/:id/edit',
      name: 'WorkflowEdit',
      component: () => import('@/pages/WorkflowEditPage.vue'),
    },
    {
      path: '/admin/settings',
      name: 'Settings',
      component: () => import('@/pages/SettingsPage.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/admin',
    },
  ],
});

router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (to.name !== 'Login' && !token) {
    return { name: 'Login' };
  }
});

export { router };
