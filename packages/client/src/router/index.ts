import { createRouter, createWebHistory } from 'vue-router';
import { authEnabled } from '@/api/auth-status';

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
      path: '/admin/tasks',
      name: 'TaskList',
      component: () => import('@/pages/TaskListPage.vue'),
    },
    {
      path: '/admin/settings',
      name: 'Settings',
      component: () => import('@/pages/SettingsPage.vue'),
    },
    {
      path: '/admin/tags',
      name: 'Tags',
      component: () => import('@/pages/TagManagementPage.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/admin',
    },
  ],
});

router.beforeEach((to) => {
  // If auth status is still loading or auth is disabled, allow access
  if (authEnabled.value === null || authEnabled.value === false) {
    return;
  }

  const token = localStorage.getItem('token');
  if (to.name !== 'Login' && !token) {
    return { name: 'Login' };
  }
});

export { router };
